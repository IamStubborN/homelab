#!/usr/bin/env python3
"""Bounded foreground frames and resumable GPU thumbnail batches for TorrServer."""
import concurrent.futures
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.environ.get("TORRSERVER_BASE", "http://gluetun-torrserver:8090").rstrip("/")
CACHE = Path(os.environ.get("CACHE_DIR", "/cache"))
MAX_BYTES = int(os.environ.get("CACHE_MAX_MB", "2048")) * 1024 * 1024
TTL = 72 * 3600
STEP = 10
TIMEOUT = 25
DEVICE = os.environ.get("VAAPI_DEVICE", "")
CACHE_VERSION = "jpeg-320x180-q5-v3"
BATCH_RATE = max(.25, min(16, float(os.environ.get("BATCH_READ_RATE", "8"))))
BATCH_GRACE = 10
BATCH_TIMEOUT = 900
MAX_RELEASES = 4
MAX_FILES = 500
MAX_FILE_CACHE = min(MAX_BYTES, 128 * 1024 * 1024)
CLEAN_INTERVAL = 60
VIDEO = {".mkv", ".mp4", ".m4v", ".webm", ".mov", ".avi", ".ts", ".m2ts"}
# No playlist, concat, network reference or arbitrary source URL accepted.
INPUT = ["-protocol_whitelist", "http,tcp", "-format_whitelist",
         "matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,avi,mpegts", "-rw_timeout", "10000000",
         "-probesize", "5000000", "-analyzeduration", "5000000"]
ROUTE = re.compile(r"^/previews/([a-f0-9]{40})/([1-9][0-9]{0,5})/(metadata|prepare|status|frame/([0-9]{1,5})\.jpg)$")
executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
lock = threading.Lock()
decode_lock = threading.Lock()
wake = threading.Event()
jobs = {}
# Foreground ownership: a client id owns at most one live job; anonymous
# (legacy/gallery) requests are owned by None and are never superseded.
job_owners = {}
job_cancel = {}
client_jobs = {}
client_order = {}
releases = []
clients = {}
closed_clients = {}
unsupported = {}
CLIENT = re.compile(r"[a-zA-Z0-9_-]{8,64}")
FAILURE_BACKOFF = 60
TRANSIENT_BACKOFF = 10
MAX_CLIENT_JOBS = 256
UNSUPPORTED_TTL = 600
active_batch = None
generation = 0
pause_until = 0


class Unavailable(Exception):
    pass


class Interrupted(Exception):
    pass


class Busy(Unavailable):
    """Temporary capacity limit or source outage: retry soon (HTTP 503)."""

    def __init__(self, message, retry_after=2):
        super().__init__(message)
        self.retry_after = max(1, int(math.ceil(retry_after)))


class Temporary(Unavailable):
    """TorrServer has no usable answer yet; not a property of the file."""


class Failed(Unavailable):
    """The work itself failed or cannot be done: do not poll (HTTP 422)."""

    def __init__(self, message, retry_after=FAILURE_BACKOFF):
        super().__init__(message)
        self.retry_after = max(1, int(math.ceil(retry_after)))


class Unsupported(Unavailable):
    """The release or file can never be prepared (HTTP 422)."""


def torrent(torrent_hash, cancelled=None):
    for attempt in range(2):
        if cancelled and cancelled():
            raise Interrupted()
        request = urllib.request.Request(BASE + "/torrents", data=json.dumps(
            {"action": "get", "hash": torrent_hash}).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=8) as response:
            data = json.loads(response.read(2 * 1024 * 1024))
        if not isinstance(data, dict):
            raise Temporary("invalid torrent metadata")
        # An existing idle torrent can return before its file statistics are ready.
        if data.get("file_stats") or data.get("hash") != torrent_hash or attempt:
            return data
        time.sleep(.25)


