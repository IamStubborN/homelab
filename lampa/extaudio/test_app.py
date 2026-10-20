import json
import os
import re
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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
    def test_browser_codecs_are_copied_at_low_priority(self):
        for codec in ("aac", "opus", "ac3", "eac3"):
            command = app.remux_command("src", "/out", 1, codec)
            self.assertEqual(command[:4], ["nice", "-n", "10", "ffmpeg"])
            self.assertIn("0:a:1", command)
            self.assertEqual(command[command.index("-c:a") + 1], "copy")
        with self.assertRaises(ValueError):
            app.remux_command("src", "/out", 0, "dts")

    def test_inputs_cannot_be_playlists(self):
        for command in (app.remux_command("src", "/out", 0, "aac"), app.live_command("src", "/out", 0, 2, 0, 10)):
            formats = command[command.index("-format_whitelist") + 1].split(",")
            self.assertNotIn("hls", formats)
            self.assertNotIn("concat", formats)
            self.assertEqual(command[command.index("-protocol_whitelist") + 1], "http,tcp")
            self.assertLess(command.index("-format_whitelist"), command.index("-i"))

    def test_live_encode_starts_on_the_segment_grid(self):
        command = app.live_command("src", "/out", 1, 6, 20, 30)
        remaining = f"{10 * app.SEGMENT_SECONDS:.6f}"
        self.assertEqual(command[command.index("-ss") + 1], f"{20 * app.SEGMENT_SECONDS:.6f}")
        self.assertEqual(command[command.index("-start_number") + 1], "20")
        self.assertEqual(command[command.index("-af") + 1], f"aformat=channel_layouts=5.1,apad=whole_dur={remaining}")
        self.assertEqual(command[command.index("-t") + 1], remaining)
        self.assertEqual(command[command.index("-b:a") + 1], "384k")
        stereo = app.live_command("src", "/out", 0, 2, 0, 30)
        self.assertNotIn("aformat", stereo[stereo.index("-af") + 1])
        self.assertEqual(stereo[stereo.index("-b:a") + 1], "192k")

    def test_live_playlist_lists_whole_segments(self):
        playlist = app.live_playlist(3).splitlines()
        self.assertEqual(playlist[-1], "#EXT-X-ENDLIST")
        self.assertEqual([line for line in playlist if line.startswith("s")], ["s0.m4s", "s1.m4s", "s2.m4s"])
        self.assertEqual(playlist[-3], f"#EXTINF:{app.SEGMENT_SECONDS:.6f},")

    def test_segments_are_placed_on_the_absolute_timeline(self):
        def box(kind, body):
            return struct.pack(">I4s", 8 + len(body), kind) + body

        for version, field in ((0, struct.pack(">I", 0)), (1, struct.pack(">Q", 0))):
            tfdt = box(b"tfdt", bytes([version, 0, 0, 0]) + field)
            segment = box(b"moof", box(b"mfhd", b"\0" * 8) + box(b"traf", box(b"tfhd", b"\0" * 8) + tfdt)) + box(b"mdat", b"x")
            patched = app.with_decode_time(segment, 7)
            self.assertEqual(len(patched), len(segment))
            value = patched[segment.index(b"tfdt") + 8:segment.index(b"tfdt") + 8 + len(field)]
            self.assertEqual(int.from_bytes(value, "big"), 7 * app.SEGMENT_SAMPLES)
        with self.assertRaises(ValueError):
            app.with_decode_time(box(b"mdat", b"x"), 1)

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


class RangeHandler(BaseHTTPRequestHandler):
    """Serves one file with byte ranges, like TorrServer's /stream/."""

    def log_message(self, *args):
        pass

    def do_GET(self):
        with open(self.server.path, "rb") as source:
            data = source.read()
        match = re.match(r"bytes=(\d+)-(\d*)", self.headers.get("Range", ""))
        start = int(match.group(1)) if match else 0
        end = int(match.group(2)) if match and match.group(2) else len(data) - 1
        self.send_response(206 if match else 200)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if match:
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(data)}")
        self.end_headers()
        try:
            for offset in range(start, end + 1, 16384):
                self.wfile.write(data[offset:min(offset + 16384, end + 1)])
                time.sleep(getattr(self.server, "delay", 0))
        except (BrokenPipeError, ConnectionResetError):
            pass


