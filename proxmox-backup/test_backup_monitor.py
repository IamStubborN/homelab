"""DNSBL hotfix check of backup-monitor.py with a fake qm; no guest access."""
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('backup_monitor', Path(__file__).with_name('backup-monitor.py'))
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


def qm(stdout, returncode=0):
    return subprocess.CompletedProcess([], returncode, stdout=stdout, stderr='')


class DnsblHotfixTests(unittest.TestCase):
    def check(self, result):
        with patch.object(m.subprocess, 'run', return_value=result) as run:
            applied = m.dnsbl_hotfix_applied(901)
        command = run.call_args.args[0]
        self.assertEqual(command[:4], ['qm', 'guest', 'exec', '901'])
        self.assertIn(m.DNSBL_HOTFIX_MARKER, command[-1])
        return applied

    def test_applied_when_both_files_match(self):
        self.assertTrue(self.check(qm(json.dumps({'exited': 1, 'exitcode': 0}))))

    def test_missing_when_grep_fails(self):
        self.assertFalse(self.check(qm(json.dumps({'exited': 1, 'exitcode': 1}))))

    def test_unfinished_guest_command_raises(self):
        with self.assertRaises(RuntimeError):
            self.check(qm(json.dumps({'exited': 0})))

    def test_agent_failure_raises(self):
        with self.assertRaises(ValueError):
            self.check(qm('', returncode=255))


if __name__ == '__main__':
    unittest.main()