def playable(files):
    if not isinstance(files, list) or not files:
        raise Temporary("statistics unavailable")
    if len(files) > 10000:
        raise Unsupported("invalid release")
    videos = [f for f in files if isinstance(f, dict) and type(f.get("id")) is int and 1 <= f["id"] <= 999999
              and isinstance(f.get("path"), str) and len(f["path"]) <= 4096 and Path(f["path"]).suffix.lower() in VIDEO]
    if not videos or len(videos) > MAX_FILES or len({f["id"] for f in videos}) != len(videos):
        raise Unsupported("invalid videos")
    return sorted(videos, key=lambda f: [(1, int(s)) if s.isdigit() else (0, s.casefold()) for s in re.split(r"(\d+)", f["path"])])


def source(torrent_hash, index, cancelled=None):
    files = [f for f in playable(torrent(torrent_hash, cancelled).get("file_stats")) if f["id"] == index]
    if not files or Path(files[0].get("path", "")).suffix.lower() not in VIDEO:
        raise Unsupported("unknown video")
    return BASE + "/stream/?" + urllib.parse.urlencode({"link": torrent_hash, "index": index, "play": ""})


def terminate(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def run(args, cancelled=None):
    # Bound decoder threads, output and wall time; never log media URLs or names.
    # The container's 16 MiB /tmp caps spooling even for malicious metadata.
    with tempfile.TemporaryFile() as output:
        process = subprocess.Popen(args, stdout=output, stderr=subprocess.DEVNULL)
        try:
            started = time.monotonic()
            while process.poll() is None:
                if cancelled and cancelled():
                    raise Interrupted()
                if time.monotonic() - started >= TIMEOUT:
                    raise subprocess.TimeoutExpired(args, TIMEOUT)
                time.sleep(.05)
            if process.returncode:
                raise subprocess.CalledProcessError(process.returncode, args)
        finally:
            terminate(process)
        if output.tell() > 2 * 1024 * 1024:
            raise Unavailable("metadata too large")
        output.seek(0)
        return output.read(2 * 1024 * 1024 + 1)


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else 0
    except (TypeError, ValueError):
        return 0


def metadata(raw, step=STEP):
    duration = number(raw.get("format", {}).get("duration"))
    if not 0 < duration <= 24 * 3600:
        raise Unavailable("duration unavailable")
    chapters = []
    for item in raw.get("chapters", [])[:1000]:
        start, end = number(item.get("start_time")), number(item.get("end_time"))
        if 0 <= start < end <= duration + 1:
            chapters.append({"start": start, "end": min(end, duration),
                             "title": str(item.get("tags", {}).get("title") or "")[:200]})
    chapters.sort(key=lambda item: item["start"])
    return {"version": 1, "duration": duration, "step": step, "chapters": chapters}


def ffmpeg_args(url, at, output, *, batch=False, software=False, step=STEP):
    args = ["ffmpeg", "-v", "error", "-nostdin", "-threads", "1", "-filter_threads", "1"]
    gpu = DEVICE and not software
    if gpu:
        args += ["-hwaccel", "vaapi", "-hwaccel_device", DEVICE, "-hwaccel_output_format", "vaapi"]
    if batch and BATCH_RATE > 0:
        args += ["-readrate", str(BATCH_RATE if gpu else min(BATCH_RATE, 2))]
    scale = ("scale_vaapi=w=320:h=180:force_original_aspect_ratio=decrease:force_divisible_by=2:format=nv12,hwdownload,format=nv12"
             if gpu else "scale=320:180:force_original_aspect_ratio=decrease")
    filters = (f"select='gte(t,selected_n*{step})'," if batch else "") + scale + ",pad=320:180:(ow-iw)/2:(oh-ih)/2"
    # Input seeking reads the requested GOP, not all preceding frames.
    return args + INPUT + ["-ss", str(at), "-i", url, "-map", "0:v:0", "-an", "-sn", "-dn",
        "-vf", filters] + (["-fps_mode", "vfr", "-start_number", str(round(at / step)), "-atomic_writing", "1"] if batch else ["-frames:v", "1"]) + [
        "-q:v", "5", "-threads", "1", "-f", "image2", "-y", str(output)]


def directory(torrent_hash, index, step=STEP):
    return CACHE / hashlib.sha256(f"{torrent_hash}/{index}/{CACHE_VERSION}/step{step}".encode()).hexdigest()


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, separators=(",", ":")))
    temporary.replace(path)