@unittest.skipUnless(shutil.which("ffmpeg"), "needs ffmpeg")
class LiveEncodeTests(unittest.TestCase):
    """Encode a real file served over HTTP, as TorrServer would."""

    @classmethod
    def setUpClass(cls):
        cls.source = tempfile.TemporaryDirectory()
        path = os.path.join(cls.source.name, "audio.mka")
        subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=f=440:d=40:r=48000",
            "-af", "pan=5.1(side)|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0", "-c:a", "ac3", path,
        ], check=True)
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), RangeHandler)
        cls.server.path = path
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}/audio.mka"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.source.cleanup()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        patcher = mock.patch.object(app, "stream_url", return_value=self.url)
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = mock.patch.object(app, "CACHE_DIR", self.directory.name)
        patcher.start()
        self.addCleanup(patcher.stop)
        app._live.clear()
        self.rendition = app.LiveRendition(HASH, 1, 0, {"channels": 6, "duration": 40.0})
        self.rendition.source = self.url
        os.makedirs(self.rendition.directory)
        self.addCleanup(lambda: [app.stop_run(*pair) for pair in app.running()])
        app._live[(HASH, 1, 0)] = self.rendition

    def segment(self, index, rendition=None):
        with open(os.path.join((rendition or self.rendition).directory, f"s{index}.m4s"), "rb") as segment:
            data = segment.read()
        offset = data.index(b"tfdt")
        size = 8 if data[offset + 4] else 4
        return int.from_bytes(data[offset + 8:offset + 8 + size], "big")

    def test_segments_from_any_position_share_one_timeline(self):
        self.assertTrue(app.live_file(self.rendition, 4, 30))
        self.assertTrue(app.live_file(self.rendition, None, 5))
        self.assertEqual(self.segment(4), 4 * app.SEGMENT_SAMPLES)
        self.assertFalse(os.path.exists(os.path.join(self.rendition.directory, "s3.m4s")), "warm-up segment is dropped")
        self.assertTrue(app.live_file(self.rendition, 0, 30), "a seek back restarts the encoder")
        self.assertEqual(self.segment(0), 0)
        layout = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "stream=channel_layout", "-of", "csv=p=0",
             os.path.join(self.rendition.directory, "init.mp4")], capture_output=True, check=True,
        ).stdout.strip()
        self.assertEqual(layout, b"5.1")

    def test_audio_is_padded_to_the_last_listed_segment(self):
        rendition = app.LiveRendition(HASH, 2, 0, {"channels": 2, "duration": 47.0})  # longer than the audio
        os.makedirs(rendition.directory)
        app._live[(HASH, 2, 0)] = rendition
        last = rendition.count - 1
        self.assertTrue(app.live_file(rendition, last, 30))
        self.assertEqual(self.segment(last, rendition), last * app.SEGMENT_SAMPLES)
        deadline = time.monotonic() + 10
        run = rendition.runs[0]
        while rendition.runs and time.monotonic() < deadline:
            time.sleep(0.1)
        # The encoder's priming frame spills into one tiny unlisted segment.
        self.assertGreaterEqual(run.head, rendition.count)
        self.assertEqual(rendition.failures, 0)

    def test_an_older_request_does_not_fight_the_newest(self):
        results = []
        older = threading.Thread(target=lambda: results.append(app.live_file(self.rendition, 6, 20)))
        older.start()
        time.sleep(0.3)
        results.append(app.live_file(self.rendition, 1, 20))
        older.join()
        self.assertEqual(results, [True, True])
        self.assertLessEqual(self.rendition.started, 2)

    def test_two_viewers_keep_their_own_runs(self):
        long = app.LiveRendition(HASH, 3, 0, {"channels": 2, "duration": 600.0})
        os.makedirs(long.directory)
        app._live[(HASH, 3, 0)] = long
        self.server.delay = 0.002
        self.addCleanup(setattr, self.server, "delay", 0)
        # 40 s of audio: viewers past the end are served padding, which is enough here.
        for index in (1, 50, 2, 51, 3, 52):
            self.assertTrue(app.live_file(long, index, 30), index)
        self.assertEqual(long.started, 2, "each viewer keeps its run")
        self.assertEqual(sorted(run.start for run in long.runs), [0, 49])

    def test_the_dropped_warmup_segment_restarts_the_encoder(self):
        self.assertTrue(app.live_file(self.rendition, 4, 30))
        started = time.monotonic()
        self.assertTrue(app.live_file(self.rendition, 3, 30))
        self.assertLess(time.monotonic() - started, 10)

    def test_a_failing_source_is_not_restarted_in_a_loop(self):
        self.rendition.source = "http://127.0.0.1:9/missing.mka"
        results = [app.live_file(self.rendition, 2, 4) for _ in range(5)]
        self.assertIsNone(results[-1])
        self.assertEqual(self.rendition.started, app.MAX_FAILURES)

    def test_encoder_pauses_far_ahead_of_playback(self):
        self.server.delay = 0.03  # about 0.5 MB/s, like a torrent still downloading
        self.addCleanup(setattr, self.server, "delay", 0)
        with mock.patch.object(app, "LIVE_AHEAD", 2):
            self.assertTrue(app.live_file(self.rendition, 1, 30))
            run = self.rendition.runs[0]
            deadline = time.monotonic() + 10
            while not run.paused and time.monotonic() < deadline:
                time.sleep(0.1)
            self.assertTrue(run.paused)
            self.assertLessEqual(run.head, 1 + 2 + 2)
            self.assertTrue(app.live_file(self.rendition, 3, 30))
            self.assertFalse(run.paused and run.head <= 4)


