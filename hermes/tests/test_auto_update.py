import importlib.machinery
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
PINNED = "nousresearch/hermes-agent@sha256:" + "e" * 64
OLD_DIGEST = "sha256:" + "e" * 64
NEW_DIGEST = "sha256:" + "a" * 64
NEWER_DIGEST = "sha256:" + "b" * 64


def load_updater():
    path = ROOT / "scripts/hermes-auto-update"
    loader = importlib.machinery.SourceFileLoader("hermes_auto_update", str(path))
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
    loader.exec_module(module)
    return module


updater = load_updater()


def gateway_state(telegram="connected", writer_pid=7, updated_at="2100-01-01T00:00:00+00:00"):
    return {"active_agents": 0, "pid": 7, "start_time": 11, "platforms": {"telegram": {
        "state": telegram, "updated_at": updated_at, "writer_pid": writer_pid, "writer_start_time": 11}}}


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


class FakeHost:
    """Docker stand-in whose agents follow HERMES_IMAGE in the root .env."""

    def __init__(self, base: pathlib.Path):
        self.base = base
        self.root = base / "homelab"
        self.root.mkdir()
        (self.root / ".env").write_text("WIKI_ROOT=/srv/wiki\n", encoding="utf-8")
        os.chmod(self.root / ".env", 0o600)
        self.digest = NEW_DIGEST
        self.clock = 1_800_000_000.0
        self.calls = []
        self.messages = []
        self.latest = 41
        self.canary_code = 0
        self.canary_effect = None
        self.healthy_after_up = True
        self.scan_result = (0, "")
        self.after_up = None
        self.stop_effect = None
        self.agents_running = True
        self.starts = True
        self.after_restore_up = None
        self.hashes = {}
        self.images = {PINNED}
        self.containers = {}
        skills = base / "skills" / "media"
        skills.mkdir(parents=True)
        (skills / "MCP_SCHEMA.json").write_text(
            json.dumps({"schema_version": 1, "tools": [{"name": "media_jobs_list"}]}), encoding="utf-8"
        )
        for name in updater.SERVICES:
            profile = base / "volumes" / f"{name}-profile" / "_data"
            memory = base / "volumes" / f"{name}-memory" / "_data"
            for directory in (profile, memory, profile / "memories", profile / "tmp", profile / ".cache"):
                directory.mkdir(parents=True, exist_ok=True)
            (profile / "state.db").write_bytes(b"before")
            (profile / "config.base.yaml").write_text("_config_version: 41\n", encoding="utf-8")
            (profile / "gateway_state.json").write_text(json.dumps(gateway_state()), encoding="utf-8")
            (profile / "tmp" / "scratch").write_text("temporary", encoding="utf-8")
            (profile / ".cache" / "model.bin").write_text("cached", encoding="utf-8")
            (memory / "MEMORY.md").write_text("remembered", encoding="utf-8")
            managed = base / f"{name}-config.yaml"
            managed.write_text("model: x\n_config_version: 41\n", encoding="utf-8")
            self.hashes[name] = f"hash-{name}"
            self.containers[name] = {
                "Name": f"/{name}",
                "Image": "sha256:" + "1" * 64,
                "Config": {
                    "Image": PINNED,
                    "Env": ["PATH=/usr/bin", f"TELEGRAM_HOME_CHANNEL={name}",
                            "HERMES_GATEWAY_BOOTSTRAP_STATE=running"],
                    "Labels": {"com.docker.compose.config-hash": f"hash-{name}"},
                },
                "State": {"Health": {"Status": "healthy"}, "Running": True, "StartedAt": "2026-10-24T02:30:00.123456789Z"},
                "Mounts": [
                    {"Type": "volume", "Name": f"{name}-profile", "Destination": "/opt/data",
                     "Source": str(profile), "RW": True},
                    {"Type": "volume", "Name": f"{name}-memory", "Destination": "/opt/data/memories",
                     "Source": str(memory), "RW": True},
                    {"Type": "volume", "Name": "tools", "Destination": "/opt/tools",
                     "Source": str(base / "tools"), "RW": False},
                    {"Type": "bind", "Source": str(managed), "Destination": "/etc/hermes-home/config.yaml", "RW": False},
                    {"Type": "bind", "Source": str(base / "skills"), "Destination": "/etc/hermes-home/skills", "RW": False},
                    {"Type": "bind", "Source": "/srv/secret", "Destination": "/run/secrets/health_api_token", "RW": False},
                    {"Type": "bind", "Source": "/srv/wiki", "Destination": "/wiki", "RW": True},
                ],
            }

    def profile(self, name):
        return pathlib.Path(self.containers[name]["Mounts"][0]["Source"])

    def env_image(self):
        return updater.read_env_value(self.root / ".env", updater.ENV_KEY) or PINNED

    # Host interface ---------------------------------------------------------
    def registry_digest(self):
        return self.digest

    def inspect(self, name):
        container = json.loads(json.dumps(self.containers[name]))
        container["State"]["Running"] = self.agents_running
        return container

    def image_env(self, image):
        return ["PATH=/usr/bin"]

    def has_image(self, ref):
        return ref in self.images

    def pull(self, ref):
        self.calls.append(("pull", ref))
        self.images.add(ref)

    def remove_image(self, ref):
        self.calls.append(("rmi", ref))
        self.images.discard(ref)

    def tag(self, image_id, ref):
        self.calls.append(("tag", image_id, ref))

    def chown_tree(self, root):
        pass

    def compose_hash(self, service):
        return self.hashes[service]

    def compose_up(self):
        image = self.env_image()
        self.calls.append(("up", image))
        rolled_back = image == PINNED
        self.agents_running = True
        for container in self.containers.values():
            container["Config"]["Image"] = image
            healthy = rolled_back or self.healthy_after_up
            container["State"]["Health"]["Status"] = "healthy" if healthy else "unhealthy"
        if self.after_up and not rolled_back:
            self.after_up(self)
        if self.after_restore_up and rolled_back:
            self.after_restore_up(self)

    def stop(self):
        self.calls.append(("stop",))
        self.agents_running = False
        if self.stop_effect:
            self.stop_effect()

    def start(self):
        self.calls.append(("start",))

    def run(self, *args, check=True, timeout=None, cwd=None):
        self.calls.append(tuple(args[:2]))
        if args[:2] == ("docker", "stop"):
            self.agents_running = False
        elif args[:2] == ("docker", "start"):
            self.agents_running = self.starts
        return subprocess.CompletedProcess(args, 0, "", "")

    def running(self, name):
        return self.agents_running

    def scan(self, name):
        if self.env_image() == PINNED:
            return 0, ""
        return self.scan_result

    def canary(self, name, args):
        self.calls.append(("canary", name))
        if self.canary_effect:
            self.canary_effect(args)
        marker = json.dumps({"current": self.latest, "latest": self.latest})
        return self.canary_code, f"s6 boot\nHERMES_CANARY {marker}\n"

    def notify(self, text):
        self.messages.append(text)

    def sleep(self, seconds):
        self.clock += seconds

    def now(self):
        self.clock += 1
        return self.clock


class AutoUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = pathlib.Path(self.temporary.name)
        self.host = FakeHost(self.base)
        self.state = self.base / "state"
        self.state.mkdir(mode=0o700)

    def tearDown(self):
        self.temporary.cleanup()

    def run_updater(self, dry_run=False):
        return updater.Updater(self.host, self.host.root, self.state, dry_run=dry_run).run()

    def saved_state(self):
        return json.loads((self.state / "state.json").read_text())

    def env_lines(self):
        return (self.host.root / ".env").read_text().splitlines()

    def test_unchanged_upstream_does_nothing(self):
        self.host.digest = OLD_DIGEST
        self.assertEqual(self.run_updater(), 0)
        self.assertEqual(self.host.calls, [])
        self.assertEqual(self.host.messages, [])

    def test_previously_failed_digest_is_not_retried(self):
        (self.state / "state.json").write_text(json.dumps({"failed_digest": NEW_DIGEST}))
        self.assertEqual(self.run_updater(), 0)
        self.assertEqual(self.host.calls, [])

    def test_dry_run_reports_without_side_effects(self):
        self.assertEqual(self.run_updater(dry_run=True), 0)
        self.assertEqual(self.host.calls, [])
        self.assertEqual(self.host.messages, [])
        self.assertFalse((self.state / "state.json").exists())
        self.assertEqual(self.env_lines(), ["WIKI_ROOT=/srv/wiki"])

    def test_registry_failure_is_reported(self):
        self.host.digest = "not-a-digest"
        self.assertEqual(self.run_updater(), 1)
        self.assertIn("не удалось узнать digest", self.host.messages[0])

    def test_unapplied_compose_edits_block_and_notify_once(self):
        self.host.hashes["hermes-secondary"] = "edited"
        self.assertEqual(self.run_updater(), 1)
        self.assertEqual(self.run_updater(), 1)
        self.assertEqual(len(self.host.messages), 1)
        self.assertIn("неприменённые правки", self.host.messages[0])
        self.assertNotIn(("pull", f"{updater.REPOSITORY}@{NEW_DIGEST}"), self.host.calls)

    def test_unfinished_operation_requires_manual_check(self):
        (self.state / "state.json").write_text(json.dumps({"phase": "apply"}))
        self.assertEqual(self.run_updater(), 1)
        self.assertIn("не завершено", self.host.messages[0])
        self.assertEqual(self.host.calls, [])

    def test_interrupted_snapshot_restarts_the_agents(self):
        (self.state / "state.json").write_text(json.dumps({"phase": "snapshot"}))
        self.assertEqual(self.run_updater(), 1)
        self.assertIn(("docker", "start"), self.host.calls)
        self.assertNotIn("phase", self.saved_state())
        self.assertIn("агенты снова запущены", self.host.messages[0])

    def test_interrupted_apply_is_rolled_back_without_rejecting_the_digest(self):
        def killed(host):
            raise KeyboardInterrupt  # stands in for SIGKILL: nothing in the run handles it

        self.host.after_up = killed
        self.host.healthy_after_up = False
        with self.assertRaises(KeyboardInterrupt):
            self.run_updater()
        self.assertEqual(self.saved_state()["phase"], "apply")
        self.host.after_up = None
        self.assertEqual(self.run_updater(), 1)
        state = self.saved_state()
        self.assertNotIn("phase", state)
        self.assertNotIn("failed_digest", state)
        self.assertEqual(self.env_lines(), ["WIKI_ROOT=/srv/wiki"])
        self.assertEqual((self.host.profile("hermes-primary") / "state.db").read_bytes(), b"before")
        self.assertIn("Повторю следующей ночью", self.host.messages[-1])

    def test_interrupted_apply_that_left_a_healthy_candidate_is_finished(self):
        def killed(host):
            raise KeyboardInterrupt

        self.host.after_up = killed
        with self.assertRaises(KeyboardInterrupt):
            self.run_updater()
        self.host.after_up = None
        recovery = updater.Updater(self.host, self.host.root, self.state, recover_only=True)
        self.assertEqual(recovery.run(), 0)
        state = self.saved_state()
        self.assertNotIn("phase", state)
        self.assertEqual(state["current"], f"{updater.REPOSITORY}@{NEW_DIGEST}")
        self.assertIn(("tag", "sha256:" + "1" * 64, updater.ROLLBACK_TAG), self.host.calls)
        self.assertEqual(self.host.messages, [f"Hermes обновлён до stable ({NEW_DIGEST[7:19]})."])

    def test_stale_interrupted_apply_is_left_to_the_operator(self):
        def killed(host):
            raise KeyboardInterrupt

        self.host.after_up = killed
        self.host.healthy_after_up = False
        with self.assertRaises(KeyboardInterrupt):
            self.run_updater()
        self.host.clock += updater.STALE_RECOVERY + 60
        self.assertEqual(self.run_updater(), 1)
        self.assertEqual(self.saved_state()["phase"], "apply")
        self.assertIn("старше 12 часов", self.host.messages[-1])

    def test_recover_only_does_nothing_without_an_interrupted_phase(self):
        for phase in (None, "rollback-failed"):
            with self.subTest(phase=phase):
                if phase:
                    (self.state / "state.json").write_text(json.dumps({"phase": phase}))
                recovery = updater.Updater(self.host, self.host.root, self.state, recover_only=True)
                self.assertEqual(recovery.run(), 0)
                self.assertEqual((self.host.calls, self.host.messages), ([], []))

    def test_canary_only_only_reports_an_interrupted_phase(self):
        (self.state / "state.json").write_text(json.dumps({"phase": "snapshot"}))
        check = updater.Updater(self.host, self.host.root, self.state, canary_only=True)
        self.assertEqual(check.run(), 1)
        self.assertEqual(self.host.calls, [])
        self.assertEqual(self.saved_state()["phase"], "snapshot")

    def test_docker_error_during_apply_rolls_back_without_rejecting(self):
        def broken():
            raise updater.UpdateError("docker compose up failed: daemon")

        self.host.compose_up_original = self.host.compose_up
        calls = {"n": 0}

        def flaky():
            calls["n"] += 1
            if calls["n"] == 1:
                broken()
            self.host.compose_up_original()

        self.host.compose_up = flaky
        self.assertEqual(self.run_updater(), 1)
        state = self.saved_state()
        self.assertNotIn("failed_digest", state)
        self.assertNotIn("phase", state)
        self.assertEqual(self.env_lines(), ["WIKI_ROOT=/srv/wiki"])
        self.assertIn("Повторю следующей ночью", self.host.messages[-1])

    def test_sigterm_handler_ignores_further_signals_and_raises(self):
        previous = updater.signal.getsignal(updater.signal.SIGTERM)
        self.addCleanup(updater.signal.signal, updater.signal.SIGTERM, previous)
        with self.assertRaises(updater.Terminated):
            updater.terminated(updater.signal.SIGTERM, None)
        self.assertIs(updater.signal.getsignal(updater.signal.SIGTERM), updater.signal.SIG_IGN)

    def test_restart_or_stale_telegram_record_fails_the_candidate(self):
        def restarted(host):
            host.containers["hermes-primary"]["RestartCount"] = 1

        def stale(host):
            path = host.profile("hermes-primary") / "gateway_state.json"
            path.write_text(json.dumps(gateway_state(updated_at="2026-10-24T02:29:00+00:00")))

        def other_writer(host):
            path = host.profile("hermes-primary") / "gateway_state.json"
            path.write_text(json.dumps(gateway_state(writer_pid=3)))

        for effect in (restarted, stale, other_writer):
            with self.subTest(effect=effect.__name__):
                (self.state / "state.json").unlink(missing_ok=True)
                self.host.containers["hermes-primary"].pop("RestartCount", None)
                for name in updater.SERVICES:
                    (self.host.profile(name) / "gateway_state.json").write_text(json.dumps(gateway_state()))
                self.host.after_up = effect
                self.assertEqual(self.run_updater(), 1)
                self.assertEqual(self.saved_state()["failed_digest"], NEW_DIGEST)

    def test_canary_docker_errors_and_timeouts_are_not_verdicts(self):
        for code in (124, 125):
            with self.subTest(code=code):
                (self.state / "state.json").unlink(missing_ok=True)
                self.host.canary_code = code
                self.assertEqual(self.run_updater(), 1)
                self.assertFalse((self.state / "state.json").exists()
                                 and "failed_digest" in self.saved_state())

    def test_canaries_past_the_latest_start_postpone_without_counting_a_busy_night(self):
        late = updater.Updater(self.host, self.host.root, self.state, latest_start=self.host.clock + 1)
        self.assertEqual(late.run(), 0)
        self.assertNotIn(("stop",), self.host.calls)
        self.assertIn(("rmi", f"{updater.REPOSITORY}@{NEW_DIGEST}"), self.host.calls)
        self.assertEqual([p.name for p in self.state.iterdir()], [])
        self.assertIn("перенесена на следующую ночь", self.host.messages[0])

    def test_latest_start_is_the_first_0330_in_sofia_and_none_by_day(self):
        import datetime
        import zoneinfo
        sofia = zoneinfo.ZoneInfo("Europe/Sofia")

        def at(text):
            return datetime.datetime.fromisoformat(text).replace(tzinfo=sofia).timestamp()

        utc = datetime.timezone.utc
        for start, limit in (("2026-10-24T02:30", "2026-10-24T00:30"),   # summer time
                             ("2026-10-25T02:30", "2026-10-25T00:30"),   # clocks go back at 04:00
                             ("2027-01-10T02:30", "2027-01-10T01:30"),
                             ("2027-03-28T02:30", "2027-03-28T01:00")):  # 03:30 does not exist: 04:00
            with self.subTest(start=start):
                expected = datetime.datetime.fromisoformat(limit).replace(tzinfo=utc).timestamp()
                self.assertEqual(updater.latest_start(at(start)), expected)
        self.assertIsNone(updater.latest_start(at("2026-10-24T14:00")))

    def test_sigterm_during_a_rollback_is_ignored_until_it_ends(self):
        previous = updater.signal.signal(updater.signal.SIGTERM, updater.terminated)
        self.addCleanup(updater.signal.signal, updater.signal.SIGTERM, previous)
        self.host.healthy_after_up = False
        original = updater.restore_volume

        def interrupted(*args):
            os.kill(os.getpid(), updater.signal.SIGTERM)
            original(*args)

        calls = []

        def counted(*args):
            calls.append(args[0])
            interrupted(*args)

        updater.restore_volume = counted
        self.addCleanup(setattr, updater, "restore_volume", original)
        self.assertEqual(self.run_updater(), 1)
        self.assertEqual(len(calls), len(set(calls)), "each volume is restored once, by one rollback")
        self.assertEqual(self.host.calls.count(("up", PINNED)), 1)
        self.assertNotIn("phase", self.saved_state())
        self.assertEqual((self.host.profile("hermes-primary") / "state.db").read_bytes(), b"before")
        self.assertIn("откатил", self.host.messages[-1])

    def test_sigterm_during_the_health_check_rolls_back_without_rejecting(self):
        previous = updater.signal.signal(updater.signal.SIGTERM, updater.terminated)
        self.addCleanup(updater.signal.signal, updater.signal.SIGTERM, previous)
        self.host.healthy_after_up = False
        self.host.after_up = lambda host: os.kill(os.getpid(), updater.signal.SIGTERM)
        self.assertEqual(self.run_updater(), 1)
        state = self.saved_state()
        self.assertNotIn("phase", state)
        self.assertNotIn("failed_digest", state)
        self.assertEqual(self.env_lines(), ["WIKI_ROOT=/srv/wiki"])

    def test_recovery_does_not_finish_a_restarting_candidate(self):
        def killed(host):
            host.containers["hermes-primary"]["RestartCount"] = 3
            raise KeyboardInterrupt

        self.host.after_up = killed
        with self.assertRaises(KeyboardInterrupt):
            self.run_updater()
        self.host.after_up = None
        recovery = updater.Updater(self.host, self.host.root, self.state, recover_only=True)
        self.assertEqual(recovery.run(), 1)
        self.assertEqual(self.env_lines(), ["WIKI_ROOT=/srv/wiki"])
        self.assertNotIn("current", self.saved_state())

    def test_telegram_down_for_both_versions_does_not_reject_the_candidate(self):
        def offline(host):
            for name in updater.SERVICES:
                (host.profile(name) / "gateway_state.json").write_text(json.dumps(gateway_state(telegram="retrying")))

        self.host.after_up = offline
        self.host.after_restore_up = offline
        self.assertEqual(self.run_updater(), 1)
        self.assertNotIn("failed_digest", self.saved_state())
        self.assertIn("Повторю следующей ночью", self.host.messages[-1])

    def test_kill_before_the_env_switch_restores_instead_of_trusting_stopped_agents(self):
        original = updater.set_env_value

        def killed(*args):
            raise KeyboardInterrupt

        updater.set_env_value = killed
        with self.assertRaises(KeyboardInterrupt):
            self.run_updater()
        updater.set_env_value = original
        self.assertEqual(self.saved_state()["phase"], "apply")
        self.assertFalse(self.host.agents_running)
        recovery = updater.Updater(self.host, self.host.root, self.state, recover_only=True)
        self.assertEqual(recovery.run(), 1)
        self.assertTrue(self.host.agents_running)
        self.assertIn(("up", PINNED), self.host.calls)
        self.assertNotIn("уже откачено", self.host.messages[-1])

    def test_sigterm_inside_finish_recovers_from_the_saved_state(self):
        previous = updater.signal.signal(updater.signal.SIGTERM, updater.terminated)
        self.addCleanup(updater.signal.signal, updater.signal.SIGTERM, previous)
        original = self.host.tag

        def interrupted(*args):
            original(*args)
            os.kill(os.getpid(), updater.signal.SIGTERM)

        self.host.tag = interrupted
        self.assertEqual(self.run_updater(), 0)
        state = self.saved_state()
        self.assertNotIn("phase", state)
        self.assertEqual(state["config_version"], 41)
        self.assertIsNotNone(state["mcp_revision"])
        self.assertFalse(any("MCP" in message for message in self.host.messages))

    def test_sigterm_before_the_snapshot_drops_canary_copies_and_reports(self):
        previous = updater.signal.signal(updater.signal.SIGTERM, updater.terminated)
        self.addCleanup(updater.signal.signal, updater.signal.SIGTERM, previous)
        self.host.profile("hermes-primary").joinpath("gateway_state.json").write_text(
            json.dumps({**gateway_state(), "active_agents": 1}))
        self.host.sleep = lambda seconds: os.kill(os.getpid(), updater.signal.SIGTERM)
        self.assertEqual(self.run_updater(), 1)
        self.assertEqual(list(self.state.glob("*/canary-*/data")), [])
        self.assertNotIn(("stop",), self.host.calls)
        self.assertIn("агенты не затронуты", self.host.messages[-1])

    def test_failed_size_check_does_not_restart_running_agents(self):
        original = updater.MAX_SNAPSHOT_BYTES
        updater.MAX_SNAPSHOT_BYTES = 1
        self.addCleanup(setattr, updater, "MAX_SNAPSHOT_BYTES", original)
        self.assertEqual(self.run_updater(), 1)
        self.assertNotIn(("docker", "stop"), self.host.calls)
        self.assertNotIn(("docker", "start"), self.host.calls)
        self.assertIn("снимок данных не удался", self.host.messages[-1])

    def test_recovery_of_an_already_finished_rollback_only_clears_the_phase(self):
        self.host.healthy_after_up = False
        self.assertEqual(self.run_updater(), 1)
        state = self.saved_state()
        (self.state / "state.json").write_text(json.dumps({**state, "phase": "apply"}))
        marker = self.host.profile("hermes-primary") / "written-after-rollback"
        marker.write_text("kept")
        recovery = updater.Updater(self.host, self.host.root, self.state, recover_only=True)
        self.assertEqual(recovery.run(), 1)
        self.assertTrue(marker.exists())
        self.assertNotIn("phase", self.saved_state())
        self.assertIn("уже откачено", self.host.messages[-1])

    def test_agents_still_running_are_never_restored_under(self):
        self.host.healthy_after_up = False
        self.host.run_original = self.host.run

        def stuck(*args, **kwargs):
            result = self.host.run_original(*args, **kwargs)
            if args[:2] == ("docker", "stop"):
                self.host.agents_running = True
            return result

        self.host.run = stuck
        self.assertEqual(self.run_updater(), 1)
        self.assertEqual(self.saved_state()["phase"], "rollback-failed")
        self.assertTrue(self.host.profile("hermes-primary").exists())

    def test_unexpected_error_during_restore_is_reported(self):
        self.host.healthy_after_up = False
        original = updater.restore_volume

        def broken(*args):
            raise EOFError("truncated archive")

        updater.restore_volume = broken
        self.addCleanup(setattr, updater, "restore_volume", original)
        self.assertEqual(self.run_updater(), 1)
        self.assertEqual(self.saved_state()["phase"], "rollback-failed")
        self.assertIn("откат не удались", self.host.messages[-1])

    def test_unexpected_error_during_snapshot_restarts_the_agents(self):
        def broken():
            raise EOFError("disk vanished")

        self.host.stop_effect = broken
        self.assertEqual(self.run_updater(), 1)
        self.assertIn(("docker", "start"), self.host.calls)
        self.assertNotIn("phase", self.saved_state())
        self.assertIn("снимок данных не удался", self.host.messages[0])

    def test_crash_outside_a_guarded_step_is_reported(self):
        self.host.compose_hash = lambda service: (_ for _ in ()).throw(ValueError("bad compose"))
        self.assertEqual(self.run_updater(), 1)
        self.assertIn("автообновление упало (ValueError: bad compose)", self.host.messages[0])

    def test_pull_failure_retries_the_digest_next_night(self):
        self.host.pull = lambda ref: (_ for _ in ()).throw(updater.UpdateError("rate limited"))
        self.assertEqual(self.run_updater(), 1)
        self.assertFalse((self.state / "state.json").exists())
        self.assertIn("повторю следующей ночью", self.host.messages[0])

    def test_canary_crash_that_is_not_a_verdict_is_retried(self):
        self.host.canary = lambda name, args: (_ for _ in ()).throw(OSError("docker gone"))
        self.assertEqual(self.run_updater(), 1)
        self.assertNotIn("failed_digest", self.saved_state() if (self.state / "state.json").exists() else {})
        self.assertIn("Повторю следующей ночью", self.host.messages[0])

    def test_canary_only_stops_before_the_agents(self):
        updater_run = updater.Updater(self.host, self.host.root, self.state, canary_only=True)
        self.assertEqual(updater_run.run(), 0)
        self.assertIn(("canary", "hermes-canary-hermes-primary"), self.host.calls)
        self.assertNotIn(("stop",), self.host.calls)
        self.assertEqual(self.env_lines(), ["WIKI_ROOT=/srv/wiki"])

    def test_candidate_offline_in_telegram_is_rolled_back(self):
        def offline(host):
            path = host.profile("hermes-secondary") / "gateway_state.json"
            path.write_text(json.dumps(gateway_state(telegram="retrying")))

        self.host.after_up = offline
        self.assertEqual(self.run_updater(), 1)
        self.assertEqual(self.saved_state()["failed_digest"], NEW_DIGEST)
        self.assertIn("откатил", self.host.messages[0])

    def test_failed_canary_marks_digest_and_keeps_current_version(self):
        self.host.canary_code = 1
        self.assertEqual(self.run_updater(), 1)
        candidate = f"{updater.REPOSITORY}@{NEW_DIGEST}"
        self.assertIn(("rmi", candidate), self.host.calls)
        self.assertNotIn(("stop",), self.host.calls)
        self.assertEqual(self.saved_state()["failed_digest"], NEW_DIGEST)
        self.assertEqual(self.env_lines(), ["WIKI_ROOT=/srv/wiki"])
        self.assertIn("не прошла проверку", self.host.messages[0])

    def test_busy_agents_postpone_and_report_the_third_night(self):
        self.host.profile("hermes-primary").joinpath("gateway_state.json").write_text('{"active_agents": 1}')
        for _ in range(3):
            self.assertEqual(self.run_updater(), 0)
        self.assertNotIn(("stop",), self.host.calls)
        self.assertEqual(len(self.host.messages), 1)
        self.assertIn("третью ночь", self.host.messages[0])

    def test_successful_update_selects_candidate_through_root_env(self):
        candidate = f"{updater.REPOSITORY}@{NEW_DIGEST}"
        self.assertEqual(self.run_updater(), 0)
        self.assertEqual(self.env_lines(), ["WIKI_ROOT=/srv/wiki", f"HERMES_IMAGE={candidate}"])
        self.assertEqual(os.stat(self.host.root / ".env").st_mode & 0o777, 0o600)
        self.assertLess(self.host.calls.index(("stop",)), self.host.calls.index(("up", candidate)))
        self.assertIn(("tag", "sha256:" + "1" * 64, updater.ROLLBACK_TAG), self.host.calls)
        state = self.saved_state()
        self.assertEqual(state["current"], candidate)
        self.assertNotIn("phase", state)
        generation = self.state / state["generation"]
        self.assertEqual(len(json.loads((generation / "volumes.json").read_text())), 4)
        self.assertEqual(self.host.messages, [f"Hermes обновлён до stable ({NEW_DIGEST[7:19]})."])
        self.assertEqual(self.run_updater(), 0)
        self.assertEqual(len(self.host.messages), 1)

    def test_schema_change_updates_and_asks_for_repository_sync_once(self):
        self.host.latest = 42
        self.assertEqual(self.run_updater(), 0)
        self.assertIn(
            "со сменой схемы конфигурации 41→42: синхронизируй управляемый конфиг в репозитории",
            self.host.messages[0],
        )
        state = self.saved_state()
        self.assertEqual((state["config_version"], state["schema_notified"]), (42, 42))
        self.host.digest = NEWER_DIGEST
        self.assertEqual(self.run_updater(), 0)
        self.assertEqual(self.host.messages[1], f"Hermes обновлён до stable ({NEWER_DIGEST[7:19]}).")

    def test_unhealthy_candidate_restores_previous_image_and_data(self):
        def migrate(host):
            profile = host.profile("hermes-primary")
            (profile / "state.db").write_bytes(b"migrated by candidate")
            (profile / "new-table").write_text("candidate only")

        self.host.healthy_after_up = False
        self.host.after_up = migrate
        self.assertEqual(self.run_updater(), 1)
        profile = self.host.profile("hermes-primary")
        self.assertEqual((profile / "state.db").read_bytes(), b"before")
        self.assertFalse((profile / "new-table").exists())
        self.assertEqual((profile / ".cache" / "model.bin").read_text(), "cached")
        self.assertFalse((profile / "tmp").exists())
        self.assertEqual(self.env_lines(), ["WIKI_ROOT=/srv/wiki"])
        self.assertEqual(self.host.calls[-2:], [("up", PINNED), ("rmi", f"{updater.REPOSITORY}@{NEW_DIGEST}")])
        state = self.saved_state()
        self.assertEqual(state["failed_digest"], NEW_DIGEST)
        self.assertNotIn("phase", state)
        displaced = self.state / state["generation"] / "displaced" / "hermes-primary-profile"
        self.assertEqual((displaced / "new-table").read_text(), "candidate only")
        self.assertIn("откатил образ и данные", self.host.messages[0])

    def test_persisted_secret_or_backup_after_start_rolls_back(self):
        self.host.scan_result = (1, "leak health_api_token config.yaml.bak-20261024T000000Z\n")
        (self.host.root / ".env").write_text(f"HERMES_IMAGE={PINNED}\nWIKI_ROOT=/srv/wiki\n")
        self.assertEqual(self.run_updater(), 1)
        self.assertEqual(updater.read_env_value(self.host.root / ".env", "HERMES_IMAGE"), PINNED)
        generation = self.state / self.saved_state()["generation"]
        self.assertIn("leak health_api_token", (generation / "problems.log").read_text())
        self.assertIn("откатил", self.host.messages[0])

    def test_failed_rollback_leaves_a_manual_phase(self):
        self.host.healthy_after_up = False
        self.host.has_image = lambda ref: False
        self.host.pull = lambda ref: (_ for _ in ()).throw(updater.UpdateError("offline")) if ref == PINNED else None
        self.assertEqual(self.run_updater(), 1)
        self.assertEqual(self.saved_state()["phase"], "rollback-failed")
        self.assertIn("откат не удались", self.host.messages[-1])

    def test_canary_rejects_persisted_synthetic_secrets_and_backups(self):
        def mounts(args):
            pairs = [args[i + 1] for i, arg in enumerate(args) if arg == "-v"]
            data = next(pathlib.Path(p.split(":")[0]) for p in pairs if p.endswith(":/opt/data"))
            secret = next(pathlib.Path(p.split(":")[0]) for p in pairs if ":/run/secrets/" in p)
            return data, secret

        def leak(args):
            data, secret = mounts(args)
            (data / "config.yaml").write_text("Bearer " + secret.read_text())

        def backup(args):
            data, _ = mounts(args)
            (data / "config.yaml.bak-20261024T000000Z").write_text("copy")

        def clean(args):
            data, _ = mounts(args)
            self.assertTrue((data / "config.base.yaml").is_file())
            self.assertNotIn("/srv/wiki:/wiki:ro", args)
            self.assertIn("tools:/opt/tools:ro", args)
            env = pathlib.Path(args[args.index("--env-file") + 1]).read_text()
            self.assertNotIn("PATH=", env)
            self.assertNotIn("HERMES_GATEWAY_BOOTSTRAP_STATE", env)

        for effect, expected in ((leak, 1), (backup, 1), (clean, 0)):
            with self.subTest(effect=effect.__name__):
                self.host.canary_effect = effect
                (self.state / "state.json").unlink(missing_ok=True)
                self.host.digest = "sha256:" + format(expected, "x") * 64 if expected else NEWER_DIGEST
                self.assertEqual(self.run_updater(), expected)


