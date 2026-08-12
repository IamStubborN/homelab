import json
import os
import pathlib
import re
import stat
import subprocess
import tempfile
import unittest

import yaml


HERMES_ROOT = pathlib.Path(__file__).resolve().parents[1]
HOMELAB_ROOT = HERMES_ROOT.parent
PROFILES = ("andrii", "valentyna")
HEALTH_TOOLS = {
    "add_measurement",
    "correct_measurement",
    "add_meal",
    "add_symptom",
    "add_sleep_record",
    "add_medication",
    "stop_medication",
    "add_condition",
    "add_allergy",
    "add_lab_result",
    "query_health_data",
    "generate_chart",
}


def read(relative_path: str) -> str:
    return (HERMES_ROOT / relative_path).read_text(encoding="utf-8")


def compose_environment() -> dict:
    environment = os.environ.copy()
    environment.update(
        {
            "ANDRII_TELEGRAM_USER_ID": "1",
            "ANDRII_TELEGRAM_CHAT_ID": "1",
            "VALENTYNA_TELEGRAM_USER_ID": "2",
            "VALENTYNA_TELEGRAM_CHAT_ID": "2",
        }
    )
    return environment


def rendered_compose(
    path: pathlib.Path, cwd: pathlib.Path, *, interpolate: bool = True
) -> dict:
    command = ["docker", "compose", "-f", str(path), "config"]
    if not interpolate:
        command.append("--no-interpolate")
    command.extend(("--format", "json"))
    result = subprocess.run(
        command,
        cwd=cwd,
        env=compose_environment(),
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


class EmbeddedHealthComposeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.hermes = rendered_compose(HERMES_ROOT / "compose.yaml", HERMES_ROOT)
        cls.homelab = rendered_compose(
            HOMELAB_ROOT / "compose.yml", HOMELAB_ROOT, interpolate=False
        )

    def test_both_embedded_profiles_share_the_health_stack_network(self):
        for profile in PROFILES:
            service = self.hermes["services"][f"hermes-{profile}"]
            self.assertEqual(
                service["environment"]["HEALTH_MCP_URL"],
                "http://health-service:8080/internal/mcp",
            )
            self.assertEqual(service["environment"]["HEALTH_DEFAULT_PERSON"], profile)
            self.assertIn("health-internal", service["networks"])
            self.assertEqual(
                service["image"],
                "nousresearch/hermes-agent@sha256:1eafbbd7357ef92265ab2ba3e11edd0ff550b36bd7a1643ca88a142d5a4d4f8f",
            )
            self.assertEqual(
                service["labels"]["com.centurylinklabs.watchtower.enable"],
                "false",
            )
            self.assertIn(
                {
                    "source": f"{profile}_health_api_token",
                    "target": "health_api_token",
                },
                service["secrets"],
            )
            self.assertTrue(
                any(
                    volume["source"] == str(HERMES_ROOT / "shared/skills")
                    and volume["target"] == "/etc/hermes-home/skills"
                    and volume["read_only"]
                    for volume in service["volumes"]
                )
            )

        network = self.hermes["networks"]["health-internal"]
        self.assertTrue(network["external"])
        self.assertEqual(network["name"], "health-internal")

    def test_root_compose_connects_health_service_and_both_hermes_profiles(self):
        services = self.homelab["services"]
        self.assertIn("health-service", services)
        for name in ("health-service", "hermes-andrii", "hermes-valentyna"):
            self.assertIn("health-internal", services[name]["networks"])

    def test_hermes_secrets_reuse_the_health_stack_token_files(self):
        for profile in PROFILES:
            hermes_file = pathlib.Path(
                self.hermes["secrets"][f"{profile}_health_api_token"]["file"]
            )
            health_file = pathlib.Path(
                self.homelab["secrets"][f"{profile}_health_api_token"]["file"]
            )
            self.assertEqual(hermes_file, health_file)
            self.assertEqual(
                hermes_file,
                HOMELAB_ROOT / f"health/secrets/{profile}.health_api_token",
            )

    def test_managed_profiles_use_the_runtime_supported_config_schema(self):
        for profile in PROFILES:
            config = yaml.safe_load(
                (HERMES_ROOT / f"profiles/{profile}/config/config.yaml").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(config["_config_version"], 34)

    def test_health_runbook_fails_closed_and_restore_is_private_and_unique(self):
        runbook = (HOMELAB_ROOT / "health/README.md").read_text(encoding="utf-8")
        self.assertIn('if [ "$internal" != true ] || [ "$attachable" != true ]; then', runbook)
        self.assertIn('exit 1', runbook)
        self.assertIn('set -eu', runbook)
        self.assertIn('umask 077', runbook)
        self.assertIn('install -d -m 0700 health/backups', runbook)
        self.assertIn('chmod 0600 "$backup"', runbook)
        self.assertLess(
            runbook.index("docker compose up --wait health-postgres"),
            runbook.index("pg_dump -U health"),
        )
        self.assertIn('verify_db="health_restore_verify_$(date -u +%Y%m%d%H%M%S)_$$"', runbook)
        self.assertIn('if [ "$verify_db_created" = true ]; then', runbook)
        self.assertIn('test "$(docker compose exec -T health-postgres psql', runbook)
        self.assertNotIn("createdb -U health health_restore_verify\n", runbook)

    def test_health_runbook_fails_closed_without_in_place_rollback_recipe(self):
        runbook = (HOMELAB_ROOT / "health/README.md").read_text(encoding="utf-8")
        compact = " ".join(runbook.split())
        lower = compact.lower()
        self.assertIn("image-only rollback and in-place downgrade are unsupported", lower)
        self.assertIn("stop `health-service` and both hermes services", lower)
        self.assertIn("preserve the current external `health-pg-data` volume", lower)
        self.assertIn("take a new private dump", lower)
        self.assertIn("recommended default is to roll forward", lower)
        self.assertIn("operator-selected destructive fallback", lower)
        self.assertIn("will discard all post-deploy writes", lower)
        self.assertIn("matching repository revision, images, and config", lower)
        self.assertIn("uses `latest` and watchtower", lower)
        self.assertIn("operator decision for the live incident", lower)
        self.assertNotIn("family-health-service:rollback", runbook)
        self.assertNotIn("retag `family-health-service:rollback`", runbook)
        self.assertNotIn("ALTER TABLE sleep_records DROP CONSTRAINT", runbook)
        self.assertNotIn("DELETE FROM seaql_migrations", runbook)
        self.assertNotIn("git switch --detach", runbook)
        self.assertNotIn("prior_revision=", runbook)
        self.assertNotIn("coordinated downgrade", runbook)

    def test_health_image_rebuilds_local_workspace_packages_after_cached_dependencies(self):
        dockerfile = (HOMELAB_ROOT / "health/service/Dockerfile").read_text(
            encoding="utf-8"
        )
        clean = (
            "cargo clean --release --package health-core "
            "--package health-migration --package health-service"
        )
        self.assertIn(clean, " ".join(dockerfile.split()))
        self.assertLess(
            dockerfile.index("cargo clean --release"),
            dockerfile.rindex("cargo build --release"),
        )

        probe = HOMELAB_ROOT / "health/service/scripts/test-docker-cache.sh"
        self.assertTrue(os.access(probe, os.X_OK))
        source = probe.read_text(encoding="utf-8")
        self.assertIn("cache_fixture_old", source)
        self.assertIn("m20260813_000002_sleep_time_order", source)
        self.assertIn("health-target-", dockerfile)

    def test_health_network_guard_rejects_legacy_non_internal_network(self):
        runbook = (HOMELAB_ROOT / "health/README.md").read_text(encoding="utf-8")
        block = re.search(
            r"before the first `up`:\n\n```bash\n(.*?)\n```", runbook, re.DOTALL
        )
        self.assertIsNotNone(block)
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            docker = root / "docker"
            calls = root / "calls"
            docker.write_text(
                "#!/bin/sh\n"
                "printf '%s\\n' \"$*\" >> \"$DOCKER_CALLS\"\n"
                "case \"$*\" in\n"
                "  'network inspect health-internal') exit 0 ;;\n"
                "  *Internal*) printf 'false\\n'; exit 0 ;;\n"
                "  *Attachable*) printf 'true\\n'; exit 0 ;;\n"
                "esac\n"
                "exit 90\n",
                encoding="utf-8",
            )
            docker.chmod(0o755)
            environment = os.environ.copy()
            environment["PATH"] = f"{root}:{environment['PATH']}"
            environment["DOCKER_CALLS"] = str(calls)
            result = subprocess.run(
                ["sh", "-c", block.group(1)],
                env=environment,
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 1)
            self.assertIn("Internal=true and Attachable=true", result.stderr)
            self.assertNotIn("volume create", calls.read_text(encoding="utf-8"))

    def test_entrypoint_copies_health_without_exporting_it(self):
        entrypoint = read("scripts/hermes-home-entrypoint")
        self.assertNotIn("read_secret HEALTH_API_TOKEN", entrypoint)
        self.assertIn("unset HEALTH_API_TOKEN", entrypoint)
        copied = re.search(r"for secret in ([^;]+); do", entrypoint)
        self.assertIsNotNone(copied)
        self.assertIn("health_api_token", copied.group(1).split())
        self.assertIn('install -o 10000 -g 10000 -m 0400 "$source"', entrypoint)
        self.assertIn(
            '"$runtime_secret_dir/health_api_token"',
            entrypoint,
        )

        probe = next(
            line.strip()
            for line in entrypoint.splitlines()
            if line.strip() == "unset HEALTH_API_TOKEN"
        )
        environment = os.environ.copy()
        environment["HEALTH_API_TOKEN"] = "must-not-reach-child"
        child = subprocess.run(
            ["sh", "-c", f"{probe}\nexec env"],
            env=environment,
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertNotIn("HEALTH_API_TOKEN=", child.stdout)

    def test_entrypoint_cleans_generated_config_when_install_fails(self):
        entrypoint = read("scripts/hermes-home-entrypoint")
        function = re.search(
            r"materialize_hermes_config\(\) \{\n.*?\n\}",
            entrypoint,
            flags=re.DOTALL,
        )
        self.assertIsNotNone(function)

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            bin_dir = root / "bin"
            temp_dir = root / "temp"
            bin_dir.mkdir()
            temp_dir.mkdir()
            current = root / "config.yaml"
            legacy_secret = "legacy-persistent-bearer"
            current.write_text(
                "mcp_servers:\n"
                "  health:\n"
                "    headers:\n"
                f"      Authorization: Bearer {legacy_secret}\n",
                encoding="utf-8",
            )
            secret_path = root / "health-token"
            secret = "post-generation-install-failure-token"
            secret_path.write_text(f"{secret}\n", encoding="utf-8")
            install_attempted = root / "install-attempted"

            failing_install = bin_dir / "install"
            failing_install.write_text(
                "#!/bin/sh\n"
                "set -eu\n"
                '[ "$1" = -o ] && [ "$2" = 10000 ]\n'
                '[ "$3" = -g ] && [ "$4" = 10000 ]\n'
                '[ "$5" = -m ]\n'
                '[ -s "$7" ]\n'
                'if [ "$6" = 0640 ]; then cp "$7" "$8"; exit 0; fi\n'
                '[ "$6" = 0600 ]\n'
                ': > "$INSTALL_ATTEMPTED"\n'
                "exit 73\n",
                encoding="utf-8",
            )
            failing_install.chmod(0o755)

            probe = root / "probe.sh"
            probe.write_text(
                "#!/bin/sh\nset -eu\n"
                + function.group(0)
                + '\nmaterialize_hermes_config "$1" "$2" "$3" "$4" '
                '"$5" "$6" "$7" "$8"\n',
                encoding="utf-8",
            )
            environment = os.environ.copy()
            environment["PATH"] = f"{bin_dir}:{environment['PATH']}"
            environment["INSTALL_ATTEMPTED"] = str(install_attempted)
            result = subprocess.run(
                [
                    "sh",
                    str(probe),
                    os.fspath(pathlib.Path(os.sys.executable)),
                    str(HERMES_ROOT / "scripts/merge_hermes_config.py"),
                    str(HERMES_ROOT / "profiles/andrii/config/config.yaml"),
                    str(root / "persisted-config.yaml"),
                    str(current),
                    str(root / "runtime-config.yaml"),
                    str(secret_path),
                    str(temp_dir),
                ],
                env=environment,
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 73)
            self.assertTrue(install_attempted.is_file())
            self.assertEqual(list(temp_dir.iterdir()), [])
            self.assertNotIn(secret, result.stdout + result.stderr)
            self.assertNotIn(legacy_secret, result.stdout + result.stderr)
            self.assertNotIn(
                legacy_secret,
                (root / "persisted-config.yaml").read_text(encoding="utf-8"),
            )
            self.assertFalse(current.exists())
            self.assertEqual(list(root.glob("config.yaml.bak-*")), [])
            self.assertFalse((root / "runtime-config.yaml").exists())

    def test_invalid_health_secret_removes_legacy_persistent_bearer_first(self):
        entrypoint = read("scripts/hermes-home-entrypoint")
        function = re.search(
            r"materialize_hermes_config\(\) \{\n.*?\n\}",
            entrypoint,
            flags=re.DOTALL,
        )
        self.assertIsNotNone(function)

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            bin_dir = root / "bin"
            temporary = root / "tmp"
            bin_dir.mkdir()
            temporary.mkdir()
            active = root / "config.yaml"
            legacy_secret = "legacy-invalid-secret-bearer"
            active.write_text(
                "mcp_servers:\n"
                "  health:\n"
                "    headers:\n"
                f"      Authorization: Bearer {legacy_secret}\n",
                encoding="utf-8",
            )
            invalid_secret = root / "health-token"
            invalid_secret.write_text("contains whitespace\n", encoding="utf-8")
            install = bin_dir / "install"
            install.write_text(
                "#!/bin/sh\nset -eu\n"
                "while [ $# -gt 2 ]; do shift 2; done\n"
                'cp "$1" "$2"\n',
                encoding="utf-8",
            )
            install.chmod(0o755)
            probe = root / "probe.sh"
            probe.write_text(
                "#!/bin/sh\nset -eu\n"
                + function.group(0)
                + '\nmaterialize_hermes_config "$1" "$2" "$3" "$4" '
                '"$5" "$6" "$7" "$8"\n',
                encoding="utf-8",
            )
            environment = os.environ.copy()
            environment["PATH"] = f"{bin_dir}:{environment['PATH']}"
            result = subprocess.run(
                [
                    "sh",
                    str(probe),
                    os.fspath(pathlib.Path(os.sys.executable)),
                    str(HERMES_ROOT / "scripts/merge_hermes_config.py"),
                    str(HERMES_ROOT / "profiles/andrii/config/config.yaml"),
                    str(root / "config.base.yaml"),
                    str(active),
                    str(root / "runtime-config.yaml"),
                    str(invalid_secret),
                    str(temporary),
                ],
                env=environment,
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 2)
            self.assertFalse(active.exists())
            persistent = (root / "config.base.yaml").read_text(encoding="utf-8")
            self.assertNotIn(legacy_secret, persistent)
            self.assertNotIn(legacy_secret, result.stdout + result.stderr)
            self.assertEqual(list(root.glob("config.yaml.bak-*")), [])
            self.assertFalse((root / "runtime-config.yaml").exists())

    def test_entrypoint_keeps_health_bearer_only_in_runtime_config_across_restart(self):
        entrypoint = read("scripts/hermes-home-entrypoint")
        function = re.search(
            r"materialize_hermes_config\(\) \{\n.*?\n\}",
            entrypoint,
            flags=re.DOTALL,
        )
        self.assertIsNotNone(function)

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            persistent = root / "persistent"
            runtime = root / "run"
            temporary = root / "tmp"
            bin_dir = root / "bin"
            for path in (persistent, runtime, temporary, bin_dir):
                path.mkdir()
            active = persistent / "config.yaml"
            active.write_text("model:\n  default: kept/model\n", encoding="utf-8")
            secret_path = runtime / "health-token"
            secret = "runtime-only-health-token"
            secret_path.write_text(f"{secret}\n", encoding="utf-8")

            install = bin_dir / "install"
            install.write_text(
                "#!/bin/sh\nset -eu\n"
                "while [ $# -gt 2 ]; do shift 2; done\n"
                'cp "$1" "$2"\n',
                encoding="utf-8",
            )
            install.chmod(0o755)
            probe = root / "probe.sh"
            probe.write_text(
                "#!/bin/sh\nset -eu\n"
                + function.group(0)
                + '\nmaterialize_hermes_config "$1" "$2" "$3" "$4" '
                '"$5" "$6" "$7" "$8"\n',
                encoding="utf-8",
            )
            environment = os.environ.copy()
            environment["PATH"] = f"{bin_dir}:{environment['PATH']}"
            command = [
                "sh",
                str(probe),
                os.fspath(pathlib.Path(os.sys.executable)),
                str(HERMES_ROOT / "scripts/merge_hermes_config.py"),
                str(HERMES_ROOT / "profiles/andrii/config/config.yaml"),
                str(persistent / "config.base.yaml"),
                str(active),
                str(runtime / "config.yaml"),
                str(secret_path),
                str(temporary),
            ]

            for _ in range(2):
                subprocess.run(command, env=environment, check=True)
                self.assertTrue(active.is_symlink())
                self.assertIn(secret, (runtime / "config.yaml").read_text())
                self.assertNotIn(
                    secret, (persistent / "config.base.yaml").read_text()
                )
                base = yaml.safe_load(
                    (persistent / "config.base.yaml").read_text(encoding="utf-8")
                )
                self.assertNotIn("headers", base["mcp_servers"]["health"])
                (runtime / "config.yaml").unlink()

    def test_install_skills_executes_current_catalog_and_legacy_tombstones(self):
        entrypoint = read("scripts/hermes-home-entrypoint")
        function = re.search(
            r"install_skills\(\) \{\n.*?\n\}", entrypoint, flags=re.DOTALL
        )
        self.assertIsNotNone(function)
        current_match = re.search(
            r'^shared_skills="([^"]+)"$', entrypoint, re.MULTILINE
        )
        self.assertIsNotNone(current_match)
        current = current_match.group(1)
        self.assertEqual(
            current.split(), ["health", "home-assistant", "media", "web-research"]
        )
        cleanup = f"{current} media-admin movies series trending watching"
        self.assertIn(
            'shared_skill_cleanup="$shared_skills media-admin movies series trending watching"',
            entrypoint,
        )

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source = root / "source"
            destination = root / "destination"
            source.mkdir()
            destination.mkdir()
            for name in (*current.split(), "unmanaged-source"):
                skill = source / name
                skill.mkdir()
                (skill / "marker").write_text(name, encoding="utf-8")
            for name in (
                "health",
                "media-admin",
                "movies",
                "series",
                "trending",
                "watching",
                "user-custom",
            ):
                (destination / name).mkdir()

            script = root / "install-test.sh"
            script.write_text(
                "#!/bin/sh\nset -eu\n"
                + function.group(0)
                + f'\ninstall_skills "$1" "{current}" "{cleanup}" "$2"\n',
                encoding="utf-8",
            )
            subprocess.run(
                ["sh", str(script), str(source), str(destination)], check=True
            )

            self.assertEqual(
                {
                    path.name
                    for path in destination.iterdir()
                    if path.is_dir()
                },
                {*current.split(), "user-custom"},
            )
            for name in current.split():
                self.assertEqual(
                    (destination / name / "marker").read_text(encoding="utf-8"),
                    name,
                )


class EmbeddedHealthConfigTests(unittest.TestCase):
    def test_sanitized_persistent_base_removes_health_bearer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            current = root / "current.yaml"
            output = root / "base.yaml"
            bearer = "legacy-persistent-health-bearer"
            current.write_text(
                yaml.safe_dump(
                    {
                        "custom_keep": {"value": "kept"},
                        "mcp_servers": {
                            "health": {
                                "url": "http://old.invalid/mcp",
                                "headers": {"Authorization": f"Bearer {bearer}"},
                            }
                        },
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )

            result = subprocess.run(
                [
                    os.fspath(pathlib.Path(os.sys.executable)),
                    str(HERMES_ROOT / "scripts/merge_hermes_config.py"),
                    str(HERMES_ROOT / "profiles/andrii/config/config.yaml"),
                    str(current),
                    str(output),
                    "--sanitize-health",
                ],
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            persisted = output.read_text(encoding="utf-8")
            self.assertNotIn(bearer, persisted)
            persisted_yaml = yaml.safe_load(persisted)
            self.assertNotIn("headers", persisted_yaml["mcp_servers"]["health"])
            self.assertEqual(persisted_yaml["custom_keep"]["value"], "kept")

    def test_generated_profile_exactly_replaces_health_from_private_file(self):
        for profile in PROFILES:
            with tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                current_path = root / "current.yaml"
                output_path = root / "output.yaml"
                secret_path = root / "health-token"
                secret = f"private-{profile}-token"
                current_path.write_text(
                    yaml.safe_dump(
                        {
                            "mcp_servers": {
                                "health": {
                                    "transport": "sse",
                                    "command": "stale-command",
                                    "args": ["--stale"],
                                    "url": "http://stale.invalid/mcp",
                                    "headers": {
                                        "Authorization": "Bearer stale",
                                        "X-Stale": "stale",
                                    },
                                    "tools": {
                                        "include": ["stale"],
                                        "exclude": ["stale"],
                                        "resources": True,
                                    },
                                }
                            }
                        },
                        sort_keys=False,
                    ),
                    encoding="utf-8",
                )
                secret_path.write_text(f"{secret}\n", encoding="utf-8")
                environment = os.environ.copy()
                environment["HEALTH_API_TOKEN"] = "process-environment-token"
                result = subprocess.run(
                    [
                        "sh",
                        "-c",
                        'umask 022\nexec "$@"',
                        "sh",
                        os.fspath(pathlib.Path(os.sys.executable)),
                        str(HERMES_ROOT / "scripts/merge_hermes_config.py"),
                        str(HERMES_ROOT / f"profiles/{profile}/config/config.yaml"),
                        str(current_path),
                        str(output_path),
                        str(secret_path),
                    ],
                    env=environment,
                    check=True,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(result.stdout, "")
                self.assertEqual(result.stderr, "")
                self.assertNotIn(secret, result.stdout + result.stderr)
                self.assertNotIn("process-environment-token", output_path.read_text())
                self.assertEqual(stat.S_IMODE(output_path.stat().st_mode), 0o600)
                generated = yaml.safe_load(output_path.read_text(encoding="utf-8"))

            server = generated["mcp_servers"]["health"]
            self.assertEqual(
                server,
                {
                    "url": "${HEALTH_MCP_URL}",
                    "lazy": True,
                    "headers": {"Authorization": f"Bearer {secret}"},
                    "tools": {"resources": False, "prompts": False},
                },
            )

    def test_invalid_health_secret_fails_without_disclosure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            current = root / "current.yaml"
            output = root / "output.yaml"
            secret = root / "secret"
            current.write_text("{}\n", encoding="utf-8")
            secret.write_bytes(b"do-not-log\nembedded\n")
            result = subprocess.run(
                [
                    os.fspath(pathlib.Path(os.sys.executable)),
                    str(HERMES_ROOT / "scripts/merge_hermes_config.py"),
                    str(HERMES_ROOT / "profiles/andrii/config/config.yaml"),
                    str(current),
                    str(output),
                    str(secret),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr, "")
            self.assertFalse(output.exists())
            self.assertEqual(
                {path.name for path in root.iterdir()},
                {"current.yaml", "secret"},
            )

    def test_failed_atomic_replace_removes_private_temporary_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            current = root / "current.yaml"
            output = root / "output.yaml"
            secret_path = root / "secret"
            secret = "must-not-remain-on-disk"
            current.write_text("{}\n", encoding="utf-8")
            output.mkdir()
            secret_path.write_text(f"{secret}\n", encoding="utf-8")

            result = subprocess.run(
                [
                    os.fspath(pathlib.Path(os.sys.executable)),
                    str(HERMES_ROOT / "scripts/merge_hermes_config.py"),
                    str(HERMES_ROOT / "profiles/andrii/config/config.yaml"),
                    str(current),
                    str(output),
                    str(secret_path),
                ],
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr, "")
            self.assertEqual(list(output.iterdir()), [])
            self.assertEqual(
                {path.name for path in root.iterdir()},
                {"current.yaml", "output.yaml", "secret"},
            )


class EmbeddedHealthSkillContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.skill = read("shared/skills/health/SKILL.md")
        cls.compact = " ".join(cls.skill.split())

    def test_catalog_matches_exact_phase_one_tools(self):
        catalog = set(
            re.findall(r"^\| `([a-z_]+)` \|", self.skill, flags=re.MULTILINE)
        )
        self.assertEqual(catalog, HEALTH_TOOLS)

    def test_person_confirmation_duplicate_voice_chart_and_fact_rules(self):
        required = (
            "The bot owner is the default person.",
            "An explicitly named person always wins.",
            "Это относится к Andrii или Valentyna?",
            "two buttons: `Andrii` and `Valentyna`",
            "Do not write until the person is resolved.",
            "✅ Записать / ✏️ Исправить / 🚫 Отмена",
            "confirmed=true",
            "outcome=duplicate",
            "do not retry",
            "Transcribe voice messages",
            "exactly like text",
            "send the returned `image/png` PNG to the chat",
            "Never set `status` above `user_reported`",
            "Never invent",
            "never loop",
            "All user-facing health text and buttons are in Russian.",
            "Internal identifiers and tool arguments stay in English.",
            "native `clarify`",
        )
        for rule in required:
            self.assertIn(rule, self.compact)

    def test_skill_contract_has_exact_no_write_then_tool_sequences(self):
        rows = {}
        for line in self.skill.splitlines():
            match = re.fullmatch(
                r"\| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \|", line
            )
            if match:
                rows[match.group(1)] = (match.group(2), match.group(3))
        self.assertEqual(
            rows,
            {
                "ambiguous-person": (
                    "native clarify: Andrii / Valentyna; no write",
                    "after selection: resolve person, then apply matching flow",
                ),
                "routine-fact": (
                    "no confirmation",
                    "write immediately, then echo with ✏️ Исправить",
                ),
                "sensitive-write": (
                    "native clarify: ✅ Записать / ✏️ Исправить / 🚫 Отмена; no write",
                    "only after ✅: call the exact tool; cancel writes nothing",
                ),
            },
        )

    def test_worked_examples_cover_required_routes(self):
        rows = re.findall(r"^\| «.+?\| `.+?` \|$", self.skill, flags=re.MULTILINE)
        self.assertGreaterEqual(len(rows), 6)
        self.assertIn(
            "«Давление 138/92, пульс 80» | `add_measurement(kind=blood_pressure, values={systolic:138,diastolic:92,pulse:80})`",
            self.skill,
        )
        self.assertIn(
            '«Запиши Валентине вес 78,2» | `add_measurement(person=valentyna, kind=weight, values={value:78.2,unit:"kg"})`',
            self.skill,
        )
        self.assertIn(
            "«покажи вес за месяц» | `generate_chart(kind=weight, days=30)`; send the returned PNG to the chat",
            self.skill,
        )
        self.assertIn(
            "query the current measurement first and reuse its complete `systolic`, `diastolic`, and `pulse` values",
            self.compact,
        )
        self.assertIn(
            'new_values={systolic:<current>,diastolic:<current>,pulse:83}',
            self.skill,
        )
        self.assertNotIn("new_values={value:83}", self.skill)
        self.assertIn("`add_condition`", self.skill)
        self.assertIn("confirmed=true", self.skill)
        self.assertIn("Telegram source message timestamp", self.compact)
        self.assertIn("stable source update/message ID", self.compact)
        self.assertIn("stable per-fact identity", self.compact)
        self.assertIn("deterministic fact ordinal", self.compact)
        self.assertIn(":fact:1", self.skill)
        self.assertIn("raw message/update ID alone", self.compact)
        self.assertIn("makes no retry-deduplication promise", self.compact)
        self.assertIn("user-intended verbatim repeat", self.compact)
        self.assertIn("call `query_health_data`", self.compact)
        self.assertIn("Compare the complete typed values", self.compact)
        self.assertIn("do not call a write tool", self.compact)
        self.assertIn("explicit new time or context", self.compact)
        self.assertIn("agent-side preflight", self.compact)


if __name__ == "__main__":
    unittest.main()
