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


if __name__ == "__main__":
    unittest.main()
