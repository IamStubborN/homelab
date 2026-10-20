#!/usr/bin/env python3
"""External torrent audio tracks as HLS renditions for Lampa's browser player."""

import json
import math
import os
import re
import shutil
import signal
import struct
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
# A job gets this long plus the time to read the file at MIN_SOURCE_RATE.
JOB_BASE_SECONDS = int(os.environ.get("JOB_BASE_SECONDS", "300"))
JOB_MAX_SECONDS = int(os.environ.get("JOB_MAX_SECONDS", "14400"))
MIN_SOURCE_RATE = int(os.environ.get("MIN_SOURCE_KBPS", "256")) * 1024
# The plugin polls every ~30 s; a job nobody polls stops pulling the torrent.
ABANDON_SECONDS = int(os.environ.get("ABANDON_SECONDS", "120"))
PROBE_TIMEOUT_SECONDS = int(os.environ.get("PROBE_TIMEOUT_SECONDS", "10"))
PROBE_RETRY_SECONDS = 600
MAX_CANDIDATES = 6
MAX_JOBS = 2
MAX_TRACK_LOOKUPS = 2
MAX_PROBES_CACHED = 256

AUDIO_EXTENSIONS = {
    ".mka", ".webm", ".m4a", ".aac", ".ac3", ".eac3", ".ec3", ".dts", ".dtshd",
    ".thd", ".truehd", ".mlp", ".flac", ".mp3", ".mp2", ".mpa", ".opus", ".ogg", ".oga",
    ".wav", ".w64", ".wma", ".ape", ".wv", ".tta", ".aiff", ".aif", ".caf",
}
# Demuxers ffmpeg may pick by content. Playlist formats (HLS, concat) are left
# out so a crafted torrent file cannot make ffmpeg fetch other URLs.
INPUT_FORMATS = (
    "matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,ac3,eac3,dts,dtshd,truehd,mlp,aac,flac,mp3,"
    "ogg,wav,w64,asf,ape,wv,tta,caf,aiff"
)
INPUT_OPTIONS = ["-format_whitelist", INPUT_FORMATS, "-protocol_whitelist", "http,tcp"]
# Encoded renditions are produced on demand from the playback position, so a
# switch or a seek waits seconds instead of for the whole file. Segments are
# whole AAC frames on a fixed grid, so every encoder run lines up with others.
SAMPLE_RATE = 48000
SEGMENT_SAMPLES = 281 * 1024
SEGMENT_SECONDS = SEGMENT_SAMPLES / SAMPLE_RATE
LIVE_REACH = 5  # a request this close to the encoder waits instead of seeking
LIVE_AHEAD = int(os.environ.get("LIVE_AHEAD_SEGMENTS", "50"))  # pause ~5 min ahead
MAX_ACTIVE_RUNS = 2
MAX_RUNS = 4
STALE_SECONDS = 10  # an active run nobody asked for this long yields its slot
MAX_FAILURES = 3
FAILURE_RESET_SECONDS = 60
SEGMENT_RE = re.compile(r"^s(\d+)\.m4s$")
# Codecs the plugin may ask to copy when the browser can decode them in MSE.
COPY_CODECS = {"aac", "opus", "ac3", "eac3"}
FILE_RE = re.compile(r"^(?:audio\.m3u8|init\.mp4|s\d{1,6}\.m4s)$")
ROUTE_RE = re.compile(r"^/extaudio/([0-9a-fA-F]{40})/(\d{1,6})/(?:(tracks)|(\d{1,2})/(copy|aac)/([^/]+))$")
CONTENT_TYPES = {".m3u8": "application/vnd.apple.mpegurl", ".mp4": "audio/mp4", ".m4s": "video/iso.segment"}

_probe_cache = {}
_probe_failures = {}
_probe_lock = threading.Lock()
_track_lookups = threading.Semaphore(MAX_TRACK_LOOKUPS)
_jobs = {}
_jobs_lock = threading.Lock()
# One remux at a time keeps the shared Docker host responsive.
_job_slot = threading.Semaphore(1)
_live = {}
_live_changed = threading.Condition()


