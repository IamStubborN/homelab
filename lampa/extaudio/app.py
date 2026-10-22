#!/usr/bin/env python3
"""External torrent audio tracks as HLS renditions for Lampa's browser player."""

import hashlib
import io
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
# An encoder run nobody asks for this long stops pulling the torrent.
ABANDON_SECONDS = int(os.environ.get("ABANDON_SECONDS", "120"))
PROBE_TIMEOUT_SECONDS = int(os.environ.get("PROBE_TIMEOUT_SECONDS", "10"))
PROBE_RETRY_SECONDS = 600
# A lookup waits PROBE_TIMEOUT_SECONDS for an audio file; its probe carries on
# this long in the background while TorrServer fetches the file.
PROBE_BACKGROUND_SECONDS = int(os.environ.get("PROBE_BACKGROUND_SECONDS", "180"))
MAX_CANDIDATES = 6
MAX_TRACK_LOOKUPS = 2
MAX_PROBES_CACHED = 256

AUDIO_EXTENSIONS = {
    ".mka", ".webm", ".m4a", ".aac", ".ac3", ".eac3", ".ec3", ".dts", ".dtshd",
    ".thd", ".truehd", ".mlp", ".flac", ".mp3", ".mp2", ".mpa", ".opus", ".ogg", ".oga",
    ".wav", ".w64", ".wma", ".ape", ".wv", ".tta", ".aiff", ".aif", ".caf",
}
VIDEO_EXTENSIONS = {
    ".mkv", ".mp4", ".m4v", ".avi", ".ts", ".m2ts", ".mts", ".webm", ".mov", ".wmv", ".mpg", ".mpeg", ".vob",
}
# Release tags whose numbers are not episode numbers.
NOISE_RE = re.compile(
    r"\[[0-9a-f]{8}\]|(?<![a-z0-9])(?:\d{3,4}p|[xh]\.?26[45]|hevc|avc|aac|e?-?ac-?3|dts|flac|opus|"
    r"[257]\.[01]|(?:19|20)\d\d|10bit|8bit|hi10p?|web-?dl|webrip|bdrip|bdremux|hdtv|uhd|hdr10?|\d+x\d+)(?![a-z0-9])",
    re.IGNORECASE,
)
SEASON_RE = re.compile(
    r"(?:^|[/\s._\[(-])(?:season[\s._]*(\d{1,2})|s(\d{1,2})(?:e\d|[/\s._\])-]|$)|(\d{1,2})[\s._-]*сезон|сезон[\s._-]*(\d{1,2}))",
    re.IGNORECASE,
)
CHANNELS_RE = re.compile(r"(?<![a-z0-9])\d{1,2}ch(?![a-z0-9])", re.IGNORECASE)
# Folders of music and extras that may number their files like episodes.
SKIP_DIR_RE = re.compile(r"(?:^|/)(?:ost|soundtracks?|music|bonus|extras?|specials?|cd\s?\d+|scans?)(?:/|$)", re.IGNORECASE)
SUBTITLE_EXTENSIONS = {".ass", ".ssa"}
FONT_EXTENSIONS = {".ttf", ".otf", ".ttc", ".woff", ".woff2"}
FONT_DIR_RE = re.compile(r"font|шрифт", re.IGNORECASE)
MAX_FONTS = 32
MAX_SUBTITLE_BYTES = 8 * 1024 * 1024
MAX_FONT_BYTES = 32 * 1024 * 1024
MAX_RAW_FETCHES = 2
RAW_FETCH_SECONDS = 60
# Embedded ASS is read from the video as it plays: each run copies one window
# of the subtitle stream, reading ahead of playback at a bounded rate.
# ffmpeg logs these when the torrent read fails; it may still exit cleanly.
READ_FAILURE_RE = re.compile(rb"Error during demuxing|Read error|Stream ends prematurely|Connection|Input/output error", re.IGNORECASE)
TEXT_SUBTITLE_CODECS = {"subrip", "ass", "ssa", "text"}  # what GST lists, in order
ASS_CODECS = {"ass", "ssa"}
SUB_WINDOW = 150
SUB_LEAD = 60  # the next window starts once playback is this close to the end
SUB_BACK = 10  # a seek starts this early to catch events already on screen
SUB_READRATE = 2
SUB_BURST = 30
MAX_SUB_RUNS = 2
SUB_IDLE_SECONDS = 60
SUB_FORGET_SECONDS = 900
MAX_SUB_TRACKS = 8
MAX_SUB_LINES = 2000  # per response
MAX_EMBEDDED_FONT_BYTES = 64 * 1024 * 1024
RENDERER_DIR = os.environ.get("RENDERER_DIR", "/app/jassub")
# Fonts releases attach, kept for releases that name them without attaching.
FONT_LIBRARY_DIR = os.environ.get("FONT_LIBRARY_DIR", "")
FONT_LIBRARY_MAX_BYTES = int(os.environ.get("FONT_LIBRARY_MAX_MB", "2048")) * 1024 * 1024
# Fewer glyphs is a subset a release made for its own lines: it would replace
# a full stand-in in every other release.
MIN_LIBRARY_GLYPHS = 200
LIBRARY_NAME_RE = re.compile(r"^[0-9a-f]{32}\.(?:ttf|otf|ttc)$")
FONTS_RE = re.compile(r"^/extaudio/fonts/(?:(index\.json)|([0-9a-f]{32}\.(?:ttf|otf|ttc)))$")
# JASSUB's names for CSS weights 100-1000; it looks fonts up as "family weight".
WEIGHT_NAMES = ["thin", "extralight", "light", "regular", "medium", "semibold", "bold", "extrabold", "black", "ultrablack"]
# Text subtitles are converted for JASSUB; ffmpeg names their style Default
# and scales <font size> to PlayResY 288.
CONVERTED_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 384
PlayResY: 288
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, \
StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,17,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,0.9,0.4,2,20,20,14,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
RENDERER_TYPES = {
    ".js": "text/javascript", ".wasm": "application/wasm", ".woff2": "font/woff2", ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
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
RUNS_PER_RENDITION = 2  # two viewers of one track at different positions
STALE_SECONDS = 10  # an active run nobody asked for this long yields its slot
MAX_FAILURES = 3
FAILURE_RESET_SECONDS = 60
SEGMENT_RE = re.compile(r"^s(\d+)\.m4s$")
FILE_RE = re.compile(r"^(?:audio\.m3u8|init\.mp4|s\d{1,6}\.m4s)$")
ROUTE_RE = re.compile(r"^/extaudio/([0-9a-fA-F]{40})/(\d{1,6})/(?:(tracks|raw)|(\d{1,2})/(aac)/([^/]+))$")
EMBEDDED_RE = re.compile(r"^/extaudio/([0-9a-fA-F]{40})/(\d{1,6})/(?:(embedded)|sub/(\d{1,2})|attachment/(\d{1,3}))$")
RENDERER_RE = re.compile(r"^/extaudio/jassub/([a-z0-9-]+\.(?:js|wasm|woff2|ttf|txt))$")
CONTENT_TYPES = {".m3u8": "application/vnd.apple.mpegurl", ".mp4": "audio/mp4", ".m4s": "video/iso.segment"}

_probe_cache = {}
_probe_failures = {}
_probing = {}
_probe_lock = threading.Lock()
_track_lookups = threading.Semaphore(MAX_TRACK_LOOKUPS)
_raw_fetches = threading.Semaphore(MAX_RAW_FETCHES)
_live = {}
_live_changed = threading.Condition()
_embedded_cache = {}
_subs = {}
_subs_lock = threading.Lock()
_library = {"faces": {}, "index": None}
_library_lock = threading.Lock()


def stream_url(torrent_hash, file_id):
    query = urllib.parse.urlencode({"link": torrent_hash, "index": file_id, "play": ""})
    return f"{TORRSERVER_BASE}/stream/?{query}"


class Rejected(Exception):
    """A request for a file this service must not touch."""


class NotReady(Exception):
    """TorrServer has not loaded the torrent's file list yet."""


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


def numbers(stem):
    stem = re.sub(r"(?<=\d)v\d\b", "", NOISE_RE.sub(" ", stem), flags=re.IGNORECASE)  # 05v2 is episode 5
    return [int(value) for value in re.findall(r"\d+", stem)]


def name_shape(stem):
    return re.sub(r"\d+", "#", NOISE_RE.sub(" ", stem)).casefold()


def season(path):
    """The season a path names (`Season 2/`, `S02E01`, `2 сезон`), or None.
    The deepest mention wins: `Show S1-S3/Season 2/` is season 2."""
    found = [
        match for match in SEASON_RE.finditer(path)
        if not (match.group(0).endswith("-") and re.match(r"s?\d", path[match.end():], re.IGNORECASE))  # S1-S3
    ]
    return int(next(group for group in found[-1].groups() if group)) if found else None


def below_common(path, other_dir):
    """`path` without the folders it shares with `other_dir`: a torrent root
    such as `Show S1-S3/` names no season of its own."""
    parts, other = path.split("/"), other_dir.split("/") if other_dir else []
    shared = 0
    while shared < min(len(parts) - 1, len(other)) and parts[shared] == other[shared]:
        shared += 1
    return "/".join(parts[shared:])


def episode_numbers(items):
    """Map each file to its episode: the number position, counted from the
    end, that best tells these files apart. Files sharing a value (NCOP1 next
    to episode 1) are left out."""
    if len(items) < 2:
        return {}
    lists = {item["id"]: numbers(split_name(item["path"])[1]) for item in items}
    best, best_values = 0, {}
    for index in range(1, max(len(values) for values in lists.values()) + 1):
        values = {key: found[-index] for key, found in lists.items() if len(found) >= index}
        counts = {}
        for value in values.values():
            counts[value] = counts.get(value, 0) + 1
        unique = {key: value for key, value in values.items() if counts[value] == 1}
        if len(unique) > best:
            best, best_values = len(unique), unique
    return best_values if best >= 2 and best * 2 >= len(items) else {}


def named_after(stem, candidate_stem, longer_stems):
    """The label after `stem` when `candidate_stem` is named after it
    (`<stem>`, `<stem>.rus`, `<stem> [Dub]`), else None. `Shrek 2` is not
    `Shrek` with a label, and a longer video name that also fits wins."""
    match = re.match(re.escape(stem), candidate_stem, re.IGNORECASE)
    if not match:
        return None
    rest = candidate_stem[match.end():]
    if rest and (rest[0].isalnum() or re.match(r"[\s._-]*\d", CHANNELS_RE.sub(" ", NOISE_RE.sub(" ", rest)))):
        return None
    folded = candidate_stem.casefold()
    if any(folded.startswith(other) for other in longer_stems):
        return None
    return rest.strip(" ._-")


def external_candidates(files, video_id, extensions=AUDIO_EXTENSIONS):
    """Files for this video, folder by folder: files named after it; else, in
    a folder with one file per episode (of the video's season), the one with
    the video's episode number, else the one in the video's position. The only
    video of a torrent (a film) takes every file; a lone video among others
    only the files beside it. Named files sort first."""
    video = next((item for item in files if item["id"] == video_id), None)
    if not video:
        return []
    video_dir, video_stem, _ = split_name(video["path"])
    all_videos = [
        item for item in files
        if split_name(item["path"])[2] in VIDEO_EXTENSIONS and not re.search(r"(?:^|/)sample", item["path"], re.IGNORECASE)
    ]
    longer = [
        split_name(item["path"])[1].casefold() for item in all_videos
        if len(split_name(item["path"])[1]) > len(video_stem) and item["id"] != video_id
    ]
    folders = {}
    for item in files:
        directory, _, extension = split_name(item["path"])
        if extension in extensions:
            folders.setdefault(directory, []).append(item)
    videos = sorted((item for item in all_videos if split_name(item["path"])[0] == video_dir), key=lambda item: item["path"].casefold())
    # Extras (NCOP1, Trailer) are named differently; episodes share a shape.
    peers = [item for item in videos if name_shape(split_name(item["path"])[1]) == name_shape(video_stem)]
    if len(peers) < 2:
        peers = videos
    video_episodes = episode_numbers(peers)
    torrent_seasons = {season(item["path"]) for item in all_videos} - {None}
    skipped_here = SKIP_DIR_RE.search(video_dir)
    found = []  # (rule, item, label)
    for directory, items in folders.items():
        items.sort(key=lambda item: item["path"].casefold())
        video_season = season(below_common(video["path"], directory))
        folder_season = season(below_common(directory + "/", video_dir))
        if folder_season is not None and video_season is not None and folder_season != video_season:
            continue
        named = [(item, named_after(video_stem, split_name(item["path"])[1], longer)) for item in items]
        named = [(0, item, label) for item, label in named if label is not None]
        if named:
            found.extend(named)
            continue
        if SKIP_DIR_RE.search(directory) and not skipped_here:
            continue
        if folder_season is None and video_season not in (None, 1) and len(torrent_seasons) > 1:
            # Flat folders usually number episodes across seasons; trust
            # only files that name the video's season themselves.
            items = [item for item in items if season(split_name(item["path"])[1]) == video_season]
        if not items:
            continue
        if len(all_videos) == 1:
            found.extend((3, item, "") for item in items)
        elif len(videos) == 1:
            # A lone video among others (an OVA, a folder per episode)
            # takes only audio kept beside it.
            if directory == video_dir or directory.startswith(video_dir + "/"):
                found.extend((3, item, "") for item in items)
        elif episodes := episode_numbers(items):
            if video_id in video_episodes:
                found.extend((1, item, "") for item in items if episodes.get(item["id"]) == video_episodes[video_id])
        elif len(items) == len(peers) and video in peers:
            found.append((2, items[peers.index(video)], ""))
    candidates = []
    for rule, item, label in found:
        directory = split_name(item["path"])[0]
        if directory.startswith(video_dir + "/"):
            directory = directory[len(video_dir) + 1:]
        elif directory == video_dir:
            directory = ""
        candidates.append((rule, {
            "id": item["id"], "path": item["path"], "suffix": label,
            "location": " / ".join(part for part in (directory.replace("/", " / "), label) if part),
        }))
    candidates.sort(key=lambda pair: (pair[0], pair[1]["location"].casefold()))
    if len(candidates) > MAX_CANDIDATES:
        print(f"{len(candidates) - MAX_CANDIDATES} external candidates for {video['path']!r} not probed", file=sys.stderr, flush=True)
    return [candidate for _, candidate in candidates[:MAX_CANDIDATES]]


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


def subtitle_fonts(files, subtitle_path, video_path):
    """Fonts a release ships for its subtitles: next to or below the subtitle
    file, else in a fonts folder anywhere below the video."""
    def below(directory, root):
        return directory == root or directory.startswith(root + "/")
    fonts = [item for item in files if split_name(item["path"])[2] in FONT_EXTENSIONS]
    near = [item for item in fonts if below(split_name(item["path"])[0], split_name(subtitle_path)[0])]
    if not near:
        root = split_name(video_path)[0]
        near = [
            item for item in fonts
            if below(split_name(item["path"])[0], root) and FONT_DIR_RE.search(item["path"][len(root):])
        ]
    near = [item for item in near if 0 < item["length"] <= MAX_FONT_BYTES]
    return [item["id"] for item in sorted(near, key=lambda item: item["path"].casefold())[:MAX_FONTS]]


def external_subtitles(files, video_id):
    video = next((item for item in files if item["id"] == video_id), None)
    if not video:
        return []
    subtitles = []
    for candidate in external_candidates(files, video_id, SUBTITLE_EXTENSIONS):
        directory = split_name(candidate["path"])[0]
        subtitles.append({
            "file": candidate["id"],
            # A folder name is usually the group (`YakuSub Studio/`); a
            # suffix is usually a language (`<stem>.rus.ass`).
            "title": directory.rpartition("/")[2] or candidate["suffix"] or "ASS",
            "location": candidate["location"],
            "language": candidate["suffix"] if re.fullmatch(r"[a-z]{2,3}", candidate["suffix"], re.IGNORECASE) else "",
            "fonts": subtitle_fonts(files, candidate["path"], video["path"]),
        })
    return subtitles


def raw_path(torrent_hash, file_id):
    return os.path.join(CACHE_DIR, f"{torrent_hash}-{file_id}-raw", "data")


def fetch_raw(torrent_hash, file_id):
    """Download a subtitle or font file of this torrent into the cache and
    return its path. The caller holds a _raw_fetches slot."""
    path = raw_path(torrent_hash, file_id)
    if os.path.isfile(path):  # Another request fetched it meanwhile.
        return path
    try:
        files = torrent_files(torrent_hash)
    except urllib.error.HTTPError as error:
        error.close()
        raise Rejected("unknown torrent") from None
    item = next((item for item in files if item["id"] == file_id), None)
    extension = item and split_name(item["path"])[2]
    limit = MAX_SUBTITLE_BYTES if extension in SUBTITLE_EXTENSIONS else MAX_FONT_BYTES if extension in FONT_EXTENSIONS else 0
    if not limit or not 0 < item["length"] <= limit:
        raise Rejected("not a subtitle or font file of this torrent")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    partial = f"{path}.{os.getpid()}-{threading.get_ident()}.part"
    deadline = time.monotonic() + RAW_FETCH_SECONDS
    size = 0
    try:
        # Streamed to disk, so large fonts never sit in memory.
        with urllib.request.urlopen(stream_url(torrent_hash, file_id), timeout=10) as response, \
                open(partial, "wb") as target:
            while chunk := response.read(64 * 1024):
                size += len(chunk)
                if size > limit or time.monotonic() > deadline:
                    raise OSError("raw file too large or too slow")
                target.write(chunk)
        if size != item["length"]:
            raise OSError("raw file truncated")
        os.replace(partial, path)
    finally:
        try:
            os.unlink(partial)
        except FileNotFoundError:
            pass
    if extension in FONT_EXTENSIONS:
        keep_font(path)
    return path


def cached_probe(cache, key, command, parse, timeout=PROBE_TIMEOUT_SECONDS):
    with _probe_lock:
        if key in cache:
            return cache[key]
        if time.monotonic() - _probe_failures.get(key, -PROBE_RETRY_SECONDS) < PROBE_RETRY_SECONDS:
            raise ProbeFailed()
    try:
        result = subprocess.run(command, capture_output=True, timeout=timeout, check=True)
        value = parse(json.loads(result.stdout.decode("utf-8")))
    except subprocess.TimeoutExpired:
        raise  # A torrent that is still connecting is worth asking again.
    except (subprocess.SubprocessError, ValueError, OSError):
        with _probe_lock:
            if len(_probe_failures) >= MAX_PROBES_CACHED:
                _probe_failures.clear()
            _probe_failures[key] = time.monotonic()
        raise
    with _probe_lock:
        while len(cache) >= MAX_PROBES_CACHED:
            del cache[next(iter(cache))]  # the oldest; a playing file is probed again
        cache[key] = value
    return value


def audio_streams(probe):
    streams = probe.get("streams") or []
    for item in streams:
        # Matroska reports the duration on the container only.
        item["duration"] = float(item.get("duration") or (probe.get("format") or {}).get("duration") or 0)
    return streams


def probe_audio(torrent_hash, file_id, timeout=PROBE_TIMEOUT_SECONDS):
    command = [
        "ffprobe", "-v", "error", *INPUT_OPTIONS, "-select_streams", "a",
        "-show_entries", "stream=codec_name,channels,duration:stream_tags=title,language:format=duration",
        "-of", "json", stream_url(torrent_hash, file_id),
    ]
    return cached_probe(_probe_cache, (torrent_hash, file_id), command, audio_streams, timeout=timeout)


def probe_audio_soon(torrent_hash, file_id, wait=PROBE_TIMEOUT_SECONDS):
    """Streams of an audio file, or None when TorrServer has not fetched enough
    of it within `wait` seconds. The probe then carries on in the background,
    so a later lookup finds the result cached instead of starting over."""
    key = (torrent_hash, file_id)
    with _probe_lock:
        if key in _probe_cache:
            return _probe_cache[key]
        done = _probing.get(key)
        if done is None:
            done = _probing[key] = threading.Event()
            threading.Thread(target=probe_in_background, args=(torrent_hash, file_id, done), daemon=True).start()
    if not done.wait(max(0, wait)):
        return None
    with _probe_lock:
        if key in _probe_cache:
            return _probe_cache[key]
        if key in _probe_failures:
            raise ProbeFailed()
    return None  # the background probe timed out too; the next lookup starts another


def probe_in_background(torrent_hash, file_id, done):
    try:
        probe_audio(torrent_hash, file_id, timeout=PROBE_BACKGROUND_SECONDS)
    except Exception:  # failures are cached; a timeout is probed again on the next lookup
        pass
    finally:
        with _probe_lock:
            _probing.pop((torrent_hash, file_id), None)
        done.set()


def external_tracks(torrent_hash, video_id, files):
    """Tracks of the release's audio files, and whether some file could not be
    read in time because TorrServer has not fetched its head yet."""
    tracks = []
    unread = False
    candidates = external_candidates(files, video_id)
    # Every file's probe starts at once and they share one wait.
    for candidate in candidates:
        try:
            probe_audio_soon(torrent_hash, candidate["id"], wait=0)
        except (ProbeFailed, subprocess.SubprocessError, ValueError, OSError):
            pass
    deadline = time.monotonic() + PROBE_TIMEOUT_SECONDS
    for candidate in candidates:
        try:
            streams = probe_audio_soon(torrent_hash, candidate["id"], wait=deadline - time.monotonic())
        except (ProbeFailed, subprocess.SubprocessError, ValueError, OSError):
            continue
        if streams is None:
            unread = True
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
    return tracks, unread


def require_video_file(torrent_hash, file_id):
    try:
        files = torrent_files(torrent_hash)
    except urllib.error.HTTPError as error:
        error.close()
        raise Rejected("unknown torrent") from None
    if not files:
        raise NotReady()  # a torrent that just woke up is still fetching its metadata
    if not any(item["id"] == file_id and split_name(item["path"])[2] in VIDEO_EXTENSIONS for item in files):
        raise Rejected("not a video file of this torrent")


def embedded_info(probe):
    """Text subtitle streams in the order GST lists them, and font attachments."""
    subtitles, fonts, total, number = [], [], 0, 0
    for item in probe.get("streams") or []:
        tags = item.get("tags") or {}
        if item.get("codec_type") == "subtitle":
            if item.get("codec_name") in TEXT_SUBTITLE_CODECS:
                subtitles.append({
                    "stream": number, "codec": item["codec_name"],
                    "title": (tags.get("title") or "").strip(), "language": (tags.get("language") or "").strip(),
                })
            number += 1  # ffmpeg's 0:s:N counts image subtitles too
        elif item.get("codec_type") == "attachment" and isinstance(item.get("index"), int):
            size = int(item.get("extradata_size") or 0)
            font = split_name(tags.get("filename") or "")[2] in FONT_EXTENSIONS or \
                re.search(r"font|opentype|truetype", tags.get("mimetype") or "", re.IGNORECASE)
            if font and 0 < size <= MAX_FONT_BYTES and total + size <= MAX_EMBEDDED_FONT_BYTES:
                fonts.append(item["index"])
                total += size
    duration = float((probe.get("format") or {}).get("duration") or 0)
    return {"subtitles": subtitles, "fonts": fonts, "duration": duration}


def probe_embedded(torrent_hash, file_id):
    key = (torrent_hash, file_id, "embedded")
    with _probe_lock:
        known = key in _embedded_cache
    if not known:
        require_video_file(torrent_hash, file_id)
    command = [
        "ffprobe", "-v", "error", *INPUT_OPTIONS,
        "-show_entries", "stream=index,codec_type,codec_name,extradata_size:stream_tags=title,language,filename,mimetype"
        ":format=duration",
        "-of", "json", stream_url(torrent_hash, file_id),
    ]
    # A video that just started may need a while to fetch its header.
    return cached_probe(_embedded_cache, key, command, embedded_info, timeout=3 * PROBE_TIMEOUT_SECONDS)


def probed_embedded(torrent_hash, file_id):
    """The cached probe; events and fonts are served only for probed files."""
    with _probe_lock:
        return _embedded_cache.get((torrent_hash, file_id, "embedded"))


def attachment_path(torrent_hash, file_id, index):
    return os.path.join(CACHE_DIR, f"{torrent_hash}-{file_id}-att", str(index))


def fetch_attachment(torrent_hash, file_id, index):
    """Extract a font attachment of the video into the cache. The caller holds
    a _raw_fetches slot."""
    path = attachment_path(torrent_hash, file_id, index)
    if os.path.isfile(path):
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    partial = f"{path}.{os.getpid()}-{threading.get_ident()}.part"
    try:
        # Attachments live in the header; -t 0 reads no media.
        subprocess.run([
            "nice", "-n", "10", "ffmpeg", "-nostdin", "-v", "error", f"-dump_attachment:{index}", partial,
            *INPUT_OPTIONS, "-i", stream_url(torrent_hash, file_id), "-t", "0", "-f", "null", "-",
        ], capture_output=True, timeout=RAW_FETCH_SECONDS, check=True)
        if not 0 < os.path.getsize(partial) <= MAX_FONT_BYTES:
            raise OSError("attachment too large or empty")
        os.replace(partial, path)
    finally:
        try:
            os.unlink(partial)
        except FileNotFoundError:
            pass
    keep_font(path)
    return path


def font_faces(source):
    """Family names, weight, slant, Cyrillic coverage and glyph count of each
    face of a TrueType/OpenType font or collection in a seekable file; []
    for anything else. Reads only the tables it needs."""
    def read(offset, length):
        source.seek(offset)
        data = source.read(length)
        if len(data) != length:
            raise struct.error("truncated")
        return data
    try:
        tag = read(0, 4)
        if tag == b"ttcf":
            count = min(struct.unpack(">I", read(8, 4))[0], 64)
            starts = struct.unpack(f">{count}I", read(12, 4 * count))
        elif tag in (b"\x00\x01\x00\x00", b"OTTO", b"true"):
            starts = (0,)
        else:
            return []
        faces = []
        for start in starts:
            count = struct.unpack(">H", read(start + 4, 2))[0]
            directory = read(start + 12, 16 * count)
            tables = {}
            for number in range(count):
                tag, _, offset, length = struct.unpack_from(">4sIII", directory, 16 * number)
                tables[tag] = (offset, length)
            families = set()
            if b"name" in tables:
                offset, length = tables[b"name"]
                table = read(offset, min(length, 1024 * 1024))
                count, strings = struct.unpack_from(">HH", table, 2)
                for number in range(count):
                    platform, encoding, _, name, length, at = struct.unpack_from(">6H", table, 6 + 12 * number)
                    if name not in (1, 16) or (platform == 1 and encoding != 0):
                        continue
                    text = table[strings + at:strings + at + length]
                    families.add(text.decode("mac_roman" if platform == 1 else "utf-16-be", "replace").strip().lower())
            families.discard("")
            weight, italic, cyrillic, glyphs = 400, False, False, 0
            if b"OS/2" in tables:
                table = read(tables[b"OS/2"][0], 64)
                weight = struct.unpack_from(">H", table, 4)[0]
                cyrillic = bool(struct.unpack_from(">I", table, 42)[0] & 1 << 9)
                italic = bool(struct.unpack_from(">H", table, 62)[0] & 1)
            if b"maxp" in tables:
                glyphs = struct.unpack(">H", read(tables[b"maxp"][0] + 4, 2))[0]
            if families:
                faces.append({"families": sorted(families), "weight": weight, "italic": italic,
                              "cyrillic": cyrillic, "glyphs": glyphs})
        return faces
    except struct.error:
        return []


def keep_font(path):
    """Copy a font a release ships into the library, once per content."""
    if not FONT_LIBRARY_DIR:
        return
    try:
        with open(path, "rb") as source:
            data = source.read(MAX_FONT_BYTES + 1)
        faces = font_faces(io.BytesIO(data))
        if len(data) > MAX_FONT_BYTES or not any(face["glyphs"] >= MIN_LIBRARY_GLYPHS for face in faces):
            return
        extension = ".ttc" if data[:4] == b"ttcf" else ".otf" if data[:4] == b"OTTO" else ".ttf"
        target = os.path.join(FONT_LIBRARY_DIR, hashlib.sha256(data).hexdigest()[:32] + extension)
        if os.path.exists(target) or directory_size(FONT_LIBRARY_DIR) + len(data) > FONT_LIBRARY_MAX_BYTES:
            return
        partial = f"{target}.{os.getpid()}-{threading.get_ident()}.part"
        try:
            with open(partial, "wb") as output:
                output.write(data)
            os.replace(partial, target)
        finally:
            try:
                os.unlink(partial)
            except FileNotFoundError:
                pass
    except OSError as error:
        print(f"font library: {path} not kept: {error}", file=sys.stderr, flush=True)


def library_index():
    """JASSUB's availableFonts keys mapped to library files, and the files a
    style naming a family preloads."""
    # A file copied in by hand may change under the same name.
    files = {}
    try:
        for entry in os.scandir(FONT_LIBRARY_DIR) if FONT_LIBRARY_DIR else ():
            if LIBRARY_NAME_RE.match(entry.name) and entry.is_file():
                stat = entry.stat()
                files[entry.name] = (stat.st_size, stat.st_mtime_ns)
    except OSError as error:
        print(f"font library: {error}", file=sys.stderr, flush=True)
    with _library_lock:
        faces = _library["faces"]
        if _library["index"] is not None and files == {name: item[0] for name, item in faces.items()}:
            return _library["index"]
        for name in [name for name, item in faces.items() if files.get(name) != item[0]]:
            del faces[name]
        for name, stamp in files.items():
            if name in faces:
                continue
            found = []
            if stamp[0] <= MAX_FONT_BYTES:
                try:
                    with open(os.path.join(FONT_LIBRARY_DIR, name), "rb") as source:
                        found = font_faces(source)
                except OSError:
                    pass
            faces[name] = (stamp, [dict(face, size=stamp[0]) for face in found if face["glyphs"] >= MIN_LIBRARY_GLYPHS])
        candidates, family_names = {}, set()
        for name, (_, items) in faces.items():
            for face in items:
                weight = WEIGHT_NAMES[min(max(math.ceil(face["weight"] / 100) - 1, 0), len(WEIGHT_NAMES) - 1)]
                family_names.update(face["families"])
                for family in face["families"]:
                    # Upright before italic, then the weight closest to regular,
                    # Cyrillic before Latin-only, then the fullest version.
                    upright = not face["italic"]
                    candidates.setdefault(f"{family} {weight}", []).append((upright, 0, face["cyrillic"], face["size"], name))
                    candidates.setdefault(family, []).append(
                        (upright, -abs(face["weight"] - 400), face["cyrillic"], face["size"], name))
        fonts = {key: max(ranks)[-1] for key, ranks in candidates.items()}
        families = {family: list(dict.fromkeys((fonts[family], fonts.get(f"{family} bold", fonts[family])))) for family in family_names}
        _library["index"] = {"fonts": fonts, "families": families}
        return _library["index"]


class SubtitleRun:
    """One ffmpeg process copying a window of an embedded subtitle stream."""

    def __init__(self, process, start, end, path):
        self.process = process
        self.start = start
        self.end = end
        self.path = path
        self.began = time.monotonic()
        self.head = []  # header lines until the first event
        self.stopped = False

    def reach(self, now):
        """The furthest position the run can have read: its rate is bounded."""
        return self.start + SUB_BURST + SUB_READRATE * (now - self.began)


class SubtitleTrack:
    """Events of one embedded text stream, collected from the windows read so far.
    Viewers of one stream share it; two of them far apart take turns."""

    serials = time.time_ns() // 1000 % 10**8  # unique across restarts too

    def __init__(self, torrent_hash, file_id, stream, duration, codec="ass"):
        SubtitleTrack.serials += 1
        self.serial = SubtitleTrack.serials  # a recreated track restarts its line numbers
        self.source = stream_url(torrent_hash, file_id)
        self.stream = stream
        self.codec = codec
        self.duration = duration or math.inf
        self.directory = os.path.join(CACHE_DIR, f"{torrent_hash}-{file_id}-sub{stream}.tmp")
        self.header = None
        self.lines = []
        self.known = set()
        self.size = 0
        self.done = []  # covered (start, end) windows, merged
        self.run = None
        self.started = 0
        self.seen = time.monotonic()
        self.failures = 0
        self.failed_at = 0.0


def subtitle_command(source, output, stream, start, end, codec="ass"):
    # -copyts keeps the video's timeline. -readrate paces only mapped streams,
    # so the video is copied to nowhere: without it a stretch with no events
    # would be read at the torrent's full speed. Other text formats become ASS.
    return [
        "nice", "-n", "10", "ffmpeg", "-nostdin", "-v", "error", *INPUT_OPTIONS,
        "-reconnect", "1", "-reconnect_delay_max", "10",
        "-readrate", str(SUB_READRATE), "-readrate_initial_burst", str(SUB_BURST),
        "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}", "-copyts", "-i", source,
        "-map", f"0:s:{stream}", "-c:s", "copy" if codec in ASS_CODECS else "ass", "-ignore_readorder", "1", "-flush_packets", "1",
        "-f", "ass", output, "-map", "0:v:0?", "-c:v", "copy", "-f", "null", "-",
    ]


def covered_until(intervals, position):
    return next((end for start, end in intervals if start <= position <= end), None)


def add_covered(intervals, start, end):
    merged = []
    for first, last in sorted(intervals + [(start, end)]):
        if merged and first <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], last))
        else:
            merged.append((first, last))
    return merged


