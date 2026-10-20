#!/usr/bin/env python3
"""External torrent audio tracks as HLS renditions for Lampa's browser player."""

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


TORRSERVER_BASE = os.environ.get("TORRSERVER_BASE", "http://gluetun-torrserver:8090").rstrip("/")
CACHE_DIR = os.environ.get("CACHE_DIR", "/cache")
CACHE_MAX_BYTES = int(os.environ.get("CACHE_MAX_MB", "1024")) * 1024 * 1024
CACHE_TTL_SECONDS = int(os.environ.get("CACHE_TTL_HOURS", "24")) * 3600
JOB_WAIT_SECONDS = float(os.environ.get("JOB_WAIT_SECONDS", "25"))
JOB_TIMEOUT_SECONDS = int(os.environ.get("JOB_TIMEOUT_SECONDS", "600"))
PROBE_TIMEOUT_SECONDS = int(os.environ.get("PROBE_TIMEOUT_SECONDS", "10"))
MAX_CANDIDATES = 6
MAX_JOBS = 2
MAX_PROBES_CACHED = 256

AUDIO_EXTENSIONS = {".mka", ".ac3", ".eac3", ".dts", ".aac", ".m4a", ".flac", ".mp3", ".opus", ".ogg"}
HASH_RE = re.compile(r"^[0-9a-f]{40}$")
FILE_RE = re.compile(r"^(?:audio\.m3u8|init\.mp4|s\d{1,6}\.m4s)$")
ROUTE_RE = re.compile(r"^/extaudio/([0-9a-fA-F]{40})/(\d{1,6})/(?:(tracks)|(\d{1,2})/([^/]+))$")
CONTENT_TYPES = {".m3u8": "application/vnd.apple.mpegurl", ".mp4": "audio/mp4", ".m4s": "video/iso.segment"}

_probe_cache = {}
_probe_lock = threading.Lock()
_jobs = {}
_jobs_lock = threading.Lock()
# One remux at a time keeps the shared Docker host responsive.
_job_slot = threading.Semaphore(1)


def stream_url(torrent_hash, file_id):
    query = urllib.parse.urlencode({"link": torrent_hash, "index": file_id, "play": ""})
    return f"{TORRSERVER_BASE}/stream/?{query}"


class Rejected(Exception):
    """A request for a file this service must not touch."""


