import json
import os
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest import mock

import app


HASH = "bc7b45c4c8a2d77469f8569dac92bb11d6821e52"
FILES = [
    {"id": 1, "path": "Show [WEBRip]/Sound/Show - 01 (WEBRip).mka"},
    {"id": 2, "path": "Show [WEBRip]/Sound/Show - 02 (WEBRip).mka"},
    {"id": 13, "path": "Show [WEBRip]/Show - 01 (WEBRip).mkv"},
    {"id": 14, "path": "Show [WEBRip]/Show - 02 (WEBRip).mkv"},
    {"id": 20, "path": "Show [WEBRip]/Show - 01 (WEBRip).Studio Band.ac3"},
    {"id": 21, "path": "Show [WEBRip]/Subs/Show - 01 (WEBRip).ass"},
    {"id": 22, "path": "Show [WEBRip]/Sound/Show - 010 (WEBRip).mka"},
]


class CandidateTests(unittest.TestCase):
    def test_matches_audio_files_named_after_the_video(self):
        self.assertEqual(app.external_candidates(FILES, 13), [
            {"id": 1, "location": "Sound"},
            {"id": 20, "location": "Studio Band"},
        ])

    def test_unknown_video_has_no_candidates(self):
        self.assertEqual(app.external_candidates(FILES, 99), [])

    def test_tracks_use_stream_metadata_and_skip_unreadable_files(self):
        def probe(torrent_hash, file_id):
            if file_id == 20:
                raise subprocess.CalledProcessError(1, "ffprobe")
            return [{"codec_name": "aac", "channels": 2, "tags": {"title": "AniLibria.tv", "language": "rus"}}]

        with mock.patch.object(app, "torrent_files", return_value=FILES), \
                mock.patch.object(app, "probe_audio", side_effect=probe):
            self.assertEqual(app.external_tracks(HASH, 13), [{
                "file": 1, "stream": 0, "title": "AniLibria.tv", "location": "Sound",
                "language": "rus", "codec": "aac", "channels": 2,
            }])