class CoverageTests(unittest.TestCase):
    def run_at(self, start, head, warmup):
        run = app.Run(mock.Mock(), start, warmup, start)
        run.head = head
        return run

    def test_a_run_covers_only_segments_it_will_still_write(self):
        run = self.run_at(10, 20, 10)
        self.assertEqual([index for index in range(5, 30) if run.covers(index)], list(range(20, 20 + app.LIVE_REACH + 1)))
        self.assertEqual([index for index in range(5, 30) if run.owns(index)], list(range(11, 20 + app.LIVE_REACH + 1)))
        self.assertFalse(self.run_at(10, 10, 10).covers(10), "the dropped warm-up segment")
        self.assertTrue(self.run_at(0, 0, None).covers(0))

    def test_requests_go_to_the_run_at_their_position(self):
        rendition = app.LiveRendition(HASH, 1, 0, {"duration": 600.0})
        early, late = self.run_at(0, 10, None), self.run_at(50, 60, 50)
        rendition.runs = [early, late]
        self.assertIs(rendition.owner(5), early)
        self.assertIs(rendition.owner(55), late)
        self.assertIsNone(rendition.owner(30))
        late.seen += 1
        self.assertIs(rendition.owner(None), late, "init comes from any run")


class RunSlotTests(unittest.TestCase):
    def setUp(self):
        app._live.clear()
        self.addCleanup(app._live.clear)

    def running(self, key, seen_ago, paused=False):
        rendition = app.LiveRendition(HASH, key, 0, {"duration": 60.0})
        run = app.Run(mock.Mock(**{"poll.return_value": None}), 0, None, 0)
        run.paused = paused
        run.seen = time.monotonic() - seen_ago
        rendition.runs.append(run)
        app._live[(HASH, key, 0)] = rendition
        return rendition

    def test_a_stale_active_run_yields_its_slot(self):
        stale, busy = self.running(1, 60), self.running(2, 1)
        stale_process, busy_process = stale.runs[0].process, busy.runs[0].process
        new = app.LiveRendition(HASH, 3, 0, {"duration": 60.0})
        with mock.patch.object(app.subprocess, "Popen"), mock.patch.object(app.threading, "Thread"), \
                tempfile.TemporaryDirectory() as directory, mock.patch.object(app, "CACHE_DIR", directory):
            new.directory = app.rendition_dir(HASH, 3, 0, "aac")
            self.assertTrue(app.start_run(new, 5))
        stale_process.kill.assert_called_once()
        busy_process.kill.assert_not_called()
        self.assertEqual(stale.runs, [])

    def test_two_watched_runs_keep_their_slots(self):
        self.running(1, 1), self.running(2, 1)
        new = app.LiveRendition(HASH, 3, 0, {"duration": 60.0})
        self.assertIsNone(app.start_run(new, 5))

    def start(self, rendition, index):
        with mock.patch.object(app.subprocess, "Popen"), mock.patch.object(app.threading, "Thread"), \
                tempfile.TemporaryDirectory() as directory, mock.patch.object(app, "CACHE_DIR", directory):
            rendition.directory = app.rendition_dir(HASH, 1, 0, "aac")
            return app.start_run(rendition, index)

    def test_a_viewer_seeking_again_replaces_its_own_run_at_once(self):
        rendition = self.running(1, 3)
        newer = app.Run(mock.Mock(**{"poll.return_value": None}), 40, 40, 41)
        rendition.runs.append(newer)
        older = rendition.runs[0]
        self.assertIsNotNone(self.start(rendition, 80))
        older.process.kill.assert_called_once()
        self.assertEqual([run.start for run in rendition.runs], [40, 79])

    def test_a_seek_does_not_take_the_run_of_a_buffered_viewer(self):
        rendition = self.running(1, 5, paused=True)
        buffered = rendition.runs[0]
        left = app.Run(mock.Mock(**{"poll.return_value": None}), 40, 40, 41)
        rendition.runs.append(left)
        self.assertIsNotNone(self.start(rendition, 80))
        buffered.process.kill.assert_not_called()
        left.process.kill.assert_called_once()

    def test_a_run_is_kept_when_no_new_run_can_start(self):
        rendition = self.running(1, 5, paused=True)
        rendition.runs.append(app.Run(mock.Mock(**{"poll.return_value": None}), 40, 40, 41))
        rendition.runs[1].paused = True
        self.running(2, 1), self.running(3, 1)
        self.assertIsNone(self.start(rendition, 80))
        self.assertEqual(len(rendition.runs), 2)
        for run in rendition.runs:
            run.process.kill.assert_not_called()

    def test_a_missing_init_resumes_a_paused_run(self):
        rendition = self.running(1, 1, paused=True)
        with tempfile.TemporaryDirectory() as directory:
            rendition.directory = directory
            self.assertFalse(app.live_file(rendition, None, 0.05))
        rendition.runs[0].process.send_signal.assert_called_once_with(app.signal.SIGCONT)
        self.assertFalse(rendition.runs[0].paused)

    def test_a_third_position_replaces_the_least_recent_run(self):
        rendition = self.running(1, 5, paused=True)
        older = rendition.runs[0]
        newer = app.Run(mock.Mock(**{"poll.return_value": None}), 40, 40, 41)
        newer.paused = True
        rendition.runs.append(newer)
        with mock.patch.object(app.subprocess, "Popen"), mock.patch.object(app.threading, "Thread"), \
                tempfile.TemporaryDirectory() as directory, mock.patch.object(app, "CACHE_DIR", directory):
            rendition.directory = app.rendition_dir(HASH, 1, 0, "aac")
            self.assertIsNotNone(app.start_run(rendition, 80))
        older.process.kill.assert_called_once()
        self.assertEqual([run.start for run in rendition.runs], [40, 79])


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
            status, headers, _ = self.get(f"/extaudio/{HASH}/1/0/copy/audio.m3u8")
        self.assertEqual((status, headers["Retry-After"]), (503, "2"))
        ensure.assert_called_once_with(HASH, 1, 0, "copy", app.JOB_WAIT_SECONDS, 5000)

    def test_encoded_playlist_is_immediate_and_starts_at_the_position(self):
        rendition = mock.Mock(count=1000, **{"owner.return_value": None})
        def create(torrent_hash, file_id, stream):
            directory = app.rendition_dir(torrent_hash, file_id, stream, "aac")
            os.makedirs(directory, exist_ok=True)
            with open(os.path.join(directory, "audio.m3u8"), "w") as playlist:
                playlist.write("#EXTM3U\n")
            return rendition

        with mock.patch.object(app, "torrent_files", return_value=FILES), \
                mock.patch.object(app, "live_rendition", side_effect=create), \
                mock.patch.object(app, "start_run") as start:
            status, _, body = self.get(f"/extaudio/{HASH}/1/0/aac/audio.m3u8?at=600")
        self.assertEqual((status, body), (200, b"#EXTM3U\n"))
        start.assert_called_once_with(rendition, 600 * app.SAMPLE_RATE // app.SEGMENT_SAMPLES)

    def test_encoded_segments_need_a_checked_playlist(self):
        with mock.patch.object(app, "live_rendition") as live:
            self.assertEqual(self.get(f"/extaudio/{HASH}/1/0/aac/s3.m4s")[0], 404)
            self.assertEqual(self.get(f"/extaudio/{HASH}/1/0/aac/init.mp4")[0], 404)
        live.assert_not_called()

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