def torrent_files(torrent_hash):
    # `get` never adds a torrent: TorrServer answers 404 for unknown hashes.
    body = json.dumps({"action": "get", "hash": torrent_hash}).encode("utf-8")
    request = urllib.request.Request(
        f"{TORRSERVER_BASE}/torrents", data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        torrent = json.loads(response.read().decode("utf-8"))
    return [
        {"id": item["id"], "path": item["path"]}
        for item in torrent.get("file_stats") or []
        if isinstance(item.get("id"), int) and isinstance(item.get("path"), str)
    ]


def split_name(path):
    directory, _, name = path.rpartition("/")
    stem, extension = os.path.splitext(name)
    return directory, stem, extension.lower()


def external_candidates(files, video_id):
    """Audio files named after the video, e.g. `Sound/<video stem>.mka`."""
    video = next((item for item in files if item["id"] == video_id), None)
    if not video:
        return []
    video_dir, video_stem, _ = split_name(video["path"])
    stem = video_stem.casefold()
    candidates = []
    for item in files:
        directory, candidate_stem, extension = split_name(item["path"])
        name = candidate_stem.casefold()
        if extension not in AUDIO_EXTENSIONS or not (name == stem or name.startswith(stem + ".")):
            continue
        if directory.startswith(video_dir + "/"):
            directory = directory[len(video_dir) + 1:]
        elif directory == video_dir:
            directory = ""
        suffix = candidate_stem[len(video_stem) + 1:] if name != stem else ""
        candidates.append({"id": item["id"], "location": " / ".join(part for part in (directory.replace("/", " / "), suffix) if part)})
    return sorted(candidates, key=lambda item: item["location"].casefold())[:MAX_CANDIDATES]


def require_audio_file(torrent_hash, file_id):
    # Never let a request make TorrServer fetch a video or an unknown torrent.
    try:
        files = torrent_files(torrent_hash)
    except urllib.error.HTTPError as error:
        error.close()
        raise Rejected("unknown torrent") from None
    if not any(item["id"] == file_id and split_name(item["path"])[2] in AUDIO_EXTENSIONS for item in files):
        raise Rejected("not an audio file of this torrent")


def probe_audio(torrent_hash, file_id):
    key = (torrent_hash, file_id)
    with _probe_lock:
        if key in _probe_cache:
            return _probe_cache[key]
    command = [
        "ffprobe", "-v", "error", "-select_streams", "a",
        "-show_entries", "stream=codec_name,channels:stream_tags=title,language",
        "-of", "json", stream_url(torrent_hash, file_id),
    ]
    result = subprocess.run(command, capture_output=True, timeout=PROBE_TIMEOUT_SECONDS, check=True)
    streams = json.loads(result.stdout.decode("utf-8")).get("streams") or []
    with _probe_lock:
        if len(_probe_cache) >= MAX_PROBES_CACHED:
            _probe_cache.clear()
        _probe_cache[key] = streams
    return streams


def external_tracks(torrent_hash, video_id):
    tracks = []
    for candidate in external_candidates(torrent_files(torrent_hash), video_id):
        try:
            streams = probe_audio(torrent_hash, candidate["id"])
        except (subprocess.SubprocessError, ValueError, OSError):
            continue
        for number, stream in enumerate(streams):
            tags = stream.get("tags") or {}
            title = (tags.get("title") or "").strip()
            tracks.append({
                "file": candidate["id"], "stream": number,
                "title": title or candidate["location"] or f"Audio {len(tracks) + 1}",
                "location": candidate["location"],
                "language": (tags.get("language") or "").strip(),
                "codec": stream.get("codec_name") or "",
                "channels": stream.get("channels") or 0,
            })
    return tracks


def remux_command(source, output, stream, codec, channels):
    audio = ["-c:a", "copy"] if codec == "aac" else [
        "-c:a", "aac", "-b:a", "384k" if channels > 2 else "192k",
    ]
    # -copyts keeps an intentional start delay; GST's video timeline starts at 0.
    return [
        "nice", "-n", "10", "ffmpeg", "-nostdin", "-v", "error", "-copyts", "-i", source,
        "-map", f"0:a:{stream}", "-vn", "-sn", "-dn", *audio,
        "-f", "hls", "-hls_time", "6", "-hls_playlist_type", "vod",
        "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
        "-hls_segment_filename", os.path.join(output, "s%d.m4s"),
        os.path.join(output, "audio.m3u8"),
    ]


def rendition_dir(torrent_hash, file_id, stream):
    return os.path.join(CACHE_DIR, f"{torrent_hash}-{file_id}-{stream}")


def run_job(torrent_hash, file_id, stream, job):
    final = rendition_dir(torrent_hash, file_id, stream)
    temporary = final + ".tmp"
    try:
        with _job_slot:
            if os.path.isfile(os.path.join(final, "audio.m3u8")):
                return
            streams = probe_audio(torrent_hash, file_id)
            if stream >= len(streams):
                raise ValueError("audio stream does not exist")
            shutil.rmtree(temporary, ignore_errors=True)
            os.makedirs(temporary)
            command = remux_command(
                stream_url(torrent_hash, file_id), temporary, stream,
                streams[stream].get("codec_name"), streams[stream].get("channels") or 0,
            )
            subprocess.run(command, capture_output=True, timeout=JOB_TIMEOUT_SECONDS, check=True)
            os.replace(temporary, final)
        evict(keep=final)
    except Exception as error:  # Reported to the waiting request; the next request retries.
        shutil.rmtree(temporary, ignore_errors=True)
        detail = error.stderr.decode("utf-8", "replace")[-500:] if getattr(error, "stderr", None) else ""
        print(f"remux {torrent_hash}/{file_id}/{stream} failed: {type(error).__name__} {detail}", file=sys.stderr, flush=True)
        job["error"] = "remux failed"
    finally:
        job["done"].set()
        with _jobs_lock:
            _jobs.pop((torrent_hash, file_id, stream), None)


def rendition_ready(torrent_hash, file_id, stream):
    final = rendition_dir(torrent_hash, file_id, stream)
    if not os.path.isfile(os.path.join(final, "audio.m3u8")):
        return False
    os.utime(final)
    return True


def ensure_rendition(torrent_hash, file_id, stream, wait):
    """Return (ready, error). Starts at most one job per rendition."""
    if rendition_ready(torrent_hash, file_id, stream):
        return True, None
    key = (torrent_hash, file_id, stream)
    with _jobs_lock:
        job = _jobs.get(key)
        if job is None and len(_jobs) >= MAX_JOBS:
            return False, "busy"
        if job is None:
            job = {"done": threading.Event(), "error": None}
            _jobs[key] = job
            threading.Thread(target=run_job, args=(torrent_hash, file_id, stream, job), daemon=True).start()
    if not job["done"].wait(wait):
        return False, None
    if job["error"]:
        return False, job["error"]
    return True, None


def evict(now=None, keep=None):
    now = now or time.time()
    entries = []
    for name in os.listdir(CACHE_DIR):
        path = os.path.join(CACHE_DIR, name)
        if name.endswith(".tmp") or path == keep or not os.path.isdir(path):
            continue
        size = sum(entry.stat().st_size for entry in os.scandir(path) if entry.is_file())
        entries.append((os.stat(path).st_mtime, size, path))
    total = sum(size for _, size, _ in entries)
    if keep and os.path.isdir(keep):
        total += sum(entry.stat().st_size for entry in os.scandir(keep) if entry.is_file())
    for modified, size, path in sorted(entries):
        if now - modified <= CACHE_TTL_SECONDS and total <= CACHE_MAX_BYTES:
            break
        shutil.rmtree(path, ignore_errors=True)
        total -= size


class Handler(BaseHTTPRequestHandler):
    server_version = "lampa-extaudio"

    def log_message(self, *args):
        pass

    def send_bytes(self, status, body, content_type, cache="no-store", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, payload, extra=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_bytes(status, body, "application/json; charset=utf-8", extra=extra)

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/extaudio/health":
            return self.send_json(200, {"ok": True})
        match = ROUTE_RE.match(path)
        if not match:
            return self.send_json(404, {"error": "not found"})
        torrent_hash, file_id = match.group(1).lower(), int(match.group(2))
        if not HASH_RE.match(torrent_hash):
            return self.send_json(404, {"error": "not found"})
        if match.group(3):
            try:
                return self.send_json(200, {"tracks": external_tracks(torrent_hash, file_id)})
            except urllib.error.HTTPError as error:
                error.close()
                return self.send_json(404 if error.code == 404 else 502, {"error": "track lookup failed"})
            except Exception:
                return self.send_json(502, {"error": "track lookup failed"})
        stream, name = int(match.group(4)), match.group(5)
        if not FILE_RE.match(name):
            return self.send_json(404, {"error": "not found"})
        if name != "audio.m3u8":
            # Segments never start work; only a prepared rendition serves them.
            if not rendition_ready(torrent_hash, file_id, stream):
                return self.send_json(404, {"error": "not found"})
        else:
            if not rendition_ready(torrent_hash, file_id, stream):
                try:
                    require_audio_file(torrent_hash, file_id)
                except Rejected:
                    return self.send_json(404, {"error": "not found"})
                except Exception:
                    return self.send_json(502, {"error": "track lookup failed"})
            ready, error = ensure_rendition(torrent_hash, file_id, stream, JOB_WAIT_SECONDS)
            if error == "busy":
                return self.send_json(429, {"error": "busy"}, {"Retry-After": "10"})
            if error:
                return self.send_json(502, {"error": error})
            if not ready:
                # The plugin polls until the whole rendition exists.
                return self.send_json(503, {"error": "preparing"}, {"Retry-After": "2"})
        file_path = os.path.join(rendition_dir(torrent_hash, file_id, stream), name)
        try:
            with open(file_path, "rb") as source:
                body = source.read()
        except FileNotFoundError:
            return self.send_json(404, {"error": "not found"})
        cache = "no-store" if name == "audio.m3u8" else "private, max-age=3600"
        self.send_bytes(200, body, CONTENT_TYPES[os.path.splitext(name)[1]], cache)


def main():
    os.makedirs(CACHE_DIR, exist_ok=True)
    for name in os.listdir(CACHE_DIR):
        if name.endswith(".tmp"):
            shutil.rmtree(os.path.join(CACHE_DIR, name), ignore_errors=True)
    evict()

    def evict_periodically():
        while True:
            time.sleep(3600)
            evict()

    threading.Thread(target=evict_periodically, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()


if __name__ == "__main__":
    main()
