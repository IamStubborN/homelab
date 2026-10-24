import http.client
import io
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



def stop_live(directory):
    """Stops the encoder and subtitle runs a test started and waits for their
    watchers to remove the run directories, so the cache can be deleted."""
    for pair in app.running():
        app.stop_run(*pair)
    for track in list(app._subs.values()):
        if track.run:
            app.stop_subtitle_run(track)
    deadline = time.monotonic() + 5
    while any(name.endswith(".tmp") for name in os.listdir(directory)) and time.monotonic() < deadline:
        time.sleep(0.05)

class CandidateTests(unittest.TestCase):
    def test_matches_audio_files_named_after_the_video(self):
        self.assertEqual([(item["id"], item["location"]) for item in app.external_candidates(FILES, 13)], [
            (1, "Sound"),
            (20, "Studio Band"),
        ])

    def matches(self, paths, video, extensions=app.AUDIO_EXTENSIONS):
        files = [{"id": number, "path": path} for number, path in enumerate(paths)]
        return [paths[item["id"]] for item in app.external_candidates(files, paths.index(video), extensions)]

    EPISODES = [f"Show [1080p]/Show - {number:02d} [1080p] [ABCD1234].mkv" for number in range(1, 13)]

    def test_folders_named_differently_match_by_episode_number(self):
        dub = [f"Show [1080p]/RUS Sound/AniLibria/[AniLibria] Show - {number:02d}.mka" for number in range(1, 13)]
        self.assertEqual(self.matches(self.EPISODES + dub, self.EPISODES[2]), [dub[2]])
        seasons = [f"S/Show.S01E{number:02d}.2160p.WEB-DL.H265.mkv" for number in range(1, 9)]
        studio = [f"S/Rus Sound/Studio/Show.S01E{number:02d}.ac3" for number in range(1, 9)]
        self.assertEqual(self.matches(seasons + studio, seasons[2]), [studio[2]])
        sequel = [f"R/Re Zero 2nd Season - {number:02d}.mkv" for number in range(1, 5)]
        sequel_dub = [f"R/Rus/Re Zero 2 - {number:02d} [Dub].mka" for number in range(1, 5)]
        self.assertEqual(self.matches(sequel + sequel_dub, sequel[2]), [sequel_dub[2]])

    def test_a_partial_dub_matches_only_its_episodes(self):
        dub = [f"Show [1080p]/Sound/Dub/Ep{number}.mka" for number in (1, 2, 3, 5)]
        self.assertEqual(self.matches(self.EPISODES + dub, self.EPISODES[2]), [dub[2]])
        self.assertEqual(self.matches(self.EPISODES + dub, self.EPISODES[3]), [])

    def test_extras_do_not_hide_episode_one(self):
        extras = ["Show [1080p]/NCOP1.mkv", "Show [1080p]/NCED1.mkv"]
        dub = [f"Show [1080p]/RUS/[Dub] Show - {number:02d}.mka" for number in range(1, 13)]
        self.assertEqual(self.matches(self.EPISODES + extras + dub, self.EPISODES[0]), [dub[0]])

    def test_unnumbered_folders_match_by_position(self):
        paths = [f"X/{name}.mkv" for name in "abc"] + [f"X/Snd/{name}-rus.mka" for name in "xyz"]
        self.assertEqual(self.matches(paths, "X/b.mkv"), ["X/Snd/y-rus.mka"])

    def test_a_season_range_in_the_root_does_not_hide_seasons(self):
        for root in ("Show S1-S3", "[S1-Raws] Show", "Show.S01-S02.1080p", "Show 1-2 сезон"):
            videos = [f"{root}/Season {season}/Show - {number:02d}.mkv" for season in (1, 2) for number in range(1, 4)]
            dub = [f"{root}/RUS Sound/Season {season}/Show - {number:02d}.mka" for season in (1, 2) for number in range(1, 4)]
            self.assertEqual(self.matches(videos + dub, videos[4]), [dub[4]], root)

    def test_a_single_season_torrent_matches_unseasoned_audio(self):
        videos = [f"Show.S02.1080p/Show.S02E{number:02d}.1080p.mkv" for number in range(1, 4)]
        dub = [f"Show.S02.1080p/RUS/Show.{number:02d}.ac3" for number in range(1, 4)]
        self.assertEqual(self.matches(videos + dub, videos[1]), [dub[1]])
        self.assertEqual(app.season("Show S2 - 02.mkv"), 2)
        self.assertIsNone(app.season("Show S1-S3/x.mkv"))  # a range names no one season

    def test_channel_layouts_are_labels(self):
        for suffix, label in ((" 5.1", "5.1"), (".2ch", "2ch"), (".6ch", "6ch"), (" 2.0", "2.0")):
            paths = ["F/Film (2001).mkv", "F/Other.mkv", f"F/Rus/Film (2001){suffix}.ac3"]
            files = [{"id": number, "path": path} for number, path in enumerate(paths)]
            self.assertEqual([item["suffix"] for item in app.external_candidates(files, 0)], [label])
        self.assertIsNone(app.named_after("Film", "Film 2.ac3", []))

    def test_music_folders_are_not_dubs(self):
        music = [f"Show [1080p]/OST/{number:02d} Track.flac" for number in range(1, 13)]
        self.assertEqual(self.matches(self.EPISODES + music, self.EPISODES[2]), [])

    def test_a_film_takes_every_audio_file(self):
        paths = ["M/Movie.2019.1080p.mkv", "M/Rus Sound/Movie.Rus.DUB.ac3", "M/Rus Sound/Movie.Rus.AVO.dts"]
        self.assertEqual(sorted(self.matches(paths, paths[0])), sorted(paths[1:]))

    def test_other_seasons_never_lend_their_episodes(self):
        videos = [f"Show/Season {season}/Show S0{season}E{number:02d}.mkv" for season in (1, 2) for number in range(1, 4)]
        named = [f"Show/RUS Sound/Season {season}/Show S0{season}E{number:02d}.mka" for season in (1, 2) for number in range(1, 4)]
        self.assertEqual(self.matches(videos + named, videos[1]), [named[1]])
        absolute = [f"Show/RUS Dub/[Dub] Show - {number:02d}.mka" for number in range(1, 7)]
        self.assertEqual(self.matches(videos + absolute, videos[1]), [absolute[1]], "season 1 counts from 1")
        self.assertEqual(self.matches(videos + absolute, videos[4]), [], "season 2 cannot trust absolute numbers")

    def test_a_lone_video_among_others_is_not_a_film(self):
        paths = self.EPISODES + ["Show [1080p]/OVA/Show OVA.mkv"] + [f"Show [1080p]/RUS Sound/Show - {number:02d}.mka" for number in range(1, 13)]
        self.assertEqual(self.matches(paths, "Show [1080p]/OVA/Show OVA.mkv"), [])
        folders = [f"Show/Episode {number:02d}/video.mkv" for number in range(1, 4)] + [f"Show/Episode {number:02d}/rus.mka" for number in range(1, 4)]
        self.assertEqual(self.matches(folders, "Show/Episode 02/video.mkv"), ["Show/Episode 02/rus.mka"])

    def test_a_sequel_is_not_a_labelled_track(self):
        paths = ["Shrek/Shrek.mkv", "Shrek/Shrek 2.mkv", "Shrek/RUS/Shrek.mka", "Shrek/RUS/Shrek 2.mka", "Shrek/RUS/Shrek.Dub.mka"]
        self.assertEqual(self.matches(paths, "Shrek/Shrek.mkv"), ["Shrek/RUS/Shrek.mka", "Shrek/RUS/Shrek.Dub.mka"])
        self.assertEqual(self.matches(paths, "Shrek/Shrek 2.mkv"), ["Shrek/RUS/Shrek 2.mka"])
        recap = self.EPISODES + ["Show [1080p]/Sound/Show - 01 [1080p] [ABCD1234].5.mka"]
        self.assertEqual(self.matches(recap, self.EPISODES[0]), [])

    def test_named_files_survive_the_probe_limit(self):
        dubs = [f"Show [1080p]/{letter}/[{letter}] Show - {number:02d}.mka" for letter in "ABCDEFG" for number in range(1, 13)]
        named = "Show [1080p]/Z/Show - 02 [1080p] [ABCD1234].Kansai.mka"
        found = self.matches(self.EPISODES + dubs + [named], self.EPISODES[1])
        self.assertEqual(found[0], named)
        self.assertEqual(len(found), app.MAX_CANDIDATES)

    def test_versioned_episodes_keep_their_number(self):
        videos = [f"Show/Show - {number:02d}.mkv" for number in (1, 2, 3, 4)] + ["Show/Show - 05v2.mkv"]
        dub = [f"Show/RUS/[Dub] Show - {number:02d}.mka" for number in range(1, 6)]
        self.assertEqual(self.matches(videos + dub, "Show/Show - 05v2.mkv"), [dub[4]])

    def test_specials_find_their_own_folder(self):
        paths = [f"Show/Specials/Show SP{number}.mkv" for number in (1, 2)] + [f"Show/RUS Sound/Specials/SP{number} dub.mka" for number in (1, 2)]
        self.assertEqual(self.matches(paths, "Show/Specials/Show SP2.mkv"), ["Show/RUS Sound/Specials/SP2 dub.mka"])

    def test_unknown_video_has_no_candidates(self):
        self.assertEqual(app.external_candidates(FILES, 99), [])

    def test_tracks_use_stream_metadata_and_skip_unreadable_files(self):
        def probe(torrent_hash, file_id, wait):
            if file_id == 20:
                raise subprocess.CalledProcessError(1, "ffprobe")
            return [{"codec_name": "aac", "channels": 2, "tags": {"title": "AniLibria.tv", "language": "rus"}}]

        with mock.patch.object(app, "probe_audio_soon", side_effect=probe):
            self.assertEqual(app.external_tracks(HASH, 13, FILES), ([{
                "file": 1, "stream": 0, "title": "AniLibria.tv", "location": "Sound",
                "language": "rus", "codec": "aac", "channels": 2,
            }], False))


    def test_a_file_still_downloading_is_reported_as_pending_next_to_the_tracks_read(self):
        def probe(torrent_hash, file_id, wait):
            if file_id == 20:
                return None
            return [{"codec_name": "aac", "channels": 2, "tags": {"title": "AniLibria.tv", "language": "rus"}}]

        with mock.patch.object(app, "probe_audio_soon", side_effect=probe):
            tracks, pending = app.external_tracks(HASH, 13, FILES)
        self.assertEqual([track["file"] for track in tracks], [1])
        self.assertTrue(pending)