class RemuxTests(unittest.TestCase):
    def test_aac_is_copied_at_low_priority(self):
        for mode in ("copy", "aac"):
            command = app.remux_command("src", "/out", 1, "aac", 2, mode)
            self.assertEqual(command[:4], ["nice", "-n", "10", "ffmpeg"])
            self.assertIn("0:a:1", command)
            self.assertEqual(command[command.index("-c:a") + 1], "copy")

    def test_other_codecs_are_encoded_to_aac(self):
        command = app.remux_command("src", "/out", 0, "ac3", 6, "aac")
        self.assertEqual(command[command.index("-c:a") + 1:command.index("-c:a") + 4], ["aac", "-b:a", "384k"])

    def test_browser_codecs_are_copied_on_request(self):
        for codec in ("opus", "ac3", "eac3"):
            command = app.remux_command("src", "/out", 0, codec, 6, "copy")
            self.assertEqual(command[command.index("-c:a") + 1], "copy")
        with self.assertRaises(ValueError):
            app.remux_command("src", "/out", 0, "dts", 6, "copy")

    def test_inputs_cannot_be_playlists(self):
        command = app.remux_command("src", "/out", 0, "aac", 2, "copy")
        formats = command[command.index("-format_whitelist") + 1].split(",")
        self.assertNotIn("hls", formats)
        self.assertNotIn("concat", formats)
        self.assertEqual(command[command.index("-protocol_whitelist") + 1], "http,tcp")
        self.assertLess(command.index("-format_whitelist"), command.index("-i"))

    def test_timeout_grows_with_file_size(self):
        self.assertEqual(app.job_timeout(0), app.JOB_BASE_SECONDS)
        self.assertEqual(app.job_timeout(1024 ** 3), app.JOB_BASE_SECONDS + 1024 ** 3 // app.MIN_SOURCE_RATE)
        self.assertEqual(app.job_timeout(1024 ** 4), app.JOB_MAX_SECONDS)

    def test_abandoned_job_stops_ffmpeg(self):
        job = {"timeout": 60, "seen": time.monotonic() - app.ABANDON_SECONDS - 1}
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            app.run_command(["sleep", "30"], job)
        self.assertLess(time.monotonic() - started, 15)

    def test_failed_command_reports_stderr(self):
        job = {"timeout": 60, "seen": time.monotonic()}
        with self.assertRaises(subprocess.CalledProcessError) as raised:
            app.run_command(["sh", "-c", "echo broken >&2; exit 3"], job)
        self.assertEqual(raised.exception.stderr, b"broken\n")


class ProbeTests(unittest.TestCase):
    def setUp(self):
        app._probe_cache.clear()
        app._probe_failures.clear()

    def test_failed_probe_is_not_retried_immediately(self):
        with mock.patch.object(app.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "ffprobe")) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                app.probe_audio(HASH, 1)
            with self.assertRaises(app.ProbeFailed):
                app.probe_audio(HASH, 1)
        self.assertEqual(run.call_count, 1)
        self.assertIn("-format_whitelist", run.call_args.args[0])

    def test_probe_timeouts_are_retried(self):
        with mock.patch.object(app.subprocess, "run", side_effect=subprocess.TimeoutExpired("ffprobe", 10)) as run:
            for _ in range(2):
                with self.assertRaises(subprocess.TimeoutExpired):
                    app.probe_audio(HASH, 1)
        self.assertEqual(run.call_count, 2)


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        patcher = mock.patch.object(app, "CACHE_DIR", self.directory.name)
        patcher.start()
        self.addCleanup(patcher.stop)

    def rendition(self, name, size, age):
        path = os.path.join(self.directory.name, name)
        os.makedirs(path)
        with open(os.path.join(path, "audio.m3u8"), "wb") as playlist:
            playlist.write(b"x" * size)
        modified = time.time() - age
        os.utime(path, (modified, modified))
        return path

    def test_evicts_oldest_over_size_and_expired(self):
        expired = self.rendition("expired", 10, app.CACHE_TTL_SECONDS + 60)
        old = self.rendition("old", 60, 120)
        recent = self.rendition("recent", 60, 60)
        with mock.patch.object(app, "CACHE_MAX_BYTES", 100):
            app.evict()
        self.assertFalse(os.path.exists(expired))
        self.assertFalse(os.path.exists(old))
        self.assertTrue(os.path.exists(recent))

    def test_concurrent_requests_share_one_job(self):
        started = []
        release = threading.Event()

        def run_job(torrent_hash, file_id, stream, mode, job):
            started.append((torrent_hash, file_id, stream, mode))
            release.wait(5)
            os.makedirs(app.rendition_dir(torrent_hash, file_id, stream, mode))
            open(os.path.join(app.rendition_dir(torrent_hash, file_id, stream, mode), "audio.m3u8"), "w").close()
            job["done"].set()
            with app._jobs_lock:
                app._jobs.pop((torrent_hash, file_id, stream, mode), None)

        with mock.patch.object(app, "run_job", side_effect=run_job):
            self.assertEqual(app.ensure_rendition(HASH, 1, 0, "copy", 0), (False, None))
            self.assertEqual(app.ensure_rendition(HASH, 1, 0, "copy", 0), (False, None))
            release.set()
            self.assertEqual(app.ensure_rendition(HASH, 1, 0, "copy", 5), (True, None))
        self.assertEqual(started, [(HASH, 1, 0, "copy")])

    def test_new_job_is_seen_before_its_thread_starts(self):
        jobs = []
        with mock.patch.object(app.threading, "Thread") as thread:
            thread.side_effect = lambda target, args, daemon: jobs.append(dict(args[-1])) or mock.Mock()
            app.ensure_rendition(HASH, 1, 0, "copy", 0)
        with app._jobs_lock:
            app._jobs.clear()
        self.assertIn("seen", jobs[0])

    def test_failed_job_is_reported(self):
        with mock.patch.object(app, "probe_audio", return_value=[]):
            self.assertEqual(app.ensure_rendition(HASH, 1, 0, "copy", 5), (False, "remux failed"))
        self.assertEqual(os.listdir(self.directory.name), [])

    def test_queue_is_bounded(self):
        release = threading.Event()

        def run_job(torrent_hash, file_id, stream, mode, job):
            release.wait(5)
            job["done"].set()
            with app._jobs_lock:
                app._jobs.pop((torrent_hash, file_id, stream, mode), None)

        with mock.patch.object(app, "run_job", side_effect=run_job):
            for file_id in range(app.MAX_JOBS):
                self.assertEqual(app.ensure_rendition(HASH, file_id, 0, "aac", 0), (False, None))
            self.assertEqual(app.ensure_rendition(HASH, 99, 0, "aac", 0), (False, "busy"))
            release.set()

    def test_job_skips_a_rendition_finished_meanwhile(self):
        directory = app.rendition_dir(HASH, 1, 0, "copy")
        os.makedirs(directory)
        open(os.path.join(directory, "audio.m3u8"), "w").close()
        job = {"done": threading.Event(), "error": None, "seen": time.monotonic(), "timeout": 60}
        with mock.patch.object(app, "probe_audio") as probe:
            app.run_job(HASH, 1, 0, "copy", job)
        probe.assert_not_called()
        self.assertEqual(job["error"], None)

    def test_abandoned_queued_job_does_not_start(self):
        job = {"done": threading.Event(), "error": None, "seen": time.monotonic() - app.ABANDON_SECONDS - 1, "timeout": 60}
        with mock.patch.object(app, "probe_audio") as probe:
            app.run_job(HASH, 1, 0, "copy", job)
        probe.assert_not_called()
        self.assertEqual(job["error"], "remux failed")

    def test_eviction_failure_does_not_fail_a_finished_job(self):
        def remux(command, job):
            open(os.path.join(command[-1]), "w").close()

        job = {"done": threading.Event(), "error": None, "seen": time.monotonic(), "timeout": 60}
        with mock.patch.object(app, "probe_audio", return_value=[{"codec_name": "aac", "channels": 2}]), \
                mock.patch.object(app, "run_command", side_effect=remux), \
                mock.patch.object(app, "evict", side_effect=FileNotFoundError("gone")):
            app.run_job(HASH, 1, 0, "copy", job)
        self.assertEqual(job["error"], None)
        self.assertTrue(app.rendition_ready(HASH, 1, 0, "copy"))

    def test_eviction_skips_directories_removed_meanwhile(self):
        self.rendition("kept", 10, 0)
        real_size = app.directory_size

        def vanishing(path):
            if path.endswith("kept"):
                raise FileNotFoundError(path)
            return real_size(path)

        with mock.patch.object(app, "directory_size", side_effect=vanishing):
            app.evict()

    def test_new_rendition_survives_its_own_eviction(self):
        new = self.rendition("new", 200, 0)
        with mock.patch.object(app, "CACHE_MAX_BYTES", 100):
            app.evict(keep=new)
        self.assertTrue(os.path.exists(new))


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        patcher = mock.patch.object(app, "CACHE_DIR", self.directory.name)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path, timeout=5) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            with error:
                return error.code, error.headers, error.read()

    def test_rejects_paths_outside_the_rendition(self):
        for path in (
            f"/extaudio/{HASH}/1/0/copy/..%2F..%2Fetc%2Fpasswd",
            f"/extaudio/{HASH}/1/0/copy/other.txt",
            f"/extaudio/{HASH}/1/0/flac/audio.m3u8",
            f"/extaudio/{HASH}/1/0/audio.m3u8",
            "/extaudio/not-a-hash/1/tracks",
            f"/extaudio/{HASH}/1/0/copy/../tracks",
        ):
            with self.subTest(path=path):
                self.assertEqual(self.get(path)[0], 404)

    def test_serves_ready_rendition_files(self):
        directory = app.rendition_dir(HASH, 1, 0, "copy")
        os.makedirs(directory)
        with open(os.path.join(directory, "audio.m3u8"), "w") as playlist:
            playlist.write("#EXTM3U\n")
        with open(os.path.join(directory, "s3.m4s"), "wb") as segment:
            segment.write(b"segment")
        status, headers, body = self.get(f"/extaudio/{HASH.upper()}/1/0/copy/audio.m3u8")
        self.assertEqual((status, body), (200, b"#EXTM3U\n"))
        self.assertEqual(headers["Content-Type"], "application/vnd.apple.mpegurl")
        self.assertEqual(self.get(f"/extaudio/{HASH}/1/0/aac/s3.m4s")[0], 404)
        status, headers, body = self.get(f"/extaudio/{HASH}/1/0/copy/s3.m4s")
        self.assertEqual((status, body, headers["Cache-Control"]), (200, b"segment", "private, max-age=3600"))

    def test_preparing_rendition_asks_client_to_retry(self):
        files = [dict(item, length=5000) for item in FILES]
        with mock.patch.object(app, "torrent_files", return_value=files), \
                mock.patch.object(app, "ensure_rendition", return_value=(False, None)) as ensure:
            status, headers, _ = self.get(f"/extaudio/{HASH}/1/0/aac/audio.m3u8")
        self.assertEqual((status, headers["Retry-After"]), (503, "2"))
        ensure.assert_called_once_with(HASH, 1, 0, "aac", app.JOB_WAIT_SECONDS, 5000)

    def test_only_audio_files_of_a_known_torrent_are_remuxed(self):
        unknown = urllib.error.HTTPError("url", 404, "Not Found", {}, None)
        self.addCleanup(unknown.close)
        cases = (
            (mock.Mock(return_value=FILES), f"/extaudio/{HASH}/13/0/copy/audio.m3u8"),
            (mock.Mock(return_value=FILES), f"/extaudio/{HASH}/77/0/copy/audio.m3u8"),
            (mock.Mock(side_effect=unknown), f"/extaudio/{HASH}/1/0/copy/audio.m3u8"),
        )
        for files, path in cases:
            with self.subTest(path=path), mock.patch.object(app, "torrent_files", files), \
                    mock.patch.object(app, "ensure_rendition") as ensure:
                self.assertEqual(self.get(path)[0], 404)
                ensure.assert_not_called()

    def test_segments_never_start_a_job(self):
        with mock.patch.object(app, "ensure_rendition") as ensure:
            self.assertEqual(self.get(f"/extaudio/{HASH}/1/0/copy/s0.m4s")[0], 404)
        ensure.assert_not_called()

    def test_busy_queue_is_reported(self):
        with mock.patch.object(app, "torrent_files", return_value=FILES), \
                mock.patch.object(app, "ensure_rendition", return_value=(False, "busy")):
            status, headers, _ = self.get(f"/extaudio/{HASH}/1/0/copy/audio.m3u8")
        self.assertEqual((status, headers["Retry-After"]), (429, "10"))

    def test_tracks_endpoint(self):
        tracks = [{"file": 1, "stream": 0, "title": "AniLibria.tv"}]
        with mock.patch.object(app, "external_tracks", return_value=tracks):
            status, _, body = self.get(f"/extaudio/{HASH}/13/tracks")
        self.assertEqual((status, json.loads(body)), (200, {"tracks": tracks}))

    def test_track_lookups_are_bounded(self):
        for _ in range(app.MAX_TRACK_LOOKUPS):
            app._track_lookups.acquire()
        try:
            status, headers, _ = self.get(f"/extaudio/{HASH}/13/tracks")
        finally:
            for _ in range(app.MAX_TRACK_LOOKUPS):
                app._track_lookups.release()
        self.assertEqual((status, headers["Retry-After"]), (429, "5"))


if __name__ == "__main__":
    unittest.main()