def next_window(track, position, now):
    """Where a run must start for playback at `position`, or None."""
    run = track.run
    end = covered_until(track.done, position)
    if end is not None:
        if end >= track.duration or end - position >= SUB_LEAD:
            return None
        if run and run.start <= end < run.end:
            return None  # the next window is on its way
        return end
    if run and run.start <= position < run.end and position <= run.reach(now) + SUB_BACK:
        return None
    start = max(0.0, position - SUB_BACK)
    return start if start < track.duration else None


def stop_subtitle_run(track):
    run, track.run = track.run, None
    run.stopped = True
    if run.process.poll() is None:
        run.process.kill()


def start_subtitle_run(track, start, now):
    """Replace the track's run with one from `start`. The caller holds
    _subs_lock. Return False while every slot serves a recent viewer."""
    others = [other for other in _subs.values() if other.run and other is not track]
    if len(others) >= MAX_SUB_RUNS:
        oldest = min(others, key=lambda other: other.seen)
        if now - oldest.seen < STALE_SECONDS:
            return False
        stop_subtitle_run(oldest)
    if track.run:
        stop_subtitle_run(track)
    end = min(start + SUB_WINDOW, track.duration)
    os.makedirs(track.directory, exist_ok=True)
    path = os.path.join(track.directory, f"run{track.started}.ass")
    track.started += 1
    with open(f"{path}.log", "wb") as log:
        process = subprocess.Popen(
            subtitle_command(track.source, path, track.stream, start, end, track.codec), stdout=subprocess.DEVNULL, stderr=log,
        )
    track.run = run = SubtitleRun(process, start, end, path)
    threading.Thread(target=watch_subtitle_run, args=(track, run), daemon=True).start()
    return True