def stream_url(torrent_hash, file_id):
    query = urllib.parse.urlencode({"link": torrent_hash, "index": file_id, "play": ""})
    return f"{TORRSERVER_BASE}/stream/?{query}"


class Rejected(Exception):
    """A request for a file this service must not touch."""


class ProbeFailed(Exception):
    """A recent probe of this file failed; it is not retried yet."""


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
        {"id": item["id"], "path": item["path"], "length": item.get("length") or 0}
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
    """Return the file's size. Never let a request make TorrServer fetch a
    video or an unknown torrent."""
    try:
        files = torrent_files(torrent_hash)
    except urllib.error.HTTPError as error:
        error.close()
        raise Rejected("unknown torrent") from None
    for item in files:
        if item["id"] == file_id and split_name(item["path"])[2] in AUDIO_EXTENSIONS:
            return item.get("length", 0)
    raise Rejected("not an audio file of this torrent")


def job_timeout(length):
    return min(JOB_MAX_SECONDS, JOB_BASE_SECONDS + length // MIN_SOURCE_RATE)


def probe_audio(torrent_hash, file_id):
    key = (torrent_hash, file_id)
    with _probe_lock:
        if key in _probe_cache:
            return _probe_cache[key]
        if time.monotonic() - _probe_failures.get(key, -PROBE_RETRY_SECONDS) < PROBE_RETRY_SECONDS:
            raise ProbeFailed()
    command = [
        "ffprobe", "-v", "error", *INPUT_OPTIONS, "-select_streams", "a",
        "-show_entries", "stream=codec_name,channels,duration:stream_tags=title,language:format=duration",
        "-of", "json", stream_url(torrent_hash, file_id),
    ]
    try:
        result = subprocess.run(command, capture_output=True, timeout=PROBE_TIMEOUT_SECONDS, check=True)
        probe = json.loads(result.stdout.decode("utf-8"))
        streams = probe.get("streams") or []
        for item in streams:
            # Matroska reports the duration on the container only.
            item["duration"] = float(item.get("duration") or (probe.get("format") or {}).get("duration") or 0)
    except subprocess.TimeoutExpired:
        raise  # A torrent that is still connecting is worth asking again.
    except (subprocess.SubprocessError, ValueError, OSError):
        with _probe_lock:
            if len(_probe_failures) >= MAX_PROBES_CACHED:
                _probe_failures.clear()
            _probe_failures[key] = time.monotonic()
        raise
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
        except (ProbeFailed, subprocess.SubprocessError, ValueError, OSError):
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


def remux_command(source, output, stream, codec):
    if codec not in COPY_CODECS:
        raise ValueError(f"{codec} cannot be copied")
    # -copyts keeps an intentional start delay; GST's video timeline starts at 0.
    return [
        "nice", "-n", "10", "ffmpeg", "-nostdin", "-v", "error", *INPUT_OPTIONS, "-copyts", "-i", source,
        "-map", f"0:a:{stream}", "-vn", "-sn", "-dn", "-c:a", "copy",
        "-f", "hls", "-hls_time", "6", "-hls_playlist_type", "vod",
        "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
        "-hls_segment_filename", os.path.join(output, "s%d.m4s"),
        os.path.join(output, "audio.m3u8"),
    ]


def rendition_dir(torrent_hash, file_id, stream, mode):
    return os.path.join(CACHE_DIR, f"{torrent_hash}-{file_id}-{stream}-{mode}")


def abandoned(job):
    return time.monotonic() - job["seen"] > ABANDON_SECONDS


def run_command(command, job):
    """Run ffmpeg until it exits, the job deadline passes or no client waits."""
    deadline = time.monotonic() + job["timeout"]
    process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    while True:
        try:
            _, stderr = process.communicate(timeout=5)
            break
        except subprocess.TimeoutExpired:
            if abandoned(job) or time.monotonic() > deadline:
                process.kill()
                process.communicate()
                raise TimeoutError("abandoned" if abandoned(job) else "deadline passed") from None
    if process.returncode:
        raise subprocess.CalledProcessError(process.returncode, command, stderr=stderr)


def run_job(torrent_hash, file_id, stream, mode, job):
    final = rendition_dir(torrent_hash, file_id, stream, mode)
    temporary = final + ".tmp"
    try:
        with _job_slot:
            if os.path.isfile(os.path.join(final, "audio.m3u8")):
                return
            if abandoned(job):
                raise TimeoutError("abandoned while queued")
            streams = probe_audio(torrent_hash, file_id)
            if stream >= len(streams):
                raise ValueError("audio stream does not exist")
            shutil.rmtree(temporary, ignore_errors=True)
            os.makedirs(temporary)
            command = remux_command(stream_url(torrent_hash, file_id), temporary, stream, streams[stream].get("codec_name"))
            run_command(command, job)
            os.replace(temporary, final)
    except Exception as error:  # Reported to the waiting request; the next request retries.
        shutil.rmtree(temporary, ignore_errors=True)
        detail = error.stderr.decode("utf-8", "replace")[-500:] if getattr(error, "stderr", None) else str(error)
        print(f"remux {torrent_hash}/{file_id}/{stream}/{mode} failed: {type(error).__name__} {detail}", file=sys.stderr, flush=True)
        job["error"] = "remux failed"
    finally:
        job["done"].set()
        with _jobs_lock:
            _jobs.pop((torrent_hash, file_id, stream, mode), None)
    if not job["error"]:
        evict_safely(keep=final)


def rendition_ready(torrent_hash, file_id, stream, mode):
    final = rendition_dir(torrent_hash, file_id, stream, mode)
    if not os.path.isfile(os.path.join(final, "audio.m3u8")):
        return False
    try:
        os.utime(final)
    except OSError:
        pass
    return True


def ensure_rendition(torrent_hash, file_id, stream, mode, wait, length=0):
    """Return (ready, error). Starts at most one job per rendition."""
    if rendition_ready(torrent_hash, file_id, stream, mode):
        return True, None
    key = (torrent_hash, file_id, stream, mode)
    with _jobs_lock:
        job = _jobs.get(key)
        if job is None and len(_jobs) >= MAX_JOBS:
            return False, "busy"
        if job is None:
            job = {"done": threading.Event(), "error": None, "timeout": job_timeout(length), "seen": time.monotonic()}
            _jobs[key] = job
            threading.Thread(target=run_job, args=(*key, job), daemon=True).start()
        else:
            job["seen"] = time.monotonic()
    if not job["done"].wait(wait):
        return False, None
    if job["error"]:
        return False, job["error"]
    return True, None


class LiveRendition:
    """An AAC rendition encoded from the playback position on demand."""

    def __init__(self, torrent_hash, file_id, stream, info):
        self.source = stream_url(torrent_hash, file_id)
        self.stream = stream
        self.channels = info.get("channels") or 2
        self.count = math.ceil(info["duration"] * SAMPLE_RATE / SEGMENT_SAMPLES)
        self.directory = rendition_dir(torrent_hash, file_id, stream, "aac")
        self.process = None
        self.start = self.head = 0
        self.warmup = None
        self.paused = False
        self.requested = 0
        self.ticket = 0  # only the newest request may move the encoder
        self.seen = time.monotonic()
        self.runs = 0
        self.failures = 0
        self.failed_at = 0.0

    def covers(self, index):
        """Whether the current run will produce segment `index` soon."""
        if self.process is None or index is None:
            return self.process is not None
        # A missing segment behind the head (dropped warm-up, evicted) will not come.
        first = max(self.head, self.start + 1 if self.warmup == self.start else self.start)
        return first <= index <= self.head + LIVE_REACH


def live_playlist(count):
    # Every segment is whole: the encoder pads the audio to the end of the grid.
    lines = [
        "#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:6", "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:VOD", '#EXT-X-MAP:URI="init.mp4"',
    ]
    for index in range(count):
        lines += [f"#EXTINF:{SEGMENT_SECONDS:.6f},", f"s{index}.m4s"]
    return "\n".join(lines + ["#EXT-X-ENDLIST", ""])


def live_command(source, output, stream, channels, start, count):
    remaining = f"{(count - start) * SEGMENT_SECONDS:.6f}"
    # Chrome rejects AAC with the 5.1(side) layout that AC-3 and DTS decode to.
    layout = ["aformat=channel_layouts=5.1"] if channels > 2 else []
    # Padding makes the last listed segment exist even when the probed
    # duration is a little longer than the audio.
    filters = ",".join(layout + [f"apad=whole_dur={remaining}"])
    return [
        "nice", "-n", "10", "ffmpeg", "-nostdin", "-v", "error", *INPUT_OPTIONS,
        "-reconnect", "1", "-reconnect_delay_max", "10",
        "-ss", f"{start * SEGMENT_SECONDS:.6f}", "-i", source,
        "-map", f"0:a:{stream}", "-vn", "-sn", "-dn", "-af", filters, "-t", remaining,
        "-c:a", "aac", "-ar", str(SAMPLE_RATE), "-b:a", "384k" if channels > 2 else "192k",
        "-f", "hls", "-hls_time", f"{SEGMENT_SECONDS:.9f}", "-hls_flags", "temp_file", "-hls_list_size", "0",
        "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4", "-start_number", str(start),
        "-hls_segment_filename", os.path.join(output, "s%d.m4s"), os.path.join(output, "audio.m3u8"),
    ]


def with_decode_time(data, index):
    """Place a run's segment on the absolute timeline; ffmpeg starts each run at 0."""
    data = bytearray(data)

    def children(start, end):
        while start + 8 <= end:
            size, kind = struct.unpack(">I4s", data[start:start + 8])
            if size < 8:
                raise ValueError("bad box")
            yield kind, start, size
            start += size

    patched = False
    for kind, start, size in children(0, len(data)):
        if kind != b"moof":
            continue
        for kind, traf, traf_size in children(start + 8, start + size):
            if kind != b"traf":
                continue
            for kind, box, _ in children(traf + 8, traf + traf_size):
                if kind == b"tfdt":
                    value = index * SEGMENT_SAMPLES
                    if data[box + 8]:
                        data[box + 12:box + 20] = struct.pack(">Q", value)
                    else:
                        data[box + 12:box + 16] = struct.pack(">I", value)
                    patched = True
    if not patched:
        raise ValueError("segment has no tfdt")
    return bytes(data)


def write_atomically(path, data):
    # Writers can overlap (a replaced run and its successor), so each gets its own name.
    temporary = f"{path}.{os.getpid()}-{threading.get_ident()}.part"
    with open(temporary, "wb") as output:
        output.write(data)
    os.replace(temporary, path)


def live_rendition(torrent_hash, file_id, stream):
    key = (torrent_hash, file_id, stream)
    with _live_changed:
        rendition = _live.get(key)
    if rendition is None:
        streams = probe_audio(torrent_hash, file_id)
        if stream >= len(streams) or not streams[stream]["duration"]:
            raise ValueError("audio stream has no duration")
        with _live_changed:
            rendition = _live.setdefault(key, LiveRendition(torrent_hash, file_id, stream, streams[stream]))
    os.makedirs(rendition.directory, exist_ok=True)
    playlist = os.path.join(rendition.directory, "audio.m3u8")
    if not os.path.isfile(playlist):
        write_atomically(playlist, live_playlist(rendition.count).encode("utf-8"))
    return rendition


def stop_run(rendition):
    process = rendition.process
    rendition.process = None
    rendition.paused = False
    if process and process.poll() is None:
        process.send_signal(signal.SIGCONT)
        process.kill()


def start_run(rendition, index):
    """Start encoding at `index`; the caller holds _live_changed."""
    others = [item for item in _live.values() if item is not rendition and item.process]
    active = [item for item in others if not item.paused]
    if len(active) >= MAX_ACTIVE_RUNS:
        # A rendition nobody asked for lately (a track switched away from)
        # yields its slot instead of blocking the new one until abandoned.
        stale = min(active, key=lambda item: item.seen)
        if time.monotonic() - stale.seen < STALE_SECONDS:
            return False
        stop_run(stale)
        others.remove(stale)
    if len(others) >= MAX_RUNS:
        stop_run(min(others, key=lambda item: (not item.paused, item.seen)))
    stop_run(rendition)
    # The first segment of a run starts with the encoder's priming frame, so
    # a run starts one segment early and drops it.
    start = max(index - 1, 0)
    run_dir = f"{rendition.directory}.run{rendition.runs}.tmp"
    rendition.runs += 1
    shutil.rmtree(run_dir, ignore_errors=True)
    os.makedirs(run_dir)
    log = open(os.path.join(run_dir, "ffmpeg.log"), "wb")
    try:
        process = subprocess.Popen(
            live_command(rendition.source, run_dir, rendition.stream, rendition.channels, start, rendition.count),
            stdout=subprocess.DEVNULL, stderr=log,
        )
    finally:
        log.close()
    rendition.process, rendition.start, rendition.head, rendition.paused = process, start, start, False
    rendition.warmup = start if index > 0 else None
    threading.Thread(target=watch_run, args=(rendition, process, run_dir, rendition.warmup), daemon=True).start()
    return True


def collect_segments(rendition, process, run_dir, warmup):
    finished = sorted(
        (int(match.group(1)), name) for name in os.listdir(run_dir) if (match := SEGMENT_RE.match(name))
    )
    if not finished:
        return
    os.makedirs(rendition.directory, exist_ok=True)
    init = os.path.join(rendition.directory, "init.mp4")
    if not os.path.isfile(init):
        # Runs share codec settings, so their init segments are identical.
        with open(os.path.join(run_dir, "init.mp4"), "rb") as source:
            write_atomically(init, source.read())
    for index, name in finished:
        path = os.path.join(run_dir, name)
        target = os.path.join(rendition.directory, name)
        if index != warmup and not os.path.isfile(target):
            with open(path, "rb") as source:
                write_atomically(target, with_decode_time(source.read(), index))
        os.remove(path)
        with _live_changed:
            if rendition.process is process:
                rendition.head = max(rendition.head, index + 1)
                rendition.failures = 0
            _live_changed.notify_all()


def watch_run(rendition, process, run_dir, warmup):
    try:
        while True:
            finished = process.poll() is not None
            collect_segments(rendition, process, run_dir, warmup)
            if finished:
                break
            with _live_changed:
                if rendition.process is process:
                    if time.monotonic() - rendition.seen > ABANDON_SECONDS:
                        stop_run(rendition)
                    elif not rendition.paused and rendition.head - rendition.requested > LIVE_AHEAD:
                        # Stop reading the torrent until playback catches up.
                        process.send_signal(signal.SIGSTOP)
                        rendition.paused = True
                        _live_changed.notify_all()
            time.sleep(0.25)
        with _live_changed:
            # A dropped connection can also end ffmpeg cleanly, before the grid ends.
            failed = process.returncode != -signal.SIGKILL and rendition.head < rendition.count
            if failed and rendition.process is process:
                rendition.failures += 1
                rendition.failed_at = time.monotonic()
        if failed:
            with open(os.path.join(run_dir, "ffmpeg.log"), "rb") as log:
                detail = log.read()[-500:].decode("utf-8", "replace")
            print(f"live encode {rendition.directory} stopped early: {process.returncode} {detail}", file=sys.stderr, flush=True)
    except Exception as error:
        if rendition.process is process:  # A replaced run may lose its directory.
            print(f"live encode {rendition.directory} failed: {type(error).__name__} {error}", file=sys.stderr, flush=True)
        if process.poll() is None:
            process.send_signal(signal.SIGCONT)
            process.kill()
    finally:
        with _live_changed:
            if rendition.process is process:
                rendition.process = None
                rendition.paused = False
            _live_changed.notify_all()
        shutil.rmtree(run_dir, ignore_errors=True)


def live_file(rendition, index, wait):
    """Wait until segment `index` (None for init.mp4) exists, encoding it if
    needed. Return False on timeout and None when encoding keeps failing."""
    name = "init.mp4" if index is None else f"s{index}.m4s"
    path = os.path.join(rendition.directory, name)
    deadline = time.monotonic() + wait
    with _live_changed:
        rendition.seen = time.monotonic()
        rendition.ticket += 1
        ticket = rendition.ticket
        if index is not None:
            rendition.requested = index
        target = rendition.requested if index is None else index
        if rendition.paused and rendition.process and rendition.head - target <= LIVE_AHEAD // 2:
            # Resume in batches once playback has used half of the lead.
            rendition.process.send_signal(signal.SIGCONT)
            rendition.paused = False
        while not os.path.isfile(path):
            now = time.monotonic()
            if now - rendition.failed_at > FAILURE_RESET_SECONDS:
                rendition.failures = 0
            if rendition.failures >= MAX_FAILURES:
                return None
            if rendition.covers(index):
                if rendition.paused:
                    rendition.process.send_signal(signal.SIGCONT)
                    rendition.paused = False
            elif ticket == rendition.ticket and now >= rendition.failed_at + 2 * rendition.failures:
                # Older requests (a seek hls.js already abandoned, another
                # viewer) wait instead of fighting over the encoder.
                try:
                    start_run(rendition, target)
                except OSError as error:
                    print(f"live encode {rendition.directory} failed to start: {error}", file=sys.stderr, flush=True)
                    rendition.failures += 1
                    rendition.failed_at = now
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            _live_changed.wait(min(remaining, 1))
    return True


def directory_size(path):
    return sum(entry.stat().st_size for entry in os.scandir(path) if entry.is_file())


def evict(now=None, keep=None):
    now = now or time.time()
    entries = []
    for name in os.listdir(CACHE_DIR):
        path = os.path.join(CACHE_DIR, name)
        if name.endswith(".tmp") or path == keep:
            continue
        try:  # Another eviction may remove a directory meanwhile.
            entries.append((os.stat(path).st_mtime, directory_size(path), path))
        except (FileNotFoundError, NotADirectoryError):
            continue
    total = sum(size for _, size, _ in entries)
    if keep:
        try:
            total += directory_size(keep)
        except FileNotFoundError:
            pass
    for modified, size, path in sorted(entries):
        if now - modified <= CACHE_TTL_SECONDS and total <= CACHE_MAX_BYTES:
            break
        shutil.rmtree(path, ignore_errors=True)
        total -= size


def evict_safely(keep=None):
    try:
        evict(keep=keep)
    except Exception as error:
        print(f"eviction failed: {type(error).__name__} {error}", file=sys.stderr, flush=True)


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

    def serve_file(self, path, name):
        try:
            with open(path, "rb") as source:
                body = source.read()
        except FileNotFoundError:
            return self.send_json(404, {"error": "not found"})
        cache = "no-store" if name == "audio.m3u8" else "private, max-age=3600"
        self.send_bytes(200, body, CONTENT_TYPES[os.path.splitext(name)[1]], cache)

    def serve_live(self, torrent_hash, file_id, stream, name, query):
        directory = rendition_dir(torrent_hash, file_id, stream, "aac")
        if name == "audio.m3u8":
            # The audio-file check runs once; segments require its playlist.
            if not rendition_ready(torrent_hash, file_id, stream, "aac"):
                try:
                    require_audio_file(torrent_hash, file_id)
                except Rejected:
                    return self.send_json(404, {"error": "not found"})
                except Exception:
                    return self.send_json(502, {"error": "track lookup failed"})
        elif not rendition_ready(torrent_hash, file_id, stream, "aac"):
            return self.send_json(404, {"error": "not found"})
        try:
            rendition = live_rendition(torrent_hash, file_id, stream)
        except Exception as error:
            print(f"live rendition {directory} failed: {type(error).__name__} {error}", file=sys.stderr, flush=True)
            return self.send_json(502, {"error": "remux failed"})
        if name == "audio.m3u8":
            position = query.get("at", [""])[0]
            if re.fullmatch(r"[0-9]{1,6}", position):
                # Start encoding where playback is before hls.js asks for it.
                index = min(int(position) * SAMPLE_RATE // SEGMENT_SAMPLES, rendition.count - 1)
                with _live_changed:
                    rendition.requested = index
                    rendition.seen = time.monotonic()
                    if rendition.process is None:
                        start_run(rendition, index)
            return self.serve_file(os.path.join(directory, name), name)
        index = None if name == "init.mp4" else int(name[1:-4])
        if index is not None and index >= rendition.count:
            return self.send_json(404, {"error": "not found"})
        ready = live_file(rendition, index, JOB_WAIT_SECONDS)
        if ready is None:
            return self.send_json(502, {"error": "remux failed"})
        if not ready:
            return self.send_json(503, {"error": "preparing"}, {"Retry-After": "1"})
        return self.serve_file(os.path.join(directory, name), name)

    def do_GET(self):
        split = urllib.parse.urlsplit(self.path)
        path, query = split.path, urllib.parse.parse_qs(split.query)
        if path == "/extaudio/health":
            return self.send_json(200, {"ok": True})
        match = ROUTE_RE.match(path)
        if not match:
            return self.send_json(404, {"error": "not found"})
        torrent_hash, file_id = match.group(1).lower(), int(match.group(2))
        if match.group(3):
            if not _track_lookups.acquire(blocking=False):
                return self.send_json(429, {"error": "busy"}, {"Retry-After": "5"})
            try:
                return self.send_json(200, {"tracks": external_tracks(torrent_hash, file_id)})
            except urllib.error.HTTPError as error:
                error.close()
                return self.send_json(404 if error.code == 404 else 502, {"error": "track lookup failed"})
            except Exception:
                return self.send_json(502, {"error": "track lookup failed"})
            finally:
                _track_lookups.release()
        stream, mode, name = int(match.group(4)), match.group(5), match.group(6)
        if not FILE_RE.match(name):
            return self.send_json(404, {"error": "not found"})
        if mode == "aac":
            return self.serve_live(torrent_hash, file_id, stream, name, query)
        if name != "audio.m3u8":
            # Segments never start work; only a prepared rendition serves them.
            if not rendition_ready(torrent_hash, file_id, stream, mode):
                return self.send_json(404, {"error": "not found"})
        else:
            length = 0
            if not rendition_ready(torrent_hash, file_id, stream, mode):
                try:
                    length = require_audio_file(torrent_hash, file_id)
                except Rejected:
                    return self.send_json(404, {"error": "not found"})
                except Exception:
                    return self.send_json(502, {"error": "track lookup failed"})
            ready, error = ensure_rendition(torrent_hash, file_id, stream, mode, JOB_WAIT_SECONDS, length)
            if error == "busy":
                return self.send_json(429, {"error": "busy"}, {"Retry-After": "10"})
            if error:
                return self.send_json(502, {"error": error})
            if not ready:
                # The plugin polls until the whole rendition exists.
                return self.send_json(503, {"error": "preparing"}, {"Retry-After": "2"})
        self.serve_file(os.path.join(rendition_dir(torrent_hash, file_id, stream, mode), name), name)


def main():
    os.makedirs(CACHE_DIR, exist_ok=True)
    for name in os.listdir(CACHE_DIR):
        if name.endswith(".tmp"):
            shutil.rmtree(os.path.join(CACHE_DIR, name), ignore_errors=True)
    evict_safely()

    def evict_periodically():
        while True:
            time.sleep(3600)
            evict_safely()

    threading.Thread(target=evict_periodically, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()


if __name__ == "__main__":
    main()