def touch(path):
    marker = path / ".access"
    try:
        if not marker.exists() or time.time() - marker.stat().st_mtime > 60:
            marker.touch()
    except FileNotFoundError:
        pass


def protected_directories():
    protected = {directory(h, i, step) for (h, i, step, _), (future, _) in jobs.items() if not future.done()}
    protected.update(directory(c["hash"], c["index"]) for c in clients.values() if time.monotonic() - c["seen"] < 45)
    if active_batch:
        protected.add(directory(*active_batch))
    return protected


def prune():
    CACHE.mkdir(parents=True, exist_ok=True)
    folders = []
    for path in CACHE.iterdir():
        if not path.is_dir():
            continue
        if path.name.startswith(".evict-"):
            shutil.rmtree(path, ignore_errors=True)
            continue
        try:
            files = [p.stat() for p in path.iterdir() if p.is_file()]
            stamp = (path / ".access").stat().st_mtime if (path / ".access").exists() else max((s.st_mtime for s in files), default=0)
            folders.append((stamp, sum(s.st_size for s in files), path))
        except FileNotFoundError:
            continue
    total = sum(size for _, size, _ in folders)
    for stamp, size, path in sorted(folders):
        if time.time() - stamp > TTL or total > MAX_BYTES:
            with lock:
                if path in protected_directories() or not path.exists():
                    continue
                access = path / ".access"
                if access.exists() and access.stat().st_mtime > stamp:
                    continue
                # Reserve by atomic rename before releasing the scheduling lock.
                trash = CACHE / (".evict-" + path.name + "-" + str(time.monotonic_ns()))
                path.rename(trash)
            shutil.rmtree(trash, ignore_errors=True)
            total -= size


def prepare(torrent_hash, index, slot, step=STEP, cancelled=None):
    path = directory(torrent_hash, index, step)
    url = source(torrent_hash, index, cancelled)
    info = ensure_metadata(path, url, cancelled, step=step)
    if slot is None:
        return path / "metadata.json"
    at = slot * step
    if at >= info["duration"]:
        raise Unavailable("outside duration")
    result = path / f"{slot}.jpg"
    partial = path / f"{slot}.part"
    try:
        try:
            run(ffmpeg_args(url, at, partial, step=step), cancelled)
        except subprocess.CalledProcessError:
            if not DEVICE:
                raise
            run(ffmpeg_args(url, at, partial, software=True, step=step), cancelled)
        if not 0 < partial.stat().st_size < 512 * 1024:
            raise Unavailable("invalid frame")
        partial.replace(result)
    finally:
        partial.unlink(missing_ok=True)
    touch(path)
    return result


def ensure_metadata(path, url, cancelled=None, step=STEP):
    path.mkdir(parents=True, exist_ok=True)
    info_file = path / "metadata.json"
    if not info_file.exists():
        raw = json.loads(run(["ffprobe", "-v", "error"] + INPUT + ["-show_chapters", "-show_format",
            "-show_entries", "format=duration:chapter=start_time,end_time:chapter_tags=title", "-of", "json", url], cancelled=cancelled))
        info = metadata(raw, step)
        atomic_json(info_file, info)
    else:
        info = json.loads(info_file.read_text())
    touch(path)
    return info


def frame_exists(path):
    try:
        return 4 <= path.stat().st_size < 512 * 1024
    except FileNotFoundError:
        return False


def batch_complete(torrent_hash, index):
    path = directory(torrent_hash, index)
    try:
        value = json.loads((path / "complete.json").read_text())
        return (value["version"] == CACHE_VERSION and type(value["frames"]) is int and 1 <= value["frames"] <= math.ceil(86400 / STEP)
                and all(frame_exists(path / f"{i}.jpg") for i in range(value["frames"])))
    except (OSError, ValueError, KeyError, TypeError):
        return False