SUB_FILES = [
    {"id": 13, "path": "Show/Show - 01.mkv", "length": 10**9},
    {"id": 14, "path": "Show/Show - 02.mkv", "length": 10**9},
    {"id": 25, "path": "Show/YakuSub Studio/Show - 01.ass", "length": 55679},
    {"id": 26, "path": "Show/YakuSub Studio/Show - 02.ass", "length": 53489},
    {"id": 27, "path": "Show/Subs/Show - 01.rus.ssa", "length": 1000},
    {"id": 28, "path": "Show/Subs/Show - 01.srt", "length": 1000},
    {"id": 37, "path": "Show/YakuSub Studio/Шрифты/FrizQuadrataC.otf", "length": 22368},
    {"id": 38, "path": "Show/YakuSub Studio/Шрифты/ariblk.ttf", "length": 119876},
    {"id": 40, "path": "Show/Fonts/Shared.ttf", "length": 1000},
    {"id": 41, "path": "Show/Fonts/huge.ttf", "length": 10**9},
    {"id": 42, "path": "Show/Extras/notes.otf", "length": 1000},
]


class SubtitleTests(unittest.TestCase):
    def test_subtitles_named_after_the_video_come_with_their_fonts(self):
        self.assertEqual(app.external_subtitles(SUB_FILES, 13), [
            {"file": 27, "title": "Subs", "location": "Subs / rus", "language": "rus", "fonts": [40, 38, 37]},
            {"file": 25, "title": "YakuSub Studio", "location": "YakuSub Studio", "language": "", "fonts": [38, 37]},
        ])
        self.assertEqual(app.external_subtitles(SUB_FILES, 99), [])

    def fake_stream(self, body, delay=0):
        def urlopen(url, timeout):
            source = __import__("io").BytesIO(body)
            response = mock.MagicMock()
            def read(size):
                time.sleep(delay)
                return source.read(size)
            response.__enter__.return_value.read.side_effect = read
            return response
        return mock.patch.object(app.urllib.request, "urlopen", side_effect=urlopen)

    def test_raw_files_are_limited_to_subtitles_and_fonts(self):
        with mock.patch.object(app, "torrent_files", return_value=SUB_FILES), \
                tempfile.TemporaryDirectory() as directory, mock.patch.object(app, "CACHE_DIR", directory):
            for file_id in (13, 28, 41, 99):
                with self.assertRaises(app.Rejected, msg=file_id):
                    app.fetch_raw(HASH, file_id)

    def test_raw_files_are_fetched_once(self):
        body = b"[Script Info]" + b"x" * (1000 - 13)
        with mock.patch.object(app, "torrent_files", return_value=SUB_FILES) as files, self.fake_stream(body) as urlopen, \
                tempfile.TemporaryDirectory() as directory, mock.patch.object(app, "CACHE_DIR", directory):
            path = app.fetch_raw(HASH, 27)
            self.assertEqual(app.fetch_raw(HASH, 27), path)
            with open(path, "rb") as cached:
                self.assertEqual(cached.read(), body)
        self.assertEqual((files.call_count, urlopen.call_count), (1, 1))

    def test_truncated_or_oversized_raw_files_are_not_cached(self):
        for body in (b"short", b"x" * 2000):
            with mock.patch.object(app, "torrent_files", return_value=SUB_FILES), self.fake_stream(body), \
                    tempfile.TemporaryDirectory() as directory, mock.patch.object(app, "CACHE_DIR", directory):
                with self.assertRaises(OSError):
                    app.fetch_raw(HASH, 27)
                self.assertEqual(os.listdir(os.path.join(directory, f"{HASH}-27-raw")), [])