def end_header(track, run):
    if run.head is not None and track.header is None:
        if track.codec not in ASS_CODECS:
            track.header = CONVERTED_HEADER
        elif any(line.strip() == "[Events]" for line in run.head):
            track.header = "\n".join(run.head).strip() + "\n"
    run.head = None


def take_lines(track, run, chunks, finished):
    with _subs_lock:
        for chunk in chunks:
            line = chunk.decode("utf-8", "replace").rstrip("\r")
            if line.startswith("Dialogue:"):
                end_header(track, run)
                # Windows overlap; the same event arrives again.
                if line not in track.known and track.size < MAX_SUBTITLE_BYTES:
                    track.known.add(line)
                    track.lines.append(line)
                    track.size += len(line)
            elif run.head is not None:
                run.head.append(line)
        if finished:
            end_header(track, run)


def watch_subtitle_run(track, run):
    process = run.process
    pending = b""
    source = None
    try:
        while True:
            finished = process.poll() is not None
            if source is None and os.path.exists(run.path):
                source = open(run.path, "rb")
            if source is not None:
                *complete, pending = (pending + source.read()).split(b"\n")
                if finished and pending:
                    complete.append(pending)
                take_lines(track, run, complete, finished)
            if finished:
                break
            with _subs_lock:
                if track.run is run and time.monotonic() - track.seen > SUB_IDLE_SECONDS:
                    stop_subtitle_run(track)  # nobody plays this any more
            time.sleep(0.5)
        now = time.monotonic()
        # A dropped connection can end ffmpeg cleanly before the window ends;
        # other demuxer complaints (odd Matroska elements) still play fine.
        with open(f"{run.path}.log", "rb") as log:
            detail = log.read()
        complete = process.returncode == 0 and not READ_FAILURE_RE.search(detail)
        with _subs_lock:
            if track.run is run:
                track.run = None
                if complete:
                    track.done = add_covered(track.done, run.start, run.end)
                    track.failures = 0
                else:
                    track.failures += 1
                    track.failed_at = now
        if (detail or not complete) and not run.stopped:
            print(f"subtitles {track.directory} ended {process.returncode}: {detail[-500:].decode('utf-8', 'replace')}",
                  file=sys.stderr, flush=True)
    except Exception as error:
        print(f"subtitles {track.directory} failed: {type(error).__name__} {error}", file=sys.stderr, flush=True)
        if process.poll() is None:
            process.kill()
            process.wait()
        with _subs_lock:
            if track.run is run:
                track.run = None
    finally:
        if source is not None:
            source.close()
        for path in (run.path, f"{run.path}.log"):
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass


