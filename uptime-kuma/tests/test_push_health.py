import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("push_health", Path(__file__).parents[1] / "tools/push-health.py")
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)


class HealthCheckTests(unittest.TestCase):
    def test_docker_health_and_absence_are_distinct(self):
        healthy = {"name": "/worker", "state": "running", "health": "healthy", "oom": False}
        self.assertEqual(health.container_status(healthy)[0], "up")
        for change in [{"health": "unhealthy"}, {"state": "restarting"}, {"oom": True}]:
            self.assertEqual(health.container_status({**healthy, **change})[0], "down")
        self.assertEqual(health.container_status(None)[0], "down")
        self.assertIn("no native healthcheck", health.container_status({**healthy, "health": None})[1])

    def test_missing_container_does_not_discard_other_inspect_rows(self):
        row = '{"name":"/worker","state":"running","health":"healthy","exit_code":0,"oom":false}\n'
        with patch.object(health.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout=row)):
            result = health.collect({"containers": [{"name": "worker"}, {"name": "missing"}]})
        self.assertEqual([x[1] for x in result], ["up", "down"])

    def test_capacity_threshold_handles_large_almost_full_disks(self):
        with patch.object(health.os, "statvfs", return_value=SimpleNamespace(f_blocks=1000, f_bavail=10, f_frsize=2**30)):
            status, message = health.capacity_status("/media", 5, 5 * 2**30)
        self.assertEqual(status, "down")
        self.assertIn("1.0% free", message)
        self.assertIn("/media: Low free space", message)
        self.assertIn("1000.0 GiB total", message)
        self.assertIn("required >= 5%", message)

    def test_failed_docker_source_cannot_publish_success(self):
        with patch.object(health.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout="")):
            with self.assertRaisesRegex(RuntimeError, "Docker state unavailable"):
                health.collect({"containers": [{"name": "worker"}]})

    def test_missing_mount_cannot_report_parent_filesystem_as_healthy(self):
        with patch.object(health.os.path, "ismount", return_value=False), patch.object(health.os, "statvfs") as stat:
            result = health.collect({"mounts": [{"name": "media", "path": "/media", "require_mount": True}]})
        self.assertEqual(result[0][1], "down")
        stat.assert_not_called()

    def test_health_error_capture_is_private_bounded_and_deduplicated(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "errors.json"
            state = {"name": "/worker", "state": "running", "health": "unhealthy", "oom": False,
                     "health_log": [{"Start": "ok", "End": "ok", "ExitCode": 0, "Output": "success"},
                                    {"Start": "failed", "End": "end", "ExitCode": 1, "Output": "TimeoutError"}]}
            self.assertEqual(health.save_health_errors(path, state), 1)
            self.assertEqual(health.save_health_errors(path, state), 0)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            state["health_log"] = [{"Start": str(i), "End": str(i), "ExitCode": 1,
                                    "Output": "x" * 5000} for i in range(120)]
            health.save_health_errors(path, state)
            data = health.json.loads(path.read_text())
            self.assertEqual(len(data["entries"]), 100)
            self.assertEqual(data["entries"][0]["start"], "20")
            self.assertEqual(len(data["entries"][-1]["output"]), 4096)
            state["health_log"] = [{"Start": "recovered", "End": "end", "ExitCode": 0, "Output": ""}]
            self.assertEqual(health.save_health_errors(path, state), 0)
            self.assertEqual(health.json.loads(path.read_text()), data)

    def test_capture_failure_does_not_discard_heartbeats(self):
        row = '{"name":"/worker","state":"running","health":"healthy","oom":false,"health_log":[]}\n'
        config = {"containers": [{"name": "worker"}],
                  "health_error_capture": {"container": "worker", "path": "/private/errors.json"}}
        with patch.object(health.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=row)), \
                patch.object(health, "save_health_errors", side_effect=OSError("private detail")), \
                patch("builtins.print") as log:
            result = health.collect(config)
        self.assertEqual(result[0][1], "up")
        self.assertNotIn("private detail", str(log.call_args))


if __name__ == "__main__":
    unittest.main()