class FilesystemTests(unittest.TestCase):
    def test_snapshot_round_trip_excludes_temp_and_keeps_live_caches(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source = root / "volume" / "_data"
            (source / "tmp").mkdir(parents=True)
            (source / "home" / ".cache").mkdir(parents=True)
            (source / "sessions").mkdir()
            (source / "sessions" / "a.json").write_text("one")
            (source / "tmp" / "hermes-snap.sh").write_text("export TOKEN=x")
            (source / "home" / ".cache" / "blob").write_text("cache")
            (source / "link").symlink_to("sessions/a.json")
            os.chmod(source / "sessions", 0o700)
            archive = root / "snapshot.tar.gz"
            updater.snapshot_volume(source, archive, ("tmp", ".cache", "home/.cache"))
            names = set(updater.tarfile.open(archive).getnames())
            self.assertIn("./sessions/a.json", names)
            self.assertNotIn("./tmp/hermes-snap.sh", names)
            self.assertNotIn("./home/.cache/blob", names)

            (source / "sessions" / "a.json").write_text("changed")
            (source / "sessions" / "b.json").write_text("new")
            updater.restore_volume(source, archive, root / "displaced")
            self.assertEqual((source / "sessions" / "a.json").read_text(), "one")
            self.assertFalse((source / "sessions" / "b.json").exists())
            self.assertEqual(os.readlink(source / "link"), "sessions/a.json")
            self.assertEqual(os.stat(source / "sessions").st_mode & 0o777, 0o700)
            self.assertEqual((source / "home" / ".cache" / "blob").read_text(), "cache")
            self.assertEqual((root / "displaced" / "sessions" / "b.json").read_text(), "new")

    def test_repeated_restore_keeps_every_displaced_tree(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source, archive, displaced = root / "volume", root / "volume.tar.gz", root / "displaced" / "volume"
            source.mkdir()
            (source / "state.db").write_text("snapshot")
            updater.snapshot_volume(source, archive)
            for text in ("first attempt", "second attempt"):
                (source / "state.db").write_text(text)
                updater.restore_volume(source, archive, displaced)
            self.assertEqual((source / "state.db").read_text(), "snapshot")
            self.assertEqual((displaced / "state.db").read_text(), "first attempt")
            self.assertEqual((root / "displaced" / "volume.2" / "state.db").read_text(), "second attempt")

    def test_env_value_is_set_replaced_and_removed_in_place(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory, ".env")
            path.write_text("A=1\n# comment\nB=2\n")
            os.chmod(path, 0o640)
            updater.set_env_value(path, "HERMES_IMAGE", "image@sha256:1")
            updater.set_env_value(path, "HERMES_IMAGE", "image@sha256:2")
            self.assertEqual(path.read_text(), "A=1\n# comment\nB=2\nHERMES_IMAGE=image@sha256:2\n")
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o640)
            updater.set_env_value(path, "HERMES_IMAGE", None)
            self.assertEqual(path.read_text(), "A=1\n# comment\nB=2\n")
            path.write_text("HERMES_IMAGE=a\nHERMES_IMAGE=b\n")
            with self.assertRaises(updater.UpdateError):
                updater.set_env_value(path, "HERMES_IMAGE", "c")

    def test_post_start_scan_reports_backups_and_persisted_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            data, secrets_dir = root / "data", root / "secrets"
            (data / "tmp").mkdir(parents=True)
            secrets_dir.mkdir()
            (secrets_dir / "health_api_token").write_text("live-bearer-value\n")
            (data / "config.base.yaml").write_text("model: x\n")
            (data / "tmp" / "hermes-snap-1.sh").write_text("live-bearer-value")
            script = updater.POST_START_SCAN.replace("/opt/data", str(data)).replace(
                "/run/secrets", str(secrets_dir)).replace("/run/hermes-secret-scan", str(root / "scan"))
            clean = subprocess.run(["sh", "-c", script], capture_output=True, text=True)
            self.assertEqual((clean.returncode, clean.stdout), (0, ""))
            (data / "config.yaml.bak-20261024T000000Z").write_text("Bearer live-bearer-value\n")
            dirty = subprocess.run(["sh", "-c", script], capture_output=True, text=True)
            self.assertEqual(dirty.returncode, 1)
            self.assertIn("backup config.yaml.bak-20261024T000000Z", dirty.stdout)
            self.assertIn("leak health_api_token config.yaml.bak-20261024T000000Z", dirty.stdout)
            self.assertNotIn("live-bearer-value", dirty.stdout + dirty.stderr)


class ConfigMigrationEntrypointTests(unittest.TestCase):
    def function(self, name):
        match = re.search(rf"{name}\(\) \{{\n.*?\n\}}", read("scripts/hermes-home-entrypoint"), flags=re.DOTALL)
        self.assertIsNotNone(match)
        return match.group(0)

    def test_every_start_removes_upstream_migration_backups(self):
        entrypoint = read("scripts/hermes-home-entrypoint")
        self.assertLess(entrypoint.index("remove_migration_backups /opt/data"), entrypoint.index("exec /init"))
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            removed = ("config.yaml.bak-20261024T000000Z", "config.yaml.bak-pre-migrate-xai-1",
                       "config.yaml.corrupt.20261024.bak", ".env.bak-20261024T000000Z")
            kept = ("config.base.yaml", "config.base.yaml.bak-pre-luna", ".env", "auth.json")
            for name in removed + kept:
                (root / name).write_text("x")
            (root / "config.yaml.bak-dangling").symlink_to(root / "missing")
            subprocess.run(["sh", "-c", self.function("remove_migration_backups")
                            + '\nremove_migration_backups "$1"', "probe", str(root)], check=True)
            self.assertEqual(sorted(p.name for p in root.iterdir()), sorted(kept))

    def run_migration(self, migrator_body):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = pathlib.Path(directory.name)
        bin_dir, persistent, runtime = root / "bin", root / "data", root / "run"
        for path in (bin_dir, persistent, runtime):
            path.mkdir()
        install = bin_dir / "install"
        install.write_text("#!/bin/sh\nset -eu\n"
                           'if [ "$1" = -d ]; then while [ $# -gt 1 ]; do shift; done; mkdir -p "$1"; exit 0; fi\n'
                           "while [ $# -gt 2 ]; do shift 2; done\ncp \"$1\" \"$2\"\n")
        as_hermes = bin_dir / "as-hermes"
        as_hermes.write_text('#!/bin/sh\nshift\nexec "$@"\n')
        migrator = root / "migrate.py"
        migrator.write_text(migrator_body)
        for path in (install, as_hermes):
            path.chmod(0o755)
        managed = ROOT / "profiles/primary/config/config.yaml"
        secret = runtime / "health-token"
        secret.write_text("migration-test-bearer\n")
        base = persistent / "config.base.yaml"
        subprocess.run([sys.executable, str(ROOT / "scripts/merge_hermes_config.py"),
                        str(managed), str(root / "none.yaml"), str(base), "--sanitize-health"], check=True)
        (persistent / ".env").write_text("OPENROUTER_API_KEY=kept\n")
        environment = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}",
                       "TELEGRAM_BOT_TOKEN": "exported-secret"}
        result = subprocess.run(
            ["sh", "-c", self.function("migrate_hermes_config") + '\nmigrate_hermes_config "$@"', "probe",
             sys.executable, str(migrator), str(ROOT / "scripts/merge_hermes_config.py"), str(managed),
             str(base), str(persistent / ".env"), str(runtime / "config.yaml"), str(secret),
             str(runtime / "migrate"), str(as_hermes)],
            env=environment, capture_output=True, text=True,
        )
        return root, result

    MIGRATOR = (
        "import os, pathlib, re\n"
        "assert 'TELEGRAM_BOT_TOKEN' not in os.environ\n"
        "home = pathlib.Path(os.environ['HERMES_HOME'])\n"
        "config = home / 'config.yaml'\n"
        "for name in ('config.yaml', '.env'):\n"
        "    (home / (name + '.bak-20261024T000000Z')).write_bytes((home / name).read_bytes())\n"
        "text = re.sub(r'^_config_version: \\d+$', '_config_version: 42', config.read_text(), flags=re.M)\n"
        "config.write_text(text + 'new_option: true\\n')\n"
        "with open(home / '.env', 'a') as env: env.write('NEW_SETTING=1\\n')\n"
    )

    def test_schema_migration_runs_off_volume_and_keeps_bearer_runtime_only(self):
        root, result = self.run_migration(self.MIGRATOR)
        self.assertEqual(result.returncode, 0, result.stderr)
        persistent, runtime = root / "data", root / "run"
        base = (persistent / "config.base.yaml").read_text()
        self.assertIn("_config_version: 42", base)
        self.assertIn("new_option: true", base)
        self.assertNotIn("migration-test-bearer", base)
        active = (runtime / "config.yaml").read_text()
        self.assertIn("_config_version: 42", active)
        self.assertIn("Bearer migration-test-bearer", active)
        self.assertEqual((persistent / ".env").read_text(), "OPENROUTER_API_KEY=kept\nNEW_SETTING=1\n")
        self.assertEqual(sorted(p.name for p in persistent.iterdir()), [".env", "config.base.yaml"])
        self.assertFalse((runtime / "migrate").exists())

    def test_failed_migration_keeps_the_previous_config(self):
        root, result = self.run_migration("raise SystemExit(1)\n")
        self.assertEqual(result.returncode, 0)
        self.assertIn("migration failed", result.stderr)
        self.assertIn("_config_version: 41", (root / "data/config.base.yaml").read_text())
        self.assertFalse((root / "run/config.yaml").exists())
        self.assertFalse((root / "run/migrate").exists())

    def test_upstream_stage2_migration_is_disabled_after_the_private_one(self):
        entrypoint = read("scripts/hermes-home-entrypoint")
        self.assertLess(entrypoint.index("\nmigrate_hermes_config \\"), entrypoint.index("export HERMES_SKIP_CONFIG_MIGRATION=1"))
        self.assertLess(entrypoint.index("export HERMES_SKIP_CONFIG_MIGRATION=1"), entrypoint.index("exec /init"))

    def test_merger_never_downgrades_a_migrated_schema(self):
        sys.path.insert(0, str(ROOT / "scripts"))
        try:
            import merge_hermes_config
        finally:
            sys.path.pop(0)
        merged = merge_hermes_config.merge({"_config_version": 42, "a": 1}, {"_config_version": 41, "b": 2})
        self.assertEqual(merged, {"_config_version": 42, "a": 1, "b": 2})
        self.assertEqual(merge_hermes_config.merge({"_config_version": 40}, {"_config_version": 41}),
                         {"_config_version": 41})


class DeploymentContractTests(unittest.TestCase):
    def test_timer_runs_before_lampac_and_watchtower(self):
        timer = read("hermes-auto-update.timer")
        self.assertIn("OnCalendar=*-*-* 02:30:00 Europe/Sofia", timer)
        service = read("hermes-auto-update.service")
        self.assertIn("ExecStart=/usr/bin/python3 /home/iamstubborn/homelab/hermes/scripts/hermes-auto-update", service)
        self.assertEqual(updater.STATE, pathlib.Path("/var/lib/hermes-update"))

    def test_readme_documents_the_guarded_policy(self):
        readme = " ".join(read("README.md").split())
        self.assertNotIn("Automatic image/schema upgrades are forbidden", readme)
        self.assertIn("hermes-auto-update.timer", readme)
        self.assertIn("DRY_RUN=1", readme)


if __name__ == "__main__":
    unittest.main()