def forget_subtitles(now):
    """Drop collected events nobody asked for lately. The caller holds _subs_lock."""
    idle = sorted((track.seen, key) for key, track in _subs.items() if track.run is None)
    for seen, key in idle:
        if now - seen > SUB_FORGET_SECONDS or len(_subs) >= MAX_SUB_TRACKS:
            shutil.rmtree(_subs.pop(key).directory, ignore_errors=True)


def subtitle_events(torrent_hash, file_id, stream, position, offset, serial=None):
    """Events collected so far from `offset` on; starts reading where playback is."""
    info = probed_embedded(torrent_hash, file_id)
    codec = next((item["codec"] for item in (info or {}).get("subtitles", []) if item["stream"] == stream), None)
    if codec is None:
        raise Rejected("not a text subtitle stream of a probed video")
    key = (torrent_hash, file_id, stream)
    now = time.monotonic()
    busy = False
    with _subs_lock:
        track = _subs.get(key)
        if track is None:
            forget_subtitles(now)
            track = _subs[key] = SubtitleTrack(torrent_hash, file_id, stream, info["duration"], codec)
        track.seen = now
        if now - track.failed_at > FAILURE_RESET_SECONDS:
            track.failures = 0
        start = next_window(track, position, now) if position is not None else None
        if start is not None and track.failures < MAX_FAILURES and now >= track.failed_at + 2 * track.failures:
            try:
                busy = not start_subtitle_run(track, start, now)
            except OSError as error:
                print(f"subtitles {track.directory} failed to start: {error}", file=sys.stderr, flush=True)
                track.failures += 1
                track.failed_at = now
        if serial != track.serial or offset > len(track.lines):
            offset = 0  # the events were forgotten meanwhile; the client deduplicates
        lines = track.lines[offset:offset + MAX_SUB_LINES]
        return {
            "track": track.serial,
            "header": track.header if offset == 0 else None,
            "lines": lines,
            "next": offset + len(lines),
            "more": offset + len(lines) < len(track.lines),
            "busy": busy,
            "failed": track.failures >= MAX_FAILURES or (track.header is None and bool(track.lines)),
        }


