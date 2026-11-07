"""Foreground job ownership, failure statuses and playback lease ordering."""
import http.server
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

import app

HASH = "c" * 40
FILES = [{"id": 1, "path": "Show/1.mkv"}, {"id": 2, "path": "Show/2.mkv"}]


def wait_for(check, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(.01)
    raise AssertionError("condition timed out")


class JobsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.patches = [patch.object(app, "CACHE", Path(self.tmp.name))]
        for item in self.patches:
            item.start()
        app.reset_state()
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_port}/previews/{HASH}/1/"

    def tearDown(self):
        app.cancel_all()
        for future, _ in list(app.jobs.values()):
            try:
                future.result(5)
            except BaseException:
                pass
        self.server.shutdown()
        self.server.server_close()
        for item in reversed(self.patches):
            item.stop()
        self.tmp.cleanup()

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path, timeout=3) as response:
                return response.status, response.headers
        except urllib.error.HTTPError as error:
            headers = error.headers
            error.close()
            return error.code, headers

    def post(self, body, index=1):
        request = urllib.request.Request(self.base.replace("/1/", f"/{index}/") + "prepare", data=json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return response.status
        except urllib.error.HTTPError as error:
            error.close()
            return error.code

    def test_latest_request_of_a_client_replaces_its_queued_and_running_seeks(self):
        started, seen = [], []
        def prepare(h, i, slot, step, cancelled=None):
            started.append(slot)
            while not cancelled():
                time.sleep(.01)
            seen.append(slot)
            raise app.Interrupted()
        with patch.object(app, "prepare", side_effect=prepare):
            self.assertEqual(self.get("frame/1.jpg?step=10&client=scrub-client-a")[0], 202)
            wait_for(lambda: started == [1])
            self.assertEqual(self.get("frame/2.jpg?step=10&client=scrub-client-a")[0], 202)
            self.assertEqual(self.get("frame/3.jpg?step=10&client=scrub-client-a")[0], 202)
            wait_for(lambda: seen == [1])
            wait_for(lambda: started == [1, 3])
            self.assertNotIn(2, started, "a superseded queued seek never decodes")
            # Anonymous (gallery/legacy) jobs are never superseded and still find room.
            self.assertEqual(self.get("frame/7.jpg?step=10")[0], 202)
            self.assertEqual(self.get("frame/8.jpg?step=10")[0], 202)
            self.assertEqual(self.get("frame/4.jpg?step=10&client=scrub-client-a")[0], 202)
            wait_for(lambda: seen == [1, 3])
            # Interrupted work is not a failure: the slot can be requested again at once.
            self.assertEqual(self.get("frame/1.jpg?step=10&client=scrub-client-a")[0], 202)

    def test_one_client_cannot_fill_the_queue_for_the_gallery(self):
        gate = threading.Event()
        with patch.object(app, "prepare", side_effect=lambda *a, **k: gate.wait(5)):
            try:
                for slot in range(6):
                    self.assertEqual(self.get(f"frame/{slot}.jpg?step=10&client=scrub-client-a")[0], 202)
                self.assertEqual(self.get("frame/10.jpg?step=10")[0], 202)
                self.assertEqual(self.get("frame/11.jpg?step=10")[0], 202)
                status, headers = self.get("frame/12.jpg?step=10")
                self.assertEqual(status, 503, "busy is retryable")
                self.assertTrue(headers["Retry-After"])
            finally:
                gate.set()

    def test_failed_jobs_are_reported_distinctly_from_busy_and_invalid_clients_rejected(self):
        with patch.object(app, "prepare", side_effect=app.Unavailable("outside duration")):
            self.assertEqual(self.get("frame/5.jpg?step=10")[0], 202)
            wait_for(lambda: all(f.done() for f, _ in app.jobs.values()))
            status, headers = self.get("frame/5.jpg?step=10")
            self.assertEqual(status, 422)
            self.assertGreater(int(headers["Retry-After"]), 1)
        self.assertEqual(self.get("frame/5.jpg?step=10&client=bad!id")[0], 400)

    def test_unsupported_release_is_remembered_and_not_looked_up_again(self):
        with patch.object(app, "torrent", return_value={"file_stats": [{"id": 1, "path": "Show/1.wmv"}]}) as lookup:
            self.assertEqual(self.post({"client": "player-one", "state": "playing", "seq": 1}), 422)
            self.assertEqual(self.post({"client": "player-one", "state": "playing", "seq": 2}), 422)
            self.assertEqual(lookup.call_count, 1)
        with patch.object(app, "torrent", return_value={}):
            self.assertEqual(self.post({"client": "player-two", "state": "playing"}, index=2), 503,
                             "missing statistics are temporary, not unsupported")

    def test_late_requests_cannot_resurrect_a_closed_lease(self):
        with patch.object(app, "torrent", return_value={"file_stats": FILES}):
            self.assertEqual(self.post({"client": "player-one", "state": "playing", "seq": 1}), 202)
            self.assertEqual(self.post({"client": "player-one", "state": "closed", "seq": 3}), 202)
            self.assertEqual(self.post({"client": "player-one", "state": "buffering", "seq": 2}), 202)
            self.assertNotIn("player-one", app.clients)
            self.assertEqual(self.post({"client": "player-one", "state": "playing", "seq": "x"}), 400)
            # Legacy clients without sequence numbers keep working.
            self.assertEqual(self.post({"client": "player-legacy", "state": "playing"}), 202)
            self.assertIn("player-legacy", app.clients)


if __name__ == "__main__":
    unittest.main()