def generate_batch(torrent_hash, index, cancelled):
    path = directory(torrent_hash, index)
    if cancelled():
        raise Interrupted()
    url = source(torrent_hash, index, cancelled)
    if cancelled():
        raise Interrupted()
    info = ensure_metadata(path, url, cancelled)
    count = math.ceil(info["duration"] / STEP)
    software = not bool(DEVICE)
    while True:
        start = 0
        while start < count and frame_exists(path / f"{start}.jpg"):
            start += 1
        if start == count:
            atomic_json(path / "complete.json", {"version": CACHE_VERSION, "frames": count})
            return
        if cancelled():
            raise Interrupted()
        args = ffmpeg_args(url, start * STEP, path / "%d.jpg", batch=True, software=software)
        args[-1:-1] = ["-frames:v", str(count - start)]
        process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            try:
                os.setpriority(os.PRIO_PROCESS, process.pid, max(10, os.getpriority(os.PRIO_PROCESS, process.pid)))
            except OSError:
                pass
            started = time.monotonic()
            while process.poll() is None:
                if cancelled() or time.monotonic() - started > BATCH_TIMEOUT:
                    raise Interrupted()
                if sum(p.stat().st_size for p in path.iterdir() if p.is_file()) > MAX_FILE_CACHE:
                    raise Unavailable("file cache budget")
                time.sleep(.2)
            if process.returncode:
                if not software:
                    software = True
                    continue
                raise Unavailable("decoder failed")
            if not all(frame_exists(path / f"{i}.jpg") for i in range(count)):
                raise Unavailable("incomplete extraction")
        finally:
            terminate(process)
            for partial in path.glob("*.tmp"):
                partial.unlink(missing_ok=True)


def foreground(torrent_hash, index, slot, step, cancel=None):
    cancelled = cancel.is_set if cancel else (lambda: False)
    with decode_lock:
        if cancelled():
            raise Interrupted()
        return prepare(torrent_hash, index, slot, step, cancelled=cancelled)


def forget_job(key):
    jobs.pop(key, None)
    job_owners.pop(key, None)
    job_cancel.pop(key, None)


def interrupted(future):
    return future.cancelled() or isinstance(future.exception(), Interrupted)


def transient(error):
    # Source outages and slow torrent reads; decode and file problems are final.
    return isinstance(error, (OSError, Temporary, subprocess.TimeoutExpired))


def backoff(future):
    """Seconds a finished job blocks its key, counted from its completion."""
    if interrupted(future) or future.exception() is None:
        return 0
    return TRANSIENT_BACKOFF if transient(future.exception()) else FAILURE_BACKOFF


def finished(future, since):
    return getattr(future, "finished_at", since)


def cancel_job(key):
    """Called with lock held once no owner wants the job any more."""
    if key not in jobs:
        return
    job_cancel[key].set()
    if jobs[key][0].cancel():
        forget_job(key)


def release(client, keep=None):
    """Drop the client's claim on its job unless it is `keep`."""
    previous = client_jobs.pop(client, None)
    if previous is None or previous == keep or previous not in job_owners:
        return
    owners = job_owners[previous]
    owners.discard(client)
    if not owners:
        cancel_job(previous)


def retarget(client, key):
    """Latest wins: a client's new request releases its previous one."""
    release(client, key)
    client_jobs[client] = key


def newer(client, n):
    """Requests of one client can overtake each other on a threaded server."""
    if n is None:
        return True
    if n <= client_order.get(client, -1):
        return False
    client_order.pop(client, None)
    client_order[client] = n
    while len(client_order) > MAX_CLIENT_JOBS:
        client_order.pop(next(iter(client_order)))
    return True


def cancel_client(client, n=None):
    with lock:
        if newer(client, n):
            release(client)


def live(key):
    cancel = job_cancel.get(key)
    return not jobs[key][0].done() and not (cancel and cancel.is_set())


def cleanup_jobs(now):
    # Finished failures back off; successes and interrupted work need no entry.
    for old, (future, since) in list(jobs.items()):
        if future.done() and now - finished(future, since) >= backoff(future):
            forget_job(old)
    for client in [c for c, key in client_jobs.items() if key not in jobs]:
        del client_jobs[client]