def rendition_dir(torrent_hash, file_id, stream, mode):
    return os.path.join(CACHE_DIR, f"{torrent_hash}-{file_id}-{stream}-{mode}")


def rendition_ready(torrent_hash, file_id, stream, mode):
    final = rendition_dir(torrent_hash, file_id, stream, mode)
    if not os.path.isfile(os.path.join(final, "audio.m3u8")):
        return False
    try:
        os.utime(final)
    except OSError:
        pass
    return True


class Run:
    """One ffmpeg process encoding a rendition from `start` onwards."""

    def __init__(self, process, start, warmup, requested):
        self.process = process
        self.start = self.head = start
        self.warmup = warmup
        self.paused = False
        self.requested = requested
        self.seen = time.monotonic()

    def owns(self, index):
        """Whether a request for `index` belongs to this run's viewer."""
        first = self.start + 1 if self.warmup == self.start else self.start
        return first <= index <= self.head + LIVE_REACH

    def covers(self, index):
        """Whether this run will still write segment `index`. A missing segment
        behind the head (dropped warm-up, evicted) will not come."""
        return self.owns(index) and index >= self.head


class LiveRendition:
    """An AAC rendition encoded from playback positions on demand."""

    def __init__(self, torrent_hash, file_id, stream, info):
        self.source = stream_url(torrent_hash, file_id)
        self.stream = stream
        self.channels = info.get("channels") or 2
        self.count = math.ceil(info["duration"] * SAMPLE_RATE / SEGMENT_SAMPLES)
        self.directory = rendition_dir(torrent_hash, file_id, stream, "aac")
        self.runs = []
        self.requested = 0
        self.seen = time.monotonic()
        self.started = 0
        self.failures = 0
        self.failed_at = 0.0

    def owner(self, index):
        """The run serving `index` (any run for init.mp4), most recent first."""
        runs = [run for run in self.runs if index is None or run.owns(index)]
        return max(runs, key=lambda run: run.seen) if runs else None


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
        "-c:a", "aac", "-ar", str(SAMPLE_RATE), "-b:a", "384k" if channels > 2 else "256k",
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


