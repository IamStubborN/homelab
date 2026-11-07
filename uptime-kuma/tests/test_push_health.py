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


if __name__ == "__main__":
    unittest.main()