def request_job(torrent_hash, index, slot, step=STEP, client=None, n=None):
    key = (torrent_hash, index, step, slot)
    path = directory(torrent_hash, index, step) / ("metadata.json" if slot is None else f"{slot}.jpg")
    with lock:
        now = time.monotonic()
        cleanup_jobs(now)
        current = client is None or newer(client, n)
        if client is not None and current:
            if client not in client_jobs and len(client_jobs) >= MAX_CLIENT_JOBS:
                raise Busy("client budget")
            retarget(client, key)
        if path.exists():
            touch(path.parent)
            return path
        if not current:
            return None  # Overtaken by a newer request of the same client.
        if key in jobs:
            future, since = jobs[key]
            if future.done():
                remaining = backoff(future) - (now - finished(future, since))
                if transient(future.exception()):
                    raise Busy("source unavailable", remaining)
                raise Failed("retry later", remaining)
            if job_cancel[key].is_set():
                # Superseded but still unwinding: queue a fresh job afterwards.
                forget_job(key)
            else:
                job_owners[key].add(client)
                return None
        # ponytail: one worker and at most two waiting seeks for the household;
        # each client owns at most one of them, so scrubbing cannot starve the gallery.
        if sum(live(k) for k in jobs) >= 3 or len(jobs) >= 64:
            if client is not None:
                client_jobs.pop(client, None)
            raise Busy("busy")
        cancel = threading.Event()
        job_cancel[key] = cancel
        job_owners[key] = {client}
        future = executor.submit(foreground, torrent_hash, index, slot, step, cancel)
        # Backoff runs from completion; a slow failure must not expire early.
        future.add_done_callback(lambda done: setattr(done, "finished_at", time.monotonic()))
        jobs[key] = (future, now)
        wake.set()
    return None


def cancel_all():
    with lock:
        for key in list(jobs):
            cancel_job(key)


def reset_state():
    global active_batch, pause_until, generation
    with lock:
        for collection in (jobs, job_owners, job_cancel, client_jobs, client_order, clients, closed_clients, unsupported):
            collection.clear()
        releases.clear()
        active_batch = None
        pause_until = 0
        generation = 0


def persist_queue():
    try:
        atomic_json(CACHE / ".queue.json", {"version": 1, "releases": releases})
        return True
    except OSError:
        return False


def restore_queue():
    try:
        data = json.loads((CACHE / ".queue.json").read_bytes()[:256 * 1024])
        if data.get("version") != 1 or not isinstance(data.get("releases"), list):
            return
        with lock:
            for item in data["releases"][:MAX_RELEASES]:
                if (isinstance(item, dict) and re.fullmatch(r"[a-f0-9]{40}", item.get("hash", ""))
                        and isinstance(item.get("indexes"), list) and len(item["indexes"]) <= MAX_FILES
                        and all(type(i) is int and 1 <= i <= 999999 for i in item["indexes"])
                        and type(item.get("current")) is int and isinstance(item.get("updated"), (int, float))
                        and 0 <= time.time() - item["updated"] < TTL):
                    releases.append({**item, "retry": {}})
    except (OSError, ValueError, TypeError):
        pass


