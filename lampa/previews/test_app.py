"""Run with python3 -m unittest discover -s lampa/previews -v (requires ffmpeg)."""
import http.server
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("previews", Path(__file__).with_name("app.py"))
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)
HASH = "a" * 40


class PreviewTest(unittest.TestCase):
    def test_validation_queue_and_expiry(self):
        for path in ["/previews/../../etc/passwd", "/previews/http://x/1/metadata",
                     f"/previews/{HASH}/0/metadata", f"/previews/{HASH}/1/frame/-1.jpg"]:
            self.assertIsNone(app.ROUTE.fullmatch(path))
        with self.assertRaises(app.Unavailable):
            app.metadata({"format": {"duration": "nan"}})
        with self.assertRaises(app.Unavailable):
            app.run([sys.executable, "-c", "import sys; sys.stdout.write('x' * (3 * 1024 * 1024))"])
        gate = threading.Event()
        with tempfile.TemporaryDirectory() as tmp, patch.object(app, "CACHE", Path(tmp)), \
                patch.object(app, "prepare", lambda *_, **__: gate.wait(5)):
            try:
                for slot in range(3):
                    self.assertIsNone(app.request_job(HASH, 1, slot))
                self.assertIsNone(app.request_job(HASH, 1, 0))  # deduplicated
                with self.assertRaises(app.Unavailable):
                    app.request_job(HASH, 1, 3)
            finally:
                gate.set()
                for future, _ in app.jobs.values():
                    future.result(6)
                app.jobs.clear()
            directory = Path(tmp) / "key"
            directory.mkdir()
            old = directory / "old.jpg"
            old.write_bytes(b"old")
            with patch.object(app, "MAX_BYTES", 2):
                app.prune()
            self.assertFalse(old.exists())

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg required")
    def test_real_video_through_http_worker(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            meta = root / "chapters.txt"
            meta.write_text(";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=5000\ntitle=Opening\n"
                            "[CHAPTER]\nTIMEBASE=1/1000\nSTART=5000\nEND=12000\ntitle=Scene\n")
            video = root / "test.mkv"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=10:d=12",
                            "-f", "ffmetadata", "-i", str(meta), "-map_metadata", "1", "-map_chapters", "1",
                            "-c:v", "libx264", "-threads", "1", "-g", "10", str(video)], check=True)
            content = video.read_bytes()

            class Torrent(http.server.BaseHTTPRequestHandler):
                def log_message(self, *_):
                    pass

                def do_POST(self):
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(json.dumps({"file_stats": [{"id": 1, "path": "video.mkv"}]}
                                               if body == {"action": "get", "hash": HASH} else {}).encode())

                def do_GET(self):
                    start, end = 0, len(content) - 1
                    if self.headers.get("Range"):
                        values = self.headers["Range"].split("=")[1].split("-")
                        start = int(values[0]); end = int(values[1]) if values[1] else end
                        self.send_response(206)
                        self.send_header("Content-Range", f"bytes {start}-{end}/{len(content)}")
                    else:
                        self.send_response(200)
                    self.send_header("Content-Length", str(end - start + 1))
                    self.send_header("Accept-Ranges", "bytes")
                    self.end_headers()
                    self.wfile.write(content[start:end + 1])

            upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Torrent)
            worker = http.server.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
            for server in (upstream, worker):
                threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                with patch.object(app, "BASE", f"http://127.0.0.1:{upstream.server_port}"), \
                        patch.object(app, "CACHE", root / "cache"), patch.object(app, "DEVICE", os.environ.get("PREVIEW_TEST_VAAPI", "")):
                    app.CACHE.mkdir()
                    base = f"http://127.0.0.1:{worker.server_port}/previews/{HASH}/1/"

                    def get(operation):
                        deadline = time.monotonic() + 20
                        while time.monotonic() < deadline:
                            with urllib.request.urlopen(base + operation) as response:
                                if response.status == 200:
                                    return response.read(), response.headers
                            time.sleep(.05)
                        self.fail("worker did not complete")

                    data, _ = get("metadata")
                    info = json.loads(data)
                    self.assertEqual(info["step"], 5, "bare URLs preserve the installed clients' five-second grid")
                    self.assertEqual([c["title"] for c in info["chapters"]], ["Opening", "Scene"])
                    frame, headers = get("frame/1.jpg")
                    self.assertEqual(frame[:2], b"\xff\xd8")
                    self.assertEqual(headers["Content-Type"], "image/jpeg")
                    modern, _ = get("metadata?step=10")
                    self.assertEqual(json.loads(modern)["step"], 10)
                    modern_frame, _ = get("frame/1.jpg?step=10")
                    self.assertEqual(modern_frame[:2], b"\xff\xd8")
                    self.assertNotEqual(frame, modern_frame, "slot1 is5s for legacy clients and10s for new clients")
                    with patch.object(app, "source", side_effect=AssertionError("cached frame fetched again")):
                        self.assertEqual(get("frame/1.jpg")[0], frame)
                    with self.assertRaises(app.Unavailable):
                        app.prepare("b" * 40, 1, None)
                    with self.assertRaises(app.Unavailable):
                        app.prepare(HASH, 1, 10)
                    print(f"\nSynthetic 12s video: chapters={len(info['chapters'])}, frame={len(frame)} bytes")
            finally:
                for future, _ in app.jobs.values():
                    try:
                        future.result(30)
                    except Exception:
                        pass
                app.jobs.clear()
                for server in (upstream, worker):
                    server.shutdown(); server.server_close()


if __name__ == "__main__":
    unittest.main()