class RemuxTests(unittest.TestCase):
    def test_inputs_cannot_be_playlists(self):
        for command in (app.live_command("src", "/out", 0, 2, 0, 10),):
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
        self.assertEqual(stereo[stereo.index("-b:a") + 1], "256k")

    def test_a_matroska_track_takes_its_own_duration_tag(self):
        probe = {"format": {"duration": "1500.0"}, "streams": [
            {"codec_name": "aac", "tags": {"DURATION": "00:23:40.480000000"}}, {"codec_name": "aac"},
        ]}
        self.assertEqual([item["duration"] for item in app.audio_streams(probe)], [1420.48, 1500.0])

    def test_only_aac_lc_mono_or_stereo_is_copied(self):
        lc = {"codec_name": "aac", "profile": "LC", "sample_rate": "48000", "channels": 2}
        self.assertTrue(app.copyable(lc))
        for change in ({"profile": "HE-AAC"}, {"channels": 6}, {"codec_name": "ac3"}, {"sample_rate": None}):
            self.assertFalse(app.copyable({**lc, **change}), change)

    def test_a_copied_playlist_ends_with_the_audio(self):
        rendition = app.LiveRendition(HASH, 1, 0, {"codec_name": "aac", "profile": "LC", "sample_rate": "48000", "channels": 2, "duration": 20.0})
        self.assertEqual((rendition.count, rendition.frames), (4, 281))
        playlist = app.live_playlist(rendition.count, rendition.segment_seconds, rendition.last_seconds).splitlines()
        self.assertEqual(playlist[-3], f"#EXTINF:{20 - 3 * rendition.segment_seconds:.6f},")

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
        self.addCleanup(stop_live, self.directory.name)
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


