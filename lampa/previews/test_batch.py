"""Queue, cancellation, retention and full extraction through the worker contract."""
import http.server
import concurrent.futures
import io
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

import app

HASH = "b" * 40
FILES = [{"id": 10, "path": "Series/10.mkv"}, {"id": 2, "path": "Series/2.mkv"},
         {"id": 1, "path": "Series/1.mkv"}, {"id": 4, "path": "poster.jpg"}]


def wait_for(check, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(.01)
    raise AssertionError("worker condition timed out")


class BatchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.patches = [patch.object(app, "CACHE", Path(self.tmp.name)), patch.object(app, "BATCH_GRACE", 0),
                        patch.object(app, "BATCH_RATE", 0), patch.object(app, "DEVICE", os.environ.get("PREVIEW_TEST_VAAPI", ""))]
        for item in self.patches:
            item.start()
        app.reset_state()
        self.stop = threading.Event()
        self.worker = None
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/previews/{HASH}/2/"

    def tearDown(self):
        self.stop.set()
        app.wake.set()
        if self.worker:
            self.worker.join(5)
            self.assertFalse(self.worker.is_alive(), "background process did not stop")
        for future, _ in list(app.jobs.values()):
            try:
                future.result(5)
            except Exception:
                pass
        self.server.shutdown()
        self.server.server_close()
        for item in reversed(self.patches):
            item.stop()
        self.tmp.cleanup()

    def start(self):
        self.worker = threading.Thread(target=app.background_loop, args=(self.stop,), daemon=True)
        self.worker.start()

    def post(self, state="playing", client="test-client", index=2, payload=None):
        body = json.dumps(payload if payload is not None else {"client": client, "state": state}).encode()
        request = urllib.request.Request(self.url.replace("/2/", f"/{index}/") + "prepare", data=body,
                                         headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return response.status
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
            return status

    def test_current_then_following_then_previous_and_deduplication_survive_restart(self):
        with patch.object(app, "torrent", return_value={"file_stats": FILES}):
            self.assertEqual(self.post(), 202)
            self.assertEqual(self.post(), 202)
        self.assertEqual(app.releases[0]["indexes"], [2, 10, 1])
        app.releases.clear()
        app.restore_queue()
        self.assertEqual(app.releases[0]["indexes"], [2, 10, 1])
        calls = []
        with patch.object(app, "generate_batch", side_effect=lambda h, i, cancelled: calls.append(i)):
            self.start()
            wait_for(lambda: not app.releases[0]["indexes"])
        self.assertEqual(calls, [2, 10, 1])

    def test_new_playback_rebuilds_the_release_after_cache_eviction_or_plan_expiry(self):
        with patch.object(app, "torrent", return_value={"file_stats": FILES}):
            self.post()
            app.releases[0]["indexes"] = []  # Previously completed; files have now been evicted.
            app.clients.clear()
            self.post("buffering")
            self.post("playing")
            self.assertEqual(app.releases[0]["indexes"], [2, 10, 1])
            app.releases[0]["indexes"] = []
            app.releases[0]["updated"] = time.time() - app.TTL - 1
            self.post()
            self.assertEqual(app.releases[0]["indexes"], [2, 10, 1])

    def test_two_players_heartbeat_does_not_keep_restarting_the_latest_current_file(self):
        with patch.object(app, "torrent", return_value={"file_stats": FILES}):
            self.post(client="television-one", index=2)
            self.post(client="television-two", index=10)
            epoch = app.generation
            self.post(client="television-one", index=2)
            self.assertEqual(app.releases[0]["current"], 10)
            self.assertEqual(app.generation, epoch, "heartbeat cannot steal priority from a newer playback")

    def test_idle_existing_torrent_gets_one_bounded_statistics_retry(self):
        responses = [{"hash": HASH}, {"hash": HASH, "file_stats": FILES}]
        def response(*args, **kwargs):
            return io.BytesIO(json.dumps(responses.pop(0)).encode())
        with patch.object(app.urllib.request, "urlopen", side_effect=response) as lookup:
            self.assertEqual(len(app.torrent(HASH)["file_stats"]), 4)
            self.assertEqual(lookup.call_count, 2)
        with patch.object(app.urllib.request, "urlopen", return_value=io.BytesIO(b'{}')) as lookup:
            self.assertEqual(app.torrent(HASH), {})
            self.assertEqual(lookup.call_count, 1, "an unknown torrent is not activated or retried")

    def test_janitor_rechecks_jobs_registered_after_its_directory_scan(self):
        path = app.directory(HASH, 2)
        path.mkdir()
        (path / "0.jpg").write_bytes(b"frame")
        os.utime(path / "0.jpg", (1, 1))
        future = concurrent.futures.Future()
        original = Path.iterdir
        def scan(folder):
            if folder == app.CACHE:
                app.jobs[(HASH, 2, app.STEP, 1)] = (future, time.monotonic())
            return original(folder)
        try:
            with patch.object(Path, "iterdir", scan):
                app.prune()
            self.assertTrue(path.exists(), "a newly registered decoder must keep its cache directory")
        finally:
            future.set_result(None)

    def test_background_metadata_probe_is_cancelled_before_it_can_block_foreground(self):
        started, cancelled, errors = threading.Event(), threading.Event(), []
        original = app.run
        def slow_probe(args, **kwargs):
            started.set()
            return original([sys.executable, "-c", "import time; time.sleep(2)"], **kwargs)
        def generate():
            try:
                app.generate_batch(HASH, 2, cancelled.is_set)
            except Exception as error:
                errors.append(error)
        with patch.object(app, "source", return_value="http://unused/"), patch.object(app, "run", side_effect=slow_probe):
            thread = threading.Thread(target=generate)
            thread.start()
            self.assertTrue(started.wait(2))
            cancelled.set()
            thread.join(.5)
            try:
                self.assertFalse(thread.is_alive(), "buffering must interrupt the actual metadata subprocess")
                self.assertIsInstance(errors[0], app.Interrupted)
            finally:
                thread.join(3)

    def test_buffering_interrupts_and_a_new_current_file_runs_first(self):
        calls, interrupted = [], threading.Event()
        allow = threading.Event()
        def generate(h, i, cancelled):
            calls.append(i)
            while not allow.wait(.01):
                if cancelled():
                    interrupted.set()
                    raise app.Interrupted()
        with patch.object(app, "torrent", return_value={"file_stats": FILES}), patch.object(app, "generate_batch", side_effect=generate):
            self.post()
            self.start()
            wait_for(lambda: calls == [2])
            self.assertEqual(self.post("buffering"), 202)
            self.assertTrue(interrupted.wait(2))
            time.sleep(.15)
            self.assertEqual(calls, [2], "buffering must stop background reads")
            self.assertEqual(self.post("playing", index=10), 202)
            wait_for(lambda: len(calls) == 2)
            self.assertEqual(calls, [2, 10])
            allow.set()
            wait_for(lambda: not app.releases[0]["indexes"])
        self.assertEqual(calls, [2, 10, 1, 2])

    def test_foreground_request_yields_background_without_a_second_decoder(self):
        interrupted, foreground = threading.Event(), threading.Event()
        first = threading.Event()
        def batch(h, i, cancelled):
            if first.is_set():
                return
            first.set()
            wait_for(cancelled)
            interrupted.set()
            raise app.Interrupted()
        def prepare(h, i, slot, step, cancelled=None):
            self.assertTrue(interrupted.is_set())
            foreground.set()
            return app.CACHE / "frame.jpg"
        with patch.object(app, "torrent", return_value={"file_stats": FILES}), patch.object(app, "generate_batch", side_effect=batch), patch.object(app, "prepare", side_effect=prepare):
            self.post()
            self.start()
            self.assertTrue(first.wait(2))
            self.assertIsNone(app.request_job(HASH, 2, 8))
            self.assertTrue(foreground.wait(2))
            wait_for(lambda: not app.releases[0]["indexes"])

    def test_request_validation_and_release_bounds(self):
        with patch.object(app, "torrent", return_value={"file_stats": FILES}):
            self.assertEqual(self.post(payload={"client": [], "state": "playing"}), 400)
            self.assertEqual(self.post(payload={"client": "test-client", "state": "unsafe"}), 400)
            self.assertEqual(self.post(index=999), 422)
            self.assertEqual(self.post(payload={"client": "x" * 3000, "state": "playing"}), 413)
        with patch.object(app, "torrent", return_value={"file_stats": [{"id": i, "path": f"{i}.mkv"} for i in range(1, app.MAX_FILES + 2)]}):
            self.assertEqual(self.post(client="other-client"), 422)
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(self.url + "prepare")
        self.assertEqual(error.exception.code, 405)
        error.exception.close()

    def test_idle_janitor_removes_expired_entries_and_size_lru_but_preserves_active(self):
        old, recent, active = [app.directory(c * 40, 1) for c in "123"]
        for path in (old, recent, active):
            path.mkdir()
            (path / "0.jpg").write_bytes(b"x" * 100)
        os.utime(old / "0.jpg", (1, 1))
        os.utime(recent / "0.jpg", (time.time() - 10, time.time() - 10))
        app.clients["active-client"] = {"hash": "3" * 40, "index": 1, "state": "paused", "seen": time.monotonic()}
        with patch.object(app, "MAX_BYTES", 150), patch.object(app, "CLEAN_INTERVAL", .05):
            self.start()
            wait_for(lambda: not old.exists() and not recent.exists())
            self.assertTrue(active.exists())

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg required")
    def test_full_batch_publishes_and_reuses_all_grid_images(self):
        video = app.CACHE / "source.mkv"
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=10:d=12",
                        "-c:v", "libx264", "-threads", "1", "-g", "10", str(video)], check=True)
        content = video.read_bytes()
        class Source(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_GET(self):
                start = int(self.headers.get("Range", "bytes=0-").split("=")[1].split("-")[0])
                self.send_response(206)
                self.send_header("Content-Length", str(len(content) - start))
                self.send_header("Content-Range", f"bytes {start}-{len(content)-1}/{len(content)}")
                self.end_headers()
                self.wfile.write(content[start:])
        source = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Source)
        threading.Thread(target=source.serve_forever, daemon=True).start()
        try:
            with patch.object(app, "source", return_value=f"http://127.0.0.1:{source.server_port}/video.mkv") as reads:
                path = app.directory(HASH, 2)
                with patch.object(app, "BATCH_RATE", 2), self.assertRaises(app.Interrupted):
                    app.generate_batch(HASH, 2, lambda: (path / "0.jpg").exists())
                first = (path / "0.jpg").stat().st_mtime_ns
                self.assertFalse(app.batch_complete(HASH, 2))
                app.generate_batch(HASH, 2, lambda: False)
                self.assertEqual((path / "0.jpg").stat().st_mtime_ns, first, "resuming cannot re-encode completed frames")
                self.assertTrue(app.batch_complete(HASH, 2))
                self.assertEqual(len(list(path.glob("*.jpg"))), math.ceil(12 / app.STEP))
                self.assertFalse(list(path.glob("*.tmp")))
                for slot in range(math.ceil(12 / app.STEP)):
                    self.assertEqual(app.request_job(HASH, 2, slot), path / f"{slot}.jpg")
                    self.assertEqual((path / f"{slot}.jpg").read_bytes()[:2], b"\xff\xd8")
                self.assertEqual(reads.call_count, 2, "cache hits cannot reopen the torrent")
        finally:
            source.shutdown()
            source.server_close()


if __name__ == "__main__":
    unittest.main()