def playback(torrent_hash, index, client, state, seq=None):
    global generation, pause_until
    now = time.monotonic()
    if not isinstance(client, str) or not CLIENT.fullmatch(client) or not isinstance(state, str) or state not in {"playing", "buffering", "paused", "closed"}:
        raise ValueError("invalid playback")
    if seq is not None and (type(seq) is not int or not 0 <= seq < 2 ** 53):
        raise ValueError("invalid sequence")
    with lock:
        for key in list(clients):
            if now - clients[key]["seen"] >= 45:
                del clients[key]
        for key in [k for k, (_, at) in closed_clients.items() if now - at >= 120]:
            del closed_clients[key]
        for key in [k for k, at in unsupported.items() if now - at >= UNSUPPORTED_TTL]:
            del unsupported[key]
        previous = clients.get(client)
        if seq is not None:
            # A request overtaken by a newer one (for example a heartbeat that
            # arrives after "closed") must not change or resurrect the lease.
            last = max(previous.get("seq", -1) if previous else -1, closed_clients.get(client, (-1, 0))[0])
            if seq <= last:
                return
        if state == "closed":
            if previous and (previous["hash"], previous["index"]) == (torrent_hash, index):
                del clients[client]
            if seq is not None:
                if client not in closed_clients and len(closed_clients) >= 256:
                    closed_clients.pop(next(iter(closed_clients)))
                closed_clients[client] = (seq, now)
            wake.set()
            return
        if (torrent_hash, index) in unsupported:
            raise Unsupported("unsupported release")
        if client not in clients and len(clients) >= 32:
            raise Unavailable("client budget")
        registered = previous and (previous["hash"], previous["index"]) == (torrent_hash, index) and previous.get("registered", False)
        lease = clients[client] = {"hash": torrent_hash, "index": index, "state": state, "seen": now, "registered": bool(registered)}
        if seq is not None:
            lease["seq"] = seq
        if state == "buffering":
            pause_until = max(pause_until, now + BATCH_GRACE)
        releases[:] = [p for p in releases if time.time() - p["updated"] < TTL]
        plan = next((p for p in releases if p["hash"] == torrent_hash), None)
        if plan and registered:
            if time.time() - plan["updated"] > 60:
                plan["updated"] = time.time()
                persist_queue()
            wake.set()
            return
    if state == "buffering":
        return  # Do not fetch release metadata while playback needs the source.
    try:
        videos = playable(torrent(torrent_hash).get("file_stats"))
        ids = [f["id"] for f in videos]
        if index not in ids:
            raise Unsupported("unknown video")
    except Unsupported:
        # Remember the verdict so heartbeats stop querying TorrServer.
        with lock:
            if len(unsupported) >= 256:
                unsupported.pop(next(iter(unsupported)))
            unsupported[(torrent_hash, index)] = time.monotonic()
            if clients.get(client) is lease:
                del clients[client]
        raise
    at = ids.index(index)
    order = ids[at:] + ids[:at]
    with lock:
        # A late request from a previous file cannot reprioritize a newer one.
        if clients.get(client) is not lease:
            return
        plan = next((p for p in releases if p["hash"] == torrent_hash), None)
        if plan:
            releases.remove(plan)
            remaining = set(plan["indexes"]) if registered else {i for i in ids if not batch_complete(torrent_hash, i)}
            if not batch_complete(torrent_hash, index):
                remaining.add(index)
            order = [i for i in order if i in remaining]
        elif len(releases) >= MAX_RELEASES:
            releases.pop()
        releases.insert(0, {"hash": torrent_hash, "current": index, "indexes": order, "updated": time.time(), "retry": {}})
        lease["registered"] = True
        generation += 1
        if not previous or (previous["hash"], previous["index"]) != (torrent_hash, index):
            pause_until = max(pause_until, now + BATCH_GRACE)
        if not persist_queue():
            raise Unavailable("queue storage")
        wake.set()


