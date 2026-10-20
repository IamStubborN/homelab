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
        command = app.remux_command("src", "/out", 1, "aac", 2)
        self.assertEqual(command[:4], ["nice", "-n", "10", "ffmpeg"])
        self.assertIn("0:a:1", command)
        self.assertEqual(command[command.index("-c:a") + 1], "copy")

    def test_other_codecs_are_encoded_to_aac(self):
        command = app.remux_command("src", "/out", 0, "ac3", 6)
        self.assertEqual(command[command.index("-c:a") + 1:command.index("-c:a") + 4], ["aac", "-b:a", "384k"])


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

        def run_job(torrent_hash, file_id, stream, job):
            started.append((torrent_hash, file_id, stream))
            release.wait(5)
            os.makedirs(app.rendition_dir(torrent_hash, file_id, stream))
            open(os.path.join(app.rendition_dir(torrent_hash, file_id, stream), "audio.m3u8"), "w").close()
            job["done"].set()
            with app._jobs_lock:
                app._jobs.pop((torrent_hash, file_id, stream), None)

        with mock.patch.object(app, "run_job", side_effect=run_job):
            self.assertEqual(app.ensure_rendition(HASH, 1, 0, 0), (False, None))
            self.assertEqual(app.ensure_rendition(HASH, 1, 0, 0), (False, None))
            release.set()
            self.assertEqual(app.ensure_rendition(HASH, 1, 0, 5), (True, None))
        self.assertEqual(started, [(HASH, 1, 0)])

    def test_failed_job_is_reported(self):
        with mock.patch.object(app, "probe_audio", return_value=[]):
            self.assertEqual(app.ensure_rendition(HASH, 1, 0, 5), (False, "remux failed"))
        self.assertEqual(os.listdir(self.directory.name), [])

    def test_queue_is_bounded(self):
        release = threading.Event()

        def run_job(torrent_hash, file_id, stream, job):
            release.wait(5)
            job["done"].set()
            with app._jobs_lock:
                app._jobs.pop((torrent_hash, file_id, stream), None)

        with mock.patch.object(app, "run_job", side_effect=run_job):
            for file_id in range(app.MAX_JOBS):
                self.assertEqual(app.ensure_rendition(HASH, file_id, 0, 0), (False, None))
            self.assertEqual(app.ensure_rendition(HASH, 99, 0, 0), (False, "busy"))
            release.set()

    def test_job_skips_a_rendition_finished_meanwhile(self):
        directory = app.rendition_dir(HASH, 1, 0)
        os.makedirs(directory)
        open(os.path.join(directory, "audio.m3u8"), "w").close()
        job = {"done": threading.Event(), "error": None}
        with mock.patch.object(app, "probe_audio") as probe:
            app.run_job(HASH, 1, 0, job)
        probe.assert_not_called()
        self.assertEqual(job["error"], None)

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
            f"/extaudio/{HASH}/1/0/..%2F..%2Fetc%2Fpasswd",
            f"/extaudio/{HASH}/1/0/other.txt",
            "/extaudio/not-a-hash/1/tracks",
            f"/extaudio/{HASH}/1/0/../tracks",
        ):
            with self.subTest(path=path):
                self.assertEqual(self.get(path)[0], 404)

    def test_serves_ready_rendition_files(self):
        directory = app.rendition_dir(HASH, 1, 0)
        os.makedirs(directory)
        with open(os.path.join(directory, "audio.m3u8"), "w") as playlist:
            playlist.write("#EXTM3U\n")
        with open(os.path.join(directory, "s3.m4s"), "wb") as segment:
            segment.write(b"segment")
        status, headers, body = self.get(f"/extaudio/{HASH.upper()}/1/0/audio.m3u8")
        self.assertEqual((status, body), (200, b"#EXTM3U\n"))
        self.assertEqual(headers["Content-Type"], "application/vnd.apple.mpegurl")
        status, headers, body = self.get(f"/extaudio/{HASH}/1/0/s3.m4s")
        self.assertEqual((status, body, headers["Cache-Control"]), (200, b"segment", "private, max-age=3600"))

    def test_preparing_rendition_asks_client_to_retry(self):
        with mock.patch.object(app, "torrent_files", return_value=FILES), \
                mock.patch.object(app, "ensure_rendition", return_value=(False, None)) as ensure:
            status, headers, _ = self.get(f"/extaudio/{HASH}/1/0/audio.m3u8")
        self.assertEqual((status, headers["Retry-After"]), (503, "2"))
        ensure.assert_called_once_with(HASH, 1, 0, app.JOB_WAIT_SECONDS)

    def test_only_audio_files_of_a_known_torrent_are_remuxed(self):
        unknown = urllib.error.HTTPError("url", 404, "Not Found", {}, None)
        self.addCleanup(unknown.close)
        cases = (
            (mock.Mock(return_value=FILES), f"/extaudio/{HASH}/13/0/audio.m3u8"),
            (mock.Mock(return_value=FILES), f"/extaudio/{HASH}/77/0/audio.m3u8"),
            (mock.Mock(side_effect=unknown), f"/extaudio/{HASH}/1/0/audio.m3u8"),
        )
        for files, path in cases:
            with self.subTest(path=path), mock.patch.object(app, "torrent_files", files), \
                    mock.patch.object(app, "ensure_rendition") as ensure:
                self.assertEqual(self.get(path)[0], 404)
                ensure.assert_not_called()

    def test_segments_never_start_a_job(self):
        with mock.patch.object(app, "ensure_rendition") as ensure:
            self.assertEqual(self.get(f"/extaudio/{HASH}/1/0/s0.m4s")[0], 404)
        ensure.assert_not_called()

    def test_busy_queue_is_reported(self):
        with mock.patch.object(app, "torrent_files", return_value=FILES), \
                mock.patch.object(app, "ensure_rendition", return_value=(False, "busy")):
            status, headers, _ = self.get(f"/extaudio/{HASH}/1/0/audio.m3u8")
        self.assertEqual((status, headers["Retry-After"]), (429, "10"))

    def test_tracks_endpoint(self):
        tracks = [{"file": 1, "stream": 0, "title": "AniLibria.tv"}]
        with mock.patch.object(app, "external_tracks", return_value=tracks):
            status, _, body = self.get(f"/extaudio/{HASH}/13/tracks")
        self.assertEqual((status, json.loads(body)), (200, {"tracks": tracks}))


if __name__ == "__main__":
    unittest.main()
