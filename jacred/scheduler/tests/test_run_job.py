import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


RUNNER = Path(__file__).parents[1] / "run-job.sh"


class JobOutcomeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        tools = self.root / "bin"
        tools.mkdir()
        # These tests exercise HTTP classification and persisted backoff only.
        for name, source in {
            "flock": '#!/bin/sh\nexit 0\n',
            "date": '#!/bin/sh\ncase "$*" in *"%u %H"*) echo "${TEST_TIME:-6 12}";; *"%s"*) echo 2000000000;; *) echo test-time;; esac\n',
            "curl": '''#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then output=$2; shift; fi
  shift
done
printf '%s' "$TEST_BODY" > "$output"
printf '%s' "${TEST_HTTP:-200}"
exit "${TEST_CURL_RC:-0}"
''',
        }.items():
            path = tools / name
            path.write_text(source)
            path.chmod(0o755)
        self.env = {**os.environ, "PATH": str(tools) + os.pathsep + os.environ["PATH"],
                    "LOCK_DIR": str(self.root / "locks"), "JACRED_BACKOFF_DIR": str(self.root / "backoff")}
        self.state = self.root / "backoff/bitru-parse"
        self.state.parent.mkdir()

    def run_job(self, job, body, **env):
        return subprocess.run([shutil.which("bash"), str(RUNNER), job, "http://example.invalid/cron", "10"],
                              env={**self.env, "TEST_BODY": body, **env}, capture_output=True, text=True)

    def test_positive_count_clears_backoff(self):
        self.state.write_text("1 0\n")
        self.assertEqual(self.run_job("bitru-parse", "saved 3").returncode, 0)
        self.assertFalse(self.state.exists())

    def test_empty_and_unknown_responses_preserve_backoff(self):
        for reply in ("no items", "saved 0", "", "<html>challenge</html>"):
            with self.subTest(reply=reply):
                self.state.write_text("2 0\n")
                self.assertEqual(self.run_job("bitru-parse", reply).returncode, 2)
                self.assertEqual(self.state.read_text(), "2 0\n")

    def test_http_failure_records_capped_backoff(self):
        self.state.write_text("2 0\n")
        self.assertEqual(self.run_job("bitru-parse", "ok", TEST_HTTP="503").returncode, 1)
        self.assertEqual(self.state.read_text(), "3 2000086400\n")

    def test_save_failure_does_not_acquire_crawler_backoff(self):
        self.assertEqual(self.run_job("save", "", TEST_CURL_RC="28").returncode, 1)
        self.assertEqual(list(self.state.parent.iterdir()), [])

    def test_reserved_window_skips_without_changing_backoff(self):
        self.state.write_text("1 0\n")
        for moment in ("3 05", "7 11"):
            with self.subTest(moment=moment):
                result = self.run_job("bitru-parse", "saved 3", TEST_TIME=moment)
                self.assertEqual(result.returncode, 0)
                self.assertIn("reserved backup window", result.stdout)
                self.assertEqual(self.state.read_text(), "1 0\n")

    def test_update_hour_is_not_reserved(self):
        result = self.run_job("bitru-parse", "saved 3", TEST_TIME="7 04")
        self.assertNotIn("reserved backup window", result.stdout)

    def test_category_failures_and_partial_knaben_results_are_unknown(self):
        for job, reply in (("rutor-parse", "1 - 1 / True 2 - 1 / False"),
                           ("knaben-parse", "fetched=5 +2 ~1 =1 failed=1")):
            with self.subTest(job=job):
                result = self.run_job(job, reply)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