@unittest.skipUnless(shutil.which("ffmpeg"), "needs ffmpeg")
class CopiedAacTests(unittest.TestCase):
    """Copy a real AAC file served over HTTP, as TorrServer would."""

    @classmethod
    def setUpClass(cls):
        cls.source = tempfile.TemporaryDirectory()
        cls.path = os.path.join(cls.source.name, "audio.mka")
        subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=f=440:d=40:r=44100",
            "-ac", "2", "-c:a", "aac", "-b:a", "128k", cls.path,
        ], check=True)
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), RangeHandler)
        cls.server.path = cls.path
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}/audio.mka"
        cls.info = {"codec_name": "aac", "profile": "LC", "sample_rate": "44100", "channels": 2, "duration": 40.0}

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.source.cleanup()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        patcher = mock.patch.object(app, "CACHE_DIR", self.directory.name)
        patcher.start()
        self.addCleanup(patcher.stop)
        app._live.clear()
        self.addCleanup(stop_live, self.directory.name)

    def rendition(self, file_id):
        rendition = app.LiveRendition(HASH, file_id, 0, self.info)
        rendition.source = self.url
        os.makedirs(rendition.directory)
        app._live[(HASH, file_id, 0)] = rendition
        return rendition

    def read(self, rendition, name):
        with open(os.path.join(rendition.directory, name), "rb") as source:
            return source.read()

    def packets(self, path):
        """Hashes of the frames at or after zero; the encoder's priming frame
        before zero is not on the grid and decoders drop its output anyway."""
        lines = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-map", "0:a", "-c", "copy", "-f", "framemd5", "-"],
                               capture_output=True, check=True).stdout.decode().splitlines()
        fields = [[field.strip() for field in line.split(",")] for line in lines if not line.startswith("#")]
        return [field[-1] for field in fields if int(field[2]) >= 0]

    def test_a_track_is_cut_on_its_own_frame_grid(self):
        rendition = self.rendition(1)
        self.assertTrue(rendition.copy)
        self.assertEqual(rendition.frames, 258)
        self.assertEqual(rendition.count, 7)
        self.assertTrue(app.live_file(rendition, 3, 30))
        segment = self.read(rendition, "s3.m4s")
        offset = segment.index(b"tfdt")
        self.assertEqual(int.from_bytes(segment[offset + 8:offset + 16], "big"), 3 * 258 * 1024)

    def test_a_fragment_waits_for_its_samples_while_ffmpeg_writes(self):
        output = os.path.join(self.directory.name, "whole")
        os.makedirs(output)
        subprocess.run(app.copy_command(self.url, output, 0, 0), check=True, capture_output=True)
        with open(os.path.join(output, "copy.mp4"), "rb") as source:
            data = source.read()
        growing = os.path.join(self.directory.name, "growing")
        os.makedirs(growing)
        splitter = app.CopySplitter(growing, 258, 0, 44100, 7, 40.0)
        with open(os.path.join(growing, "copy.mp4"), "wb") as copy:
            for offset in range(0, len(data), 7919):  # cuts boxes at arbitrary bytes
                copy.write(data[offset:offset + 7919])
                copy.flush()
                splitter.feed()
        splitter.feed(finished=True)
        reference = os.path.join(self.directory.name, "reference")
        os.makedirs(reference)
        os.replace(os.path.join(output, "copy.mp4"), os.path.join(reference, "copy.mp4"))
        app.CopySplitter(reference, 258, 0, 44100, 7, 40.0).feed(finished=True)
        for index in range(7):
            with open(os.path.join(growing, f"s{index}.m4s"), "rb") as one, open(os.path.join(reference, f"s{index}.m4s"), "rb") as other:
                self.assertEqual(one.read(), other.read(), index)

    def copied(self, name):
        output = os.path.join(self.directory.name, name)
        os.makedirs(output)
        subprocess.run(app.copy_command(self.url, output, 0, 0), check=True, capture_output=True)
        return output

    def test_a_stopped_run_keeps_its_unfinished_segment_out(self):
        output = self.copied("stopped")
        with open(os.path.join(output, "copy.mp4"), "rb") as source:
            data = source.read()
        cut = data.index(b"moof", len(data) // 2) - 4
        with open(os.path.join(output, "copy.mp4"), "wb") as copy:
            copy.write(data[:cut])
        app.CopySplitter(output, 258, 0, 44100, 7, 40.0).feed(finished=True)
        written = sorted(name for name in os.listdir(output) if name.endswith(".m4s"))
        self.assertLess(len(written), 7)
        last = max(int(name[1:-4]) for name in written)
        with open(os.path.join(output, f"s{last}.m4s"), "rb") as segment:
            data = segment.read()
        offset = data.index(b"trun")
        self.assertEqual(int.from_bytes(data[offset + 8:offset + 12], "big"), 258, "only whole segments")

    def test_a_listed_segment_past_the_audio_gets_its_last_frame(self):
        output = self.copied("longer")
        app.CopySplitter(output, 258, 0, 44100, 8, 40.0).feed(finished=True)
        with open(os.path.join(output, "s7.m4s"), "rb") as segment:
            data = segment.read()
        offset = data.index(b"tfdt")
        self.assertEqual(int.from_bytes(data[offset + 8:offset + 16], "big"), 7 * 258 * 1024)

    def test_a_run_started_past_the_audio_closes_the_last_listed_segment(self):
        output = self.copied("past")
        app.CopySplitter(output, 258, 7, 44100, 8, 40.0).feed(finished=True)
        self.assertEqual(sorted(name for name in os.listdir(output) if name.endswith(".m4s")), ["s7.m4s"])

    def test_segments_from_any_position_are_the_same_and_hold_the_original_frames(self):
        whole, seeked = self.rendition(1), self.rendition(2)
        for index in range(whole.count):
            self.assertTrue(app.live_file(whole, index, 30), index)
        self.assertTrue(app.live_file(seeked, 4, 30))
        self.assertEqual(self.read(seeked, "s4.m4s"), self.read(whole, "s4.m4s"))
        joined = os.path.join(self.directory.name, "joined.mp4")
        with open(joined, "wb") as output:
            output.write(self.read(whole, "init.mp4"))
            for index in range(whole.count):
                output.write(self.read(whole, f"s{index}.m4s"))
        self.assertEqual(self.packets(joined), self.packets(self.path), "every frame is copied as it is")
        deadline = time.monotonic() + 5
        while app.running() and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertEqual(whole.failures, 0, "a track that ends inside its last segment is complete")


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


    def test_a_slow_probe_carries_on_in_the_background_and_is_found_cached(self):
        fetched = threading.Event()
        def run(command, **options):
            fetched.wait(5)
            return mock.Mock(stdout=json.dumps({"streams": [{"codec_name": "aac"}]}).encode())
        with mock.patch.object(app.subprocess, "run", side_effect=run) as ffprobe:
            self.assertIsNone(app.probe_audio_soon(HASH, 1, wait=0.05))
            self.assertIsNone(app.probe_audio_soon(HASH, 1, wait=0.05), "the second lookup joins the running probe")
            fetched.set()
            streams = app.probe_audio_soon(HASH, 1, wait=5)
        self.assertEqual(streams[0]["codec_name"], "aac")
        self.assertEqual(ffprobe.call_count, 1)
        self.assertEqual(ffprobe.call_args.kwargs["timeout"], app.PROBE_BACKGROUND_SECONDS)


    def test_a_background_probe_that_times_out_leaves_the_file_pending(self):
        with mock.patch.object(app.subprocess, "run", side_effect=subprocess.TimeoutExpired("ffprobe", 180)) as ffprobe:
            self.assertIsNone(app.probe_audio_soon(HASH, 1, wait=5))
        self.assertEqual(ffprobe.call_count, 1, "the waiting lookup does not probe again itself")


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

    def test_eviction_skips_directories_removed_meanwhile(self):
        self.rendition("kept", 10, 0)
        real_size = app.directory_size

        def vanishing(path):
            if path.endswith("kept"):
                raise FileNotFoundError(path)
            return real_size(path)

        with mock.patch.object(app, "directory_size", side_effect=vanishing):
            app.evict()


class EmbeddedInfoTests(unittest.TestCase):
    def test_lists_text_subtitles_by_their_ffmpeg_number_and_fonts_by_index(self):
        probe = {"format": {"duration": "1420.5"}, "streams": [
            {"index": 0, "codec_type": "video", "codec_name": "h264"},
            {"index": 1, "codec_type": "subtitle", "codec_name": "hdmv_pgs_subtitle"},
            {"index": 2, "codec_type": "subtitle", "codec_name": "ass", "tags": {"title": " Надписи ", "language": "rus"}},
            {"index": 3, "codec_type": "subtitle", "codec_name": "subrip"},
            {"index": 4, "codec_type": "attachment", "codec_name": "ttf", "extradata_size": 1000,
             "tags": {"filename": "Font.TTF", "mimetype": "application/x-truetype-font"}},
            {"index": 5, "codec_type": "attachment", "codec_name": "otf", "extradata_size": 900,
             "tags": {"filename": "noext", "mimetype": "application/vnd.ms-opentype"}},
            {"index": 6, "codec_type": "attachment", "extradata_size": 50, "tags": {"filename": "cover.jpg", "mimetype": "image/jpeg"}},
            {"index": 7, "codec_type": "attachment", "extradata_size": app.MAX_FONT_BYTES + 1, "tags": {"filename": "huge.ttf"}},
            {"index": 8, "codec_type": "attachment", "extradata_size": 0, "tags": {"filename": "empty.ttf"}},
        ]}
        self.assertEqual(app.embedded_info(probe), {
            "subtitles": [
                {"stream": 1, "codec": "ass", "title": "Надписи", "language": "rus"},
                {"stream": 2, "codec": "subrip", "title": "", "language": ""},
            ],
            "fonts": [4, 5],
            "duration": 1420.5,
        })

    def test_fonts_stop_at_the_total_limit(self):
        size = app.MAX_EMBEDDED_FONT_BYTES // 2
        probe = {"streams": [
            {"index": index, "codec_type": "attachment", "extradata_size": size, "tags": {"filename": f"{index}.ttf"}}
            for index in range(3)
        ]}
        with mock.patch.object(app, "MAX_FONT_BYTES", size):
            self.assertEqual(app.embedded_info(probe)["fonts"], [0, 1])


class SubtitleWindowTests(unittest.TestCase):
    def track(self, duration=1000.0):
        return app.SubtitleTrack(HASH, 13, 0, duration)

    def run_at(self, start, end, began):
        run = app.SubtitleRun(mock.Mock(), start, end, "x")
        run.began = began
        return run

    def test_a_position_outside_every_window_starts_a_little_earlier(self):
        self.assertEqual(app.next_window(self.track(), 300, 0), 290)
        self.assertEqual(app.next_window(self.track(), 4, 0), 0)

    def test_a_covered_position_waits_until_the_window_runs_low(self):
        track = self.track()
        track.done = [(100, 250)]
        self.assertIsNone(app.next_window(track, 150, 0))
        self.assertEqual(app.next_window(track, 200, 0), 250)
        track.run = self.run_at(250, 400, 0)
        self.assertIsNone(app.next_window(track, 200, 0), "the next window is already running")

    def test_the_end_of_the_video_needs_no_more_windows(self):
        track = self.track(duration=260)
        track.done = [(100, 260)]
        self.assertIsNone(app.next_window(track, 255, 0))

    def test_a_running_window_serves_positions_it_will_soon_reach(self):
        track = self.track()
        track.run = self.run_at(100, 250, 0)
        self.assertIsNone(app.next_window(track, 120, 0))
        # After 10 s it has read at most 100 + 30 + 20 = 150 seconds.
        self.assertIsNone(app.next_window(track, 155, 10))
        self.assertEqual(app.next_window(track, 200, 10), 190, "a jump far ahead restarts there")
        self.assertEqual(app.next_window(track, 50, 10), 40, "a seek back restarts")

    def test_a_position_past_the_probed_end_needs_no_window(self):
        self.assertIsNone(app.next_window(self.track(duration=100), 115, 0))

    def test_windows_merge(self):
        self.assertEqual(app.add_covered([(0, 150), (300, 450)], 140, 310), [(0, 450)])
        self.assertEqual(app.add_covered([(300, 450)], 0, 150), [(0, 150), (300, 450)])


@unittest.skipUnless(shutil.which("ffmpeg"), "needs ffmpeg")
class EmbeddedSubtitleTests(unittest.TestCase):
    """Read events and fonts from a real Matroska file served over HTTP."""

    @classmethod
    def setUpClass(cls):
        cls.source = tempfile.TemporaryDirectory()
        events = "\n".join(
            f"Dialogue: 0,0:{second // 60:02d}:{second % 60:02d}.00,0:{(second + 4) // 60:02d}:{(second + 4) % 60:02d}.00,"
            f"Default,,0,0,0,,Line {second}"
            for second in range(0, 120, 5)
        )
        subtitles = os.path.join(cls.source.name, "subs.ass")
        with open(subtitles, "w") as output:
            output.write(
                "[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n\n[V4+ Styles]\n"
                "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
                "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
                "MarginR, MarginV, Encoding\nStyle: Default,Test Font,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,"
                "0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n\n[Events]\n"
                "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" + events + "\n"
            )
        srt = os.path.join(cls.source.name, "subs.srt")
        with open(srt, "w") as output:
            output.write("".join(
                f"{number + 1}\n00:{second // 60:02d}:{second % 60:02d},000 --> 00:{second // 60:02d}:{second % 60:02d},900\n"
                f"<i>Plain {second}</i>\n\n"
                for number, second in enumerate(range(2, 120, 10))
            ))
        cls.font = os.path.join(cls.source.name, "Test.ttf")
        with open(cls.font, "wb") as output:
            output.write(b"\x00\x01\x00\x00font bytes" * 100)
        path = os.path.join(cls.source.name, "video.mkv")
        subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x36:r=5:d=120",
            "-i", subtitles, "-i", srt, "-attach", cls.font, "-metadata:s:t", "mimetype=application/x-truetype-font",
            "-map", "0:v", "-map", "1:s", "-map", "2:s", "-c:v", "mpeg4", "-g", "10", "-c:s", "copy",
            "-metadata:s:s:0", "title=Full", path,
        ], check=True)
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), RangeHandler)
        cls.server.path = path
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}/video.mkv"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.source.cleanup()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        for name, value in (("stream_url", mock.Mock(return_value=self.url)), ("CACHE_DIR", self.directory.name),
                            ("SUB_BURST", 300), ("require_video_file", mock.Mock())):
            patcher = mock.patch.object(app, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        app._embedded_cache.clear()
        app._subs.clear()
        self.addCleanup(stop_live, self.directory.name)

    def events(self, position, offset=0, wait=20):
        deadline = time.monotonic() + wait
        serial = app._subs[(HASH, 13, 0)].serial if (HASH, 13, 0) in app._subs else None
        while True:
            payload = app.subtitle_events(HASH, 13, 0, position, offset, serial)
            track = app._subs[(HASH, 13, 0)]
            if (payload["lines"] and track.run is None) or time.monotonic() > deadline:
                return payload
            time.sleep(0.2)

    def test_reads_events_from_the_playback_position_onwards(self):
        info = app.probe_embedded(HASH, 13)
        self.assertEqual(info["subtitles"], [
            {"stream": 0, "codec": "ass", "title": "Full", "language": ""},
            {"stream": 1, "codec": "subrip", "title": "", "language": ""},
        ])
        self.assertEqual(len(info["fonts"]), 1)
        first = self.events(60)
        self.assertIn("[Events]", first["header"])
        self.assertIn("Style: Default,Test Font", first["header"])
        starts = [int(line.rsplit(" ", 1)[1]) for line in first["lines"]]
        self.assertIn(50, starts)
        self.assertEqual(starts[-1], 115)
        self.assertTrue(all(start >= 40 for start in starts), starts)
        self.assertEqual(app._subs[(HASH, 13, 0)].done, [(50.0, 120.0)])
        # A seek back reads the beginning; overlapping events are not repeated.
        more = self.events(3, first["next"])
        self.assertIsNone(more["header"])
        everything = first["lines"] + more["lines"]
        self.assertEqual(len(everything), len(set(everything)))
        self.assertEqual(len(everything), 24)

    def test_a_window_without_events_still_counts_as_read(self):
        app.probe_embedded(HASH, 13)
        with mock.patch.object(app, "SUB_WINDOW", 3):
            app.subtitle_events(HASH, 13, 0, 121.5, 0)  # 111.5–114.5 has no event start
        track = app._subs[(HASH, 13, 0)]
        deadline = time.monotonic() + 10
        while track.run and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertEqual(track.failures, 0)
        self.assertEqual(track.done, [(111.5, 114.5)])

    def test_a_forgotten_track_resends_its_events_from_the_start(self):
        app.probe_embedded(HASH, 13)
        first = self.events(100)
        app._subs.clear()
        again = self.events(100, first["next"])
        self.assertNotEqual(again["track"], first["track"])
        self.assertIsNotNone(again["header"])
        self.assertEqual(again["lines"], first["lines"])

    def test_extracts_font_attachments(self):
        info = app.probe_embedded(HASH, 13)
        with mock.patch.object(app, "keep_font") as keep:
            path = app.fetch_attachment(HASH, 13, info["fonts"][0])
        with open(path, "rb") as extracted, open(self.font, "rb") as original:
            self.assertEqual(extracted.read(), original.read())
        keep.assert_called_once_with(path)

    def test_text_subtitles_are_converted_to_ass(self):
        app.probe_embedded(HASH, 13)
        deadline = time.monotonic() + 20
        while True:
            payload = app.subtitle_events(HASH, 13, 1, 30, 0)
            if (payload["lines"] and app._subs[(HASH, 13, 1)].run is None) or time.monotonic() > deadline:
                break
            time.sleep(0.2)
        self.assertEqual(payload["header"], app.CONVERTED_HEADER)
        self.assertIn("Dialogue: 0,0:00:32.00,0:00:32.90,Default,,0,0,0,,{\\i1}Plain 32{\\i0}", payload["lines"])
        self.assertFalse(payload["failed"])

    def test_only_probed_text_streams_are_read(self):
        with self.assertRaises(app.Rejected):
            app.subtitle_events(HASH, 13, 0, 10, 0)
        app.probe_embedded(HASH, 13)
        with self.assertRaises(app.Rejected):
            app.subtitle_events(HASH, 13, 2, 10, 0)


def font(families, weight=400, italic=False, cyrillic=True, padding=0, glyphs=500):
    """A minimal TrueType font: a name table (Windows UTF-16 and Mac Roman
    family names), an OS/2 and a maxp table, padded to a size."""
    records, strings = [], b""
    for family in families:
        for platform, encoding, text in ((3, 1, family.encode("utf-16-be")), (1, 0, family.encode("mac_roman"))):
            records.append(struct.pack(">6H", platform, encoding, 0, 1, len(text), len(strings)))
            strings += text
    name = struct.pack(">3H", 0, len(records), 6 + 12 * len(records)) + b"".join(records) + strings
    os2 = bytearray(78)
    struct.pack_into(">H", os2, 4, weight)
    struct.pack_into(">I", os2, 42, 1 << 9 if cyrillic else 0)
    struct.pack_into(">H", os2, 62, 1 if italic else 0)
    tables = [(b"OS/2", bytes(os2)), (b"maxp", struct.pack(">IH", 0x00005000, glyphs)), (b"name", name)]
    offset = 12 + 16 * len(tables)
    head, body = struct.pack(">IHHHH", 0x00010000, len(tables), 0, 0, 0), b""
    for tag, data in tables:
        head += struct.pack(">4sIII", tag, 0, offset + len(body), len(data))
        body += data
    return head + body + bytes(padding)


def collection(*fonts):
    """A TrueType collection of fonts built by font()."""
    head = struct.pack(">4sII", b"ttcf", 0x00010000, len(fonts))
    start = len(head) + 4 * len(fonts)
    offsets, body = [], b""
    for data in fonts:
        offsets.append(start + len(body))
        # Table offsets count from the start of the file.
        count = struct.unpack_from(">H", data, 4)[0]
        moved = bytearray(data)
        for number in range(count):
            record = 12 + 16 * number
            struct.pack_into(">I", moved, record + 8, struct.unpack_from(">I", data, record + 8)[0] + start + len(body))
        body += bytes(moved)
    return head + struct.pack(f">{len(offsets)}I", *offsets) + body


class FontLibraryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.library = os.path.join(self.directory.name, "library")
        os.mkdir(self.library)
        patcher = mock.patch.object(app, "FONT_LIBRARY_DIR", self.library)
        patcher.start()
        self.addCleanup(patcher.stop)
        app._library.update(faces={}, index=None)

    def keep(self, data, name="font"):
        path = os.path.join(self.directory.name, name)
        with open(path, "wb") as output:
            output.write(data)
        app.keep_font(path)

    def test_reads_family_names_weight_slant_and_cyrillic(self):
        def faces(data):
            return app.font_faces(io.BytesIO(data))
        self.assertEqual(faces(font(["Tahoma"], weight=700, italic=True, cyrillic=False, glyphs=900)), [
            {"families": ["tahoma"], "weight": 700, "italic": True, "cyrillic": False, "glyphs": 900},
        ])
        self.assertEqual([face["families"] for face in faces(collection(font(["MS Gothic"]), font(["MS PGothic"])))],
                         [["ms gothic"], ["ms pgothic"]])
        self.assertEqual(faces(b"wOF2" + bytes(100)), [])
        self.assertEqual(faces(b"\x00\x01\x00\x00\x00\x09"), [], "a truncated font is not a font")

    def test_keeps_each_font_once_and_nothing_else(self):
        self.keep(font(["Viking"]))
        self.keep(font(["Viking"]), "again")
        self.keep(b"not a font")
        self.keep(font(["Times New Roman"], glyphs=80), "subset")
        self.keep(collection(font(["MS Gothic"])), "ttc")
        self.assertEqual(sorted(os.path.splitext(name)[1] for name in os.listdir(self.library)), [".ttc", ".ttf"])

    def test_the_library_has_a_size_limit(self):
        with mock.patch.object(app, "FONT_LIBRARY_MAX_BYTES", 1500):
            self.keep(font(["One"], padding=1000))
            self.keep(font(["Two"], padding=1000))
        self.assertEqual(len(os.listdir(self.library)), 1)

    def test_a_partial_file_renamed_meanwhile_does_not_stop_keeping(self):
        partial = os.path.join(self.library, "x.part")
        with open(partial, "wb") as output:
            output.write(b"x")
        real_scandir = os.scandir

        def scandir(path):
            entries = list(real_scandir(path))
            os.unlink(partial)  # gone between listing and stat
            return iter(entries)
        with mock.patch.object(app.os, "scandir", scandir):
            self.keep(font(["Viking"]))
        self.assertEqual(len(os.listdir(self.library)), 1)

    def test_nothing_is_kept_without_a_library(self):
        with mock.patch.object(app, "FONT_LIBRARY_DIR", ""):
            self.keep(font(["Viking"]))
            self.assertEqual(app.library_index(), {"fonts": {}, "families": {}})
        self.assertEqual(os.listdir(self.library), [])

    def test_index_maps_jassub_keys_to_the_best_version(self):
        def name(data):
            for item in os.listdir(self.library):
                with open(os.path.join(self.library, item), "rb") as source:
                    if source.read() == data:
                        return item
        regular = font(["Impact"], padding=100)
        latin = font(["Impact"], cyrillic=False, padding=5000)
        bold = font(["Impact"], weight=700)
        italic = font(["Impact"], italic=True, padding=9000)
        black = font(["Arial Black"], weight=900)
        for number, data in enumerate((regular, latin, bold, italic, black)):
            self.keep(data, str(number))
        index = app.library_index()
        self.assertEqual(index["fonts"]["impact"], name(regular), "upright with Cyrillic before a bigger font")
        self.assertEqual(index["fonts"]["impact regular"], name(regular))
        self.assertEqual(index["fonts"]["impact bold"], name(bold))
        self.assertEqual(index["fonts"]["arial black"], name(black))
        self.assertEqual(index["families"]["impact"], [name(regular), name(bold)])
        self.assertEqual(index["families"]["arial black"], [name(black)])

    def test_index_follows_files_added_and_removed(self):
        self.keep(font(["Tahoma"]))
        self.assertIn("tahoma", app.library_index()["fonts"])
        # Fonts copied in by hand count too.
        with open(os.path.join(self.library, "0" * 32 + ".ttf"), "wb") as output:
            output.write(font(["Georgia"]))
        os.unlink(os.path.join(self.library, app.library_index()["fonts"]["tahoma"]))
        self.assertEqual(set(app.library_index()["families"]), {"georgia"})
        with open(os.path.join(self.library, "0" * 32 + ".ttf"), "wb") as output:
            output.write(font(["Verdana"], padding=10))  # rewritten in place
        self.assertEqual(set(app.library_index()["families"]), {"verdana"})


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
            f"/extaudio/{HASH}/1/0/aac/..%2F..%2Fetc%2Fpasswd",
            f"/extaudio/{HASH}/1/0/copy/audio.m3u8",
            f"/extaudio/{HASH}/1/0/aac/other.txt",
            f"/extaudio/{HASH}/1/0/flac/audio.m3u8",
            f"/extaudio/{HASH}/1/0/audio.m3u8",
            "/extaudio/not-a-hash/1/tracks",
            f"/extaudio/{HASH}/1/0/aac/../tracks",
        ):
            with self.subTest(path=path):
                self.assertEqual(self.get(path)[0], 404)

    def test_embedded_events_and_fonts_need_a_probed_video(self):
        app._embedded_cache.clear()
        app._embedded_cache[(HASH, 13, "embedded")] = {
            "subtitles": [{"stream": 0, "codec": "subrip", "title": "", "language": ""}], "fonts": [3], "duration": 60.0,
        }
        self.addCleanup(app._embedded_cache.clear)
        patcher = mock.patch.object(app, "probe_embedded", side_effect=app.Rejected("not a video"))
        probe = patcher.start()
        self.addCleanup(patcher.stop)
        for path, status in (
            (f"/extaudio/{HASH}/14/sub/0?at=10", 404),
            (f"/extaudio/{HASH}/13/sub/1?at=10", 404),  # no such stream
            (f"/extaudio/{HASH}/13/sub/0?at=-1", 400),
            (f"/extaudio/{HASH}/13/sub/0?at=1&from=x", 400),
            (f"/extaudio/{HASH}/13/attachment/4", 404),
            (f"/extaudio/{HASH}/14/attachment/3", 404),
            (f"/extaudio/{HASH}/13/attachment/..", 404),
        ):
            with self.subTest(path=path):
                self.assertEqual(self.get(path)[0], status)
        self.assertEqual(probe.call_count, 2, "an unprobed file is probed again, as after a restart")

    def test_a_torrent_without_its_file_list_yet_is_asked_again(self):
        app._embedded_cache.clear()
        with mock.patch.object(app, "torrent_files", return_value=[]):
            status, headers, _ = self.get(f"/extaudio/{HASH}/13/embedded")
        self.assertEqual(status, 503)
        self.assertEqual(headers["Retry-After"], "3")

    def test_encoded_playlist_is_immediate_and_starts_at_the_position(self):
        rendition = mock.Mock(count=1000, segment_seconds=app.SEGMENT_SECONDS, directory=app.rendition_dir(HASH, 1, 0, "aac"), **{"owner.return_value": None})
        def create(torrent_hash, file_id, stream):
            directory = app.rendition_dir(torrent_hash, file_id, stream, "aac")
            os.makedirs(directory, exist_ok=True)
            with open(os.path.join(directory, "audio.m3u8"), "w") as playlist:
                playlist.write("#EXTM3U\n")
            return rendition

        with mock.patch.object(app, "torrent_files", return_value=FILES), \
                mock.patch.object(app, "live_rendition", side_effect=create), \
                mock.patch.object(app, "start_run") as start:
            status, headers, body = self.get(f"/extaudio/{HASH.upper()}/1/0/aac/audio.m3u8?at=600")
        self.assertEqual((status, body), (200, b"#EXTM3U\n"))
        self.assertEqual(headers["Content-Type"], "application/vnd.apple.mpegurl")
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
            (mock.Mock(return_value=FILES), f"/extaudio/{HASH}/13/0/aac/audio.m3u8"),
            (mock.Mock(return_value=FILES), f"/extaudio/{HASH}/77/0/aac/audio.m3u8"),
            (mock.Mock(side_effect=unknown), f"/extaudio/{HASH}/1/0/aac/audio.m3u8"),
        )
        for files, path in cases:
            with self.subTest(path=path), mock.patch.object(app, "torrent_files", files), \
                    mock.patch.object(app, "live_rendition") as live:
                self.assertEqual(self.get(path)[0], 404)
                live.assert_not_called()

    def test_tracks_endpoint(self):
        tracks = [{"file": 1, "stream": 0, "title": "AniLibria.tv"}]
        with mock.patch.object(app, "torrent_files", return_value=SUB_FILES), \
                mock.patch.object(app, "external_tracks", return_value=(tracks, True)), \
                tempfile.TemporaryDirectory() as directory, mock.patch.object(app, "RENDERER_DIR", directory):
            open(os.path.join(directory, "jassub.js"), "w").close()
            status, _, body = self.get(f"/extaudio/{HASH}/13/tracks")
        payload = json.loads(body)
        self.assertEqual((status, payload["tracks"], payload["pending"], payload["renderer"]), (200, tracks, True, "/extaudio/jassub/"))
        self.assertEqual([item["file"] for item in payload["subtitles"]], [27, 25])

    def test_tracks_endpoint_waits_for_the_file_list(self):
        with mock.patch.object(app, "torrent_files", return_value=[]), \
                mock.patch.object(app, "external_tracks") as tracks:
            status, _, body = self.get(f"/extaudio/{HASH}/13/tracks")
        self.assertEqual((status, json.loads(body)["pending"]), (200, True))
        tracks.assert_not_called()

    def test_raw_endpoint(self):
        files = [*SUB_FILES, *({"id": 50 + n, "path": f"Show/Fonts/f{n}.ttf", "length": 1000} for n in range(10))]
        real_urlopen = urllib.request.urlopen
        def urlopen(url, timeout):
            if url.startswith(self.base):
                return real_urlopen(url, timeout=timeout)
            response = mock.MagicMock()
            source = __import__("io").BytesIO(b"x" * 1000)
            def read(size):
                time.sleep(0.05)
                return source.read(size)
            response.__enter__.return_value.read.side_effect = read
            return response
        with mock.patch.object(app, "torrent_files", return_value=files), \
                mock.patch.object(app.urllib.request, "urlopen", side_effect=urlopen), \
                tempfile.TemporaryDirectory() as directory, mock.patch.object(app, "CACHE_DIR", directory):
            # JASSUB requests every font at once and never retries.
            results = [None] * 12
            def fetch(slot, file_id):
                results[slot] = self.get(f"/extaudio/{HASH}/{file_id}/raw")
            threads = [threading.Thread(target=fetch, args=(slot, file_id))
                       for slot, file_id in enumerate([*range(50, 60), 40, 27])]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            self.assertEqual([result[0] for result in results], [200] * 12)
            self.assertEqual(results[0][1]["Content-Type"], "application/octet-stream")
            self.assertEqual(len(results[0][2]), 1000)
            with mock.patch.object(app, "torrent_files", side_effect=AssertionError("cached files skip lookups")):
                self.assertEqual(self.get(f"/extaudio/{HASH}/27/raw")[0], 200)
            self.assertEqual(self.get(f"/extaudio/{HASH}/13/raw")[0], 404)

    def test_renderer_files_are_served_with_their_types(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(app, "RENDERER_DIR", directory):
            for name in ("jassub.js", "jassub-worker.wasm"):
                with open(os.path.join(directory, name), "wb") as target:
                    target.write(b"x")
            self.assertEqual(self.get("/extaudio/jassub/jassub-worker.wasm")[1]["Content-Type"], "application/wasm")
            self.assertEqual(self.get("/extaudio/jassub/jassub.js")[1]["Content-Type"], "text/javascript")
            self.assertEqual(self.get("/extaudio/jassub/missing.js")[0], 404)
            self.assertEqual(self.get("/extaudio/jassub/..%2Fapp.py")[0], 404)

    def test_library_fonts_and_their_index(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(app, "FONT_LIBRARY_DIR", directory):
            app._library.update(faces={}, index=None)
            name = "a" * 32 + ".ttf"
            with open(os.path.join(directory, name), "wb") as output:
                output.write(font(["Trebuchet MS"]))
            status, _, body = self.get("/extaudio/fonts/index.json")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)["fonts"]["trebuchet ms"], name)
            self.assertEqual(self.get("/extaudio/fonts/" + name)[2], font(["Trebuchet MS"]))
            for path in ("/extaudio/fonts/" + "b" * 32 + ".ttf", "/extaudio/fonts/..%2Fapp.py", "/extaudio/fonts/x.ttf"):
                with self.subTest(path=path):
                    self.assertEqual(self.get(path)[0], 404)

    def test_track_lookups_are_bounded(self):
        for _ in range(app.MAX_TRACK_LOOKUPS):
            app._track_lookups.acquire()
        try:
            status, headers, _ = self.get(f"/extaudio/{HASH}/13/tracks")
        finally:
            for _ in range(app.MAX_TRACK_LOOKUPS):
                app._track_lookups.release()
        self.assertEqual((status, headers["Retry-After"]), (429, "5"))

    def post(self, path, body, content_type="application/json"):
        request = urllib.request.Request(self.base + path, data=body, method="POST", headers={"Content-Type": content_type})
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status
        except urllib.error.HTTPError as error:
            with error:
                return error.code

    def logged(self, *requests):
        app._log_window.update(start=0.0, count=0)
        with mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            statuses = [self.post(*request) for request in requests]
        return statuses, output.getvalue().splitlines()

    def test_client_events_become_one_greppable_line_each(self):
        event = {"e": "hls-error", "s": "k3j2", "h": "bc7b45c4", "f": 13, "t": 61.3, "fatal": True,
                 "path": "/gst/501/seg7.m4s", "reason": "x" * 500, "ts": "forged", "nested": {"a": 1},
                 "bad key": 1, "big": 10 ** 30}
        statuses, lines = self.logged(("/extaudio/log", json.dumps(event).encode()))
        self.assertEqual(statuses, [204])
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("client {"))
        logged = json.loads(lines[0][len("client "):])
        self.assertRegex(logged.pop("ts"), r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
        self.assertEqual(logged.pop("reason"), "x" * app.LOG_MAX_TEXT)
        self.assertEqual(logged, {"e": "hls-error", "s": "k3j2", "h": "bc7b45c4", "f": 13, "t": 61.3, "fatal": True,
                                  "path": "/gst/501/seg7.m4s"})

    def test_client_events_reject_other_bodies(self):
        statuses, lines = self.logged(
            ("/extaudio/log", b'{"e": "x"}', "text/plain"),
            ("/extaudio/log", b"not json"),
            ("/extaudio/log", b"[1, 2]"),
            ("/extaudio/log", b"[" * 3000),
            ("/extaudio/log", json.dumps({"e": "x" * app.LOG_MAX_BYTES}).encode()),
            ("/extaudio/other", b'{"e": "x"}'),
        )
        self.assertEqual(statuses, [415, 400, 400, 400, 413, 404])
        self.assertEqual(lines, [])
        self.assertEqual(self.get("/extaudio/log")[0], 404)

    def test_client_event_text_cannot_split_the_line(self):
        event = {"e": "ass-failed", "reason": "one\ntwo\r\u2028three\u2029four\x00five", "ts\n": 1, "Ts": "forged"}
        statuses, lines = self.logged(("/extaudio/log", json.dumps(event).encode()))
        self.assertEqual(statuses, [204])
        self.assertEqual(len(lines), 1)
        self.assertNotIn("\u2028", lines[0])
        logged = json.loads(lines[0][len("client "):])
        self.assertEqual(logged["reason"], "onetwothreefourfive")
        self.assertEqual(set(logged), {"ts", "e", "reason"})

    def test_client_events_need_a_content_length(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=5)
        self.addCleanup(connection.close)
        connection.putrequest("POST", "/extaudio/log")
        connection.putheader("Content-Type", "application/json")
        connection.endheaders()
        self.assertEqual(connection.getresponse().status, 411)

    def test_client_events_are_rate_limited(self):
        with mock.patch.object(app, "LOG_PER_MINUTE", 2):
            statuses, lines = self.logged(*[("/extaudio/log", b'{"e": "x"}')] * 3)
        self.assertEqual(statuses, [204, 204, 429])
        self.assertEqual(len(lines), 2)
        self.assertTrue(app.log_allowed(time.monotonic() + 61), "a new minute starts afresh")


if __name__ == "__main__":
    unittest.main()