def background_loop(stop):
    global active_batch
    last_clean = -float("inf")
    while not stop.is_set():
        wake.clear()
        if time.monotonic() - last_clean >= CLEAN_INTERVAL:
            prune()
            last_clean = time.monotonic()
        with lock:
            now = time.monotonic()
            blocked = now < pause_until or any(c["state"] == "buffering" and now - c["seen"] < 45 for c in clients.values())
            blocked = blocked or any(not future.done() for future, _ in jobs.values())
            selected = next(((p, i) for p in releases if time.time() - p["updated"] < TTL for i in p["indexes"]
                             if p["retry"].get(str(i), {}).get("after", 0) <= time.time()), None) if not blocked else None
            if selected:
                plan, index = selected
                torrent_hash, epoch = plan["hash"], generation
                active_batch = (torrent_hash, index)
        if not selected:
            wake.wait(.5)
            continue
        def cancelled():
            with lock:
                return (stop.is_set() or generation != epoch or time.monotonic() < pause_until
                        or any(c["state"] == "buffering" and time.monotonic() - c["seen"] < 45 for c in clients.values())
                        or any(not future.done() for future, _ in jobs.values()))
        try:
            with decode_lock:
                if cancelled():
                    raise Interrupted()
                if not batch_complete(torrent_hash, index):
                    generate_batch(torrent_hash, index, cancelled)
            with lock:
                if plan in releases and index in plan["indexes"]:
                    plan["indexes"].remove(index)
                    plan["retry"].pop(str(index), None)
                    persist_queue()
        except Interrupted:
            pass  # Atomic JPEGs are checkpoints; resume at the first missing slot.
        except (OSError, ValueError, Unavailable, subprocess.SubprocessError):
            with lock:
                retry = plan["retry"].get(str(index), {})
                attempt = retry.get("attempt", 0) + 1
                plan["retry"][str(index)] = {"attempt": attempt, "after": time.time() + ([30, 120, 600][attempt - 1] if attempt <= 3 else TTL)}
                persist_queue()
        finally:
            with lock:
                active_batch = None
        prune()
        wake.wait(.1)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # hashes/paths are private; the HTTP gateway owns request logging.

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/previews/health":
            return self.reply(200, b'{"ok":true}', "application/json")
        match = ROUTE.fullmatch(path)
        if not match:
            return self.reply(404)
        torrent_hash, index, operation, slot = match.groups()
        if operation == "prepare":
            return self.reply(405)
        if operation == "status":
            with lock:
                plan = next((p for p in releases if p["hash"] == torrent_hash), None)
                value = {"version": 1, "queued": len(plan["indexes"]) if plan else 0,
                         "active": active_batch == (torrent_hash, int(index)), "complete": batch_complete(torrent_hash, int(index))}
            return self.reply(200, json.dumps(value).encode(), "application/json")
        try:
            # Bare URLs keep their original five-second meaning for cached clients.
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            steps, owner, order = query.get("step", ["5"]), query.get("client", [None]), query.get("n", [None])
            if (len(steps) != 1 or steps[0] not in {"5", "10"} or len(owner) != 1 or len(order) != 1
                    or (owner[0] is not None and not CLIENT.fullmatch(owner[0]))
                    or (order[0] is not None and not re.fullmatch(r"[0-9]{1,15}", order[0]))):
                return self.reply(400)
            result = request_job(torrent_hash, int(index), None if slot is None else int(slot), int(steps[0]), owner[0],
                                 None if order[0] is None else int(order[0]))
            if result is None:
                return self.reply(202, b'{"status":"pending"}', "application/json")
            self.reply(200, result.read_bytes(), "application/json" if operation == "metadata" else "image/jpeg")
        except Busy as error:
            self.reply(503, b'{"status":"busy"}', "application/json", retry_after=error.retry_after)
        except Failed as error:
            self.reply(422, b'{"status":"failed"}', "application/json", retry_after=error.retry_after)
        except Unsupported:
            self.reply(422, b'{"status":"failed"}', "application/json", retry_after=FAILURE_BACKOFF)
        except (OSError, Unavailable):
            self.reply(503, b'{"status":"unavailable"}', "application/json", retry_after=5)

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        match = ROUTE.fullmatch(path)
        if path != "/previews/cancel" and (not match or match.group(3) != "prepare"):
            return self.reply(404)
        try:
            self.connection.settimeout(5)
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 2048:
                return self.reply(413)
            if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
                return self.reply(415)
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError("body")
            if not match:
                # {"client": ID, "n": optional counter}: release that client's job.
                client, n = data.get("client"), data.get("n")
                if not isinstance(client, str) or not CLIENT.fullmatch(client) or (n is not None and (type(n) is not int or not 0 <= n < 10 ** 15)):
                    raise ValueError("cancel")
                cancel_client(client, n)
                return self.reply(202, b'{"status":"accepted"}', "application/json")
            playback(match.group(1), int(match.group(2)), data.get("client"), data.get("state"), data.get("seq"))
            self.reply(202, b'{"status":"accepted"}', "application/json")
        except (ValueError, TypeError):
            self.reply(400)
        except Unsupported:
            self.reply(422, b'{"status":"unsupported"}', "application/json")
        except (OSError, Unavailable):
            self.reply(503, b'{"status":"unavailable"}', "application/json")

    def reply(self, status, data=b"", content_type="text/plain", retry_after=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "private, max-age=300" if status == 200 and content_type == "image/jpeg" else "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if status == 202 or retry_after:
            self.send_header("Retry-After", str(retry_after or 1))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    CACHE.mkdir(parents=True, exist_ok=True)
    prune()
    restore_queue()
    threading.Thread(target=background_loop, args=(threading.Event(),), daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