def stop_run(rendition, run):
    if run in rendition.runs:
        rendition.runs.remove(run)
    run.paused = False
    if run.process.poll() is None:
        run.process.send_signal(signal.SIGCONT)
        run.process.kill()


def running():
    return [(rendition, run) for rendition in _live.values() for run in rendition.runs]


def start_run(rendition, index):
    """Start encoding at `index` and return the run, or None without a free
    slot. The caller holds _live_changed."""
    victim = None
    if len(rendition.runs) >= RUNS_PER_RENDITION:
        # A paused run belongs to a viewer with a full buffer; a run still
        # building its lead is usually a position someone just seeked away from.
        victim = min(rendition.runs, key=lambda run: (run.paused, run.seen))
    active = [pair for pair in running() if not pair[1].paused and pair[1] is not victim]
    stale = None
    if len(active) >= MAX_ACTIVE_RUNS:
        # A run nobody asked for lately (a track switched away from, a
        # position seeked away from) yields its slot.
        stale = min(active, key=lambda pair: pair[1].seen)
        if time.monotonic() - stale[1].seen < STALE_SECONDS:
            return None
    # Stop runs only once the new one is sure to start.
    if victim is not None:
        stop_run(rendition, victim)
    if stale is not None:
        stop_run(*stale)
    pairs = running()
    if len(pairs) >= MAX_RUNS:
        stop_run(*min(pairs, key=lambda pair: (not pair[1].paused, pair[1].seen)))
    # The first segment of a run starts with the encoder's priming frame, so
    # a run starts one segment early and drops it.
    start = max(index - 1, 0)
    run_dir = f"{rendition.directory}.run{rendition.started}.tmp"
    rendition.started += 1
    shutil.rmtree(run_dir, ignore_errors=True)
    os.makedirs(run_dir)
    log = open(os.path.join(run_dir, "ffmpeg.log"), "wb")
    try:
        process = subprocess.Popen(
            live_command(rendition.source, run_dir, rendition.stream, rendition.channels, start, rendition.count),
            stdout=subprocess.DEVNULL, stderr=log,
        )
    except OSError:
        shutil.rmtree(run_dir, ignore_errors=True)
        raise
    finally:
        log.close()
    run = Run(process, start, start if index > 0 else None, index)
    rendition.runs.append(run)
    threading.Thread(target=watch_run, args=(rendition, run, run_dir), daemon=True).start()
    return run


def collect_segments(rendition, run, run_dir):
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
        if index != run.warmup and not os.path.isfile(target):
            with open(path, "rb") as source:
                write_atomically(target, with_decode_time(source.read(), index))
        os.remove(path)
        with _live_changed:
            run.head = max(run.head, index + 1)
            if run in rendition.runs:
                rendition.failures = 0
            _live_changed.notify_all()


def watch_run(rendition, run, run_dir):
    process = run.process
    try:
        while True:
            finished = process.poll() is not None
            collect_segments(rendition, run, run_dir)
            if finished:
                break
            with _live_changed:
                if run in rendition.runs:
                    idle = time.monotonic() - run.seen
                    if idle > ABANDON_SECONDS or (idle > STALE_SECONDS and len(rendition.runs) > 1):
                        # Nobody watches here any more, or a seek left this run behind.
                        stop_run(rendition, run)
                    elif not run.paused and run.head - run.requested > LIVE_AHEAD:
                        # Stop reading the torrent until playback catches up.
                        process.send_signal(signal.SIGSTOP)
                        run.paused = True
                        _live_changed.notify_all()
            time.sleep(0.25)
        with _live_changed:
            # A dropped connection can also end ffmpeg cleanly, before the grid ends.
            failed = process.returncode != -signal.SIGKILL and run.head < rendition.count
            if failed and run in rendition.runs:
                rendition.failures += 1
                rendition.failed_at = time.monotonic()
        if failed:
            with open(os.path.join(run_dir, "ffmpeg.log"), "rb") as log:
                detail = log.read()[-500:].decode("utf-8", "replace")
            print(f"live encode {rendition.directory} stopped early: {process.returncode} {detail}", file=sys.stderr, flush=True)
    except Exception as error:
        if run in rendition.runs:  # A stopped run may lose its directory.
            print(f"live encode {rendition.directory} failed: {type(error).__name__} {error}", file=sys.stderr, flush=True)
        if process.poll() is None:
            process.send_signal(signal.SIGCONT)
            process.kill()
    finally:
        with _live_changed:
            if run in rendition.runs:
                rendition.runs.remove(run)
            _live_changed.notify_all()
        shutil.rmtree(run_dir, ignore_errors=True)


def live_file(rendition, index, wait):
    """Wait until segment `index` (None for init.mp4) exists, encoding it if
    needed. Return False on timeout and None when encoding keeps failing."""
    name = "init.mp4" if index is None else f"s{index}.m4s"
    path = os.path.join(rendition.directory, name)
    deadline = time.monotonic() + wait
    started = False
    with _live_changed:
        rendition.seen = time.monotonic()
        if index is not None:
            rendition.requested = index
        target = rendition.requested if index is None else index
        while True:
            now = time.monotonic()
            exists = os.path.isfile(path)
            run = rendition.owner(index)
            if run is not None:
                run.seen = now
                if index is not None:
                    run.requested = index
                # Resume in batches once playback has used half of the lead,
                # or at once when the file is missing (init.mp4 after eviction).
                if run.paused and (not exists or (index is not None and run.head - index <= LIVE_AHEAD // 2)):
                    run.process.send_signal(signal.SIGCONT)
                    run.paused = False
            if exists:
                return True
            if now - rendition.failed_at > FAILURE_RESET_SECONDS:
                rendition.failures = 0
            if rendition.failures >= MAX_FAILURES:
                return None
            covered = run is not None and (index is None or run.covers(index))
            # Each request starts at most one run, so waiting requests (a seek
            # hls.js abandoned, another viewer) never take turns replacing runs.
            if not covered and not started and now >= rendition.failed_at + 2 * rendition.failures:
                try:
                    started = start_run(rendition, target) is not None
                except OSError as error:
                    print(f"live encode {rendition.directory} failed to start: {error}", file=sys.stderr, flush=True)
                    rendition.failures += 1
                    rendition.failed_at = now
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            _live_changed.wait(min(remaining, 1))


def directory_size(path):
    total = 0
    for entry in os.scandir(path):
        try:
            if entry.is_file():
                total += entry.stat().st_size
        except FileNotFoundError:
            pass  # another thread renamed its partial file meanwhile
    return total


def evict(now=None):
    now = now or time.time()
    entries = []
    for name in os.listdir(CACHE_DIR):
        path = os.path.join(CACHE_DIR, name)
        if name.endswith(".tmp"):
            continue
        try:  # Another eviction may remove a directory meanwhile.
            entries.append((os.stat(path).st_mtime, directory_size(path), path))
        except (FileNotFoundError, NotADirectoryError):
            continue
    total = sum(size for _, size, _ in entries)
    for modified, size, path in sorted(entries):
        if now - modified <= CACHE_TTL_SECONDS and total <= CACHE_MAX_BYTES:
            break
        shutil.rmtree(path, ignore_errors=True)
        total -= size


def evict_safely():
    try:
        evict()
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
        try:
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # hls.js aborts requests on every seek; that is not an error.
            self.close_connection = True

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

    def serve_raw(self, torrent_hash, file_id):
        path = raw_path(torrent_hash, file_id)
        if not os.path.isfile(path):  # Only checked files are ever cached.
            # JASSUB asks for every font at once and never retries, so wait
            # for a download slot instead of refusing.
            if not _raw_fetches.acquire(timeout=RAW_FETCH_SECONDS):
                return self.send_json(503, {"error": "busy"}, {"Retry-After": "2"})
            try:
                path = fetch_raw(torrent_hash, file_id)
            except Rejected:
                return self.send_json(404, {"error": "not found"})
            except Exception as error:
                print(f"raw {torrent_hash}/{file_id} failed: {type(error).__name__} {error}", file=sys.stderr, flush=True)
                return self.send_json(502, {"error": "fetch failed"})
            finally:
                _raw_fetches.release()
        self.send_cached(path)

    def send_cached(self, path):
        try:
            source = open(path, "rb")
        except FileNotFoundError:  # Evicted meanwhile; the client asks again.
            return self.send_json(503, {"error": "busy"}, {"Retry-After": "1"})
        with source:
            self.send_response(200)
            # Bytes as stored: the plugin detects the subtitle encoding itself.
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(os.fstat(source.fileno()).st_size))
            self.send_header("Cache-Control", "private, max-age=86400")
            self.send_header("X-Content-Type-Options", "nosniff")
            try:
                self.end_headers()
                shutil.copyfileobj(source, self.wfile, 64 * 1024)
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True

    def serve_embedded(self, torrent_hash, file_id, match, query):
        if match.group(3):
            if not _track_lookups.acquire(blocking=False):
                return self.send_json(429, {"error": "busy"}, {"Retry-After": "5"})
            try:
                info = probe_embedded(torrent_hash, file_id)
            except NotReady:
                return self.send_json(503, {"error": "preparing"}, {"Retry-After": "3"})
            except Rejected:
                return self.send_json(404, {"error": "not found"})
            except Exception:
                return self.send_json(502, {"error": "probe failed"})
            finally:
                _track_lookups.release()
            return self.send_json(200, {
                "subtitles": info["subtitles"], "fonts": info["fonts"],
                "renderer": "/extaudio/jassub/" if os.path.isfile(os.path.join(RENDERER_DIR, "jassub.js")) else None,
            })
        if not probed_embedded(torrent_hash, file_id):
            # A restart or a full cache forgot the probe of a playing file.
            if not _track_lookups.acquire(blocking=False):
                return self.send_json(429, {"error": "busy"}, {"Retry-After": "5"})
            try:
                probe_embedded(torrent_hash, file_id)
            except NotReady:
                return self.send_json(503, {"error": "preparing"}, {"Retry-After": "3"})
            except Rejected:
                return self.send_json(404, {"error": "not found"})
            except Exception:
                return self.send_json(502, {"error": "probe failed"})
            finally:
                _track_lookups.release()
        if match.group(4):
            position = query.get("at", [""])[0]
            offset = query.get("from", ["0"])[0]
            serial = query.get("track", [""])[0]
            if not re.fullmatch(r"\d{1,7}", offset) or (position and not re.fullmatch(r"\d{1,6}(?:\.\d{1,3})?", position)) \
                    or (serial and not re.fullmatch(r"\d{1,9}", serial)):
                return self.send_json(400, {"error": "bad position"})
            try:
                payload = subtitle_events(
                    torrent_hash, file_id, int(match.group(4)), float(position) if position else None, int(offset),
                    int(serial) if serial else None,
                )
            except Rejected:
                return self.send_json(404, {"error": "not found"})
            return self.send_json(200, payload)
        index = int(match.group(5))
        info = probed_embedded(torrent_hash, file_id)
        if not info or index not in info["fonts"]:
            return self.send_json(404, {"error": "not found"})
        path = attachment_path(torrent_hash, file_id, index)
        if not os.path.isfile(path):
            if not _raw_fetches.acquire(timeout=RAW_FETCH_SECONDS):
                return self.send_json(503, {"error": "busy"}, {"Retry-After": "2"})
            try:
                path = fetch_attachment(torrent_hash, file_id, index)
            except Exception as error:
                print(f"attachment {torrent_hash}/{file_id}/{index} failed: {type(error).__name__} {error}", file=sys.stderr, flush=True)
                return self.send_json(502, {"error": "extract failed"})
            finally:
                _raw_fetches.release()
        self.send_cached(path)

    def serve_renderer(self, name):
        try:
            with open(os.path.join(RENDERER_DIR, name), "rb") as source:
                body = source.read()
        except FileNotFoundError:
            return self.send_json(404, {"error": "not found"})
        self.send_bytes(200, body, RENDERER_TYPES[os.path.splitext(name)[1]], "public, max-age=86400")

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
                    if rendition.owner(index) is None:
                        try:
                            start_run(rendition, index)
                        except OSError as error:
                            # The segment request retries; the playlist is still valid.
                            print(f"live encode {rendition.directory} failed to start: {error}", file=sys.stderr, flush=True)
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
        renderer = RENDERER_RE.match(path)
        if renderer:
            return self.serve_renderer(renderer.group(1))
        fonts = FONTS_RE.match(path)
        if fonts:
            if fonts.group(1):
                return self.send_json(200, library_index())
            path = os.path.join(FONT_LIBRARY_DIR, fonts.group(2))
            if not FONT_LIBRARY_DIR or not os.path.isfile(path):
                return self.send_json(404, {"error": "not found"})
            return self.send_cached(path)
        embedded = EMBEDDED_RE.match(path)
        if embedded:
            return self.serve_embedded(embedded.group(1).lower(), int(embedded.group(2)), embedded, query)
        match = ROUTE_RE.match(path)
        if not match:
            return self.send_json(404, {"error": "not found"})
        torrent_hash, file_id = match.group(1).lower(), int(match.group(2))
        if match.group(3) == "raw":
            return self.serve_raw(torrent_hash, file_id)
        if match.group(3):
            if not _track_lookups.acquire(blocking=False):
                return self.send_json(429, {"error": "busy"}, {"Retry-After": "5"})
            try:
                files = torrent_files(torrent_hash)
                tracks, pending = external_tracks(torrent_hash, file_id, files)
                return self.send_json(200, {
                    "tracks": tracks,
                    # The player asks again for the files not read yet.
                    "pending": pending,
                    "subtitles": external_subtitles(files, file_id),
                    "renderer": "/extaudio/jassub/" if os.path.isfile(os.path.join(RENDERER_DIR, "jassub.js")) else None,
                })
            except urllib.error.HTTPError as error:
                error.close()
                return self.send_json(404 if error.code == 404 else 502, {"error": "track lookup failed"})
            except Exception:
                return self.send_json(502, {"error": "track lookup failed"})
            finally:
                _track_lookups.release()
        stream, name = int(match.group(4)), match.group(6)
        if not FILE_RE.match(name):
            return self.send_json(404, {"error": "not found"})
        return self.serve_live(torrent_hash, file_id, stream, name, query)


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
