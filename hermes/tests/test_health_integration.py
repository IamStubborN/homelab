import importlib.util
import json
import os
import pathlib
import re
import subprocess
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

    def test_entrypoint_exports_copies_and_manages_health(self):
        entrypoint = read("scripts/hermes-home-entrypoint")
        self.assertIn(
            "read_secret HEALTH_API_TOKEN /run/secrets/health_api_token", entrypoint
        )
        copied = re.search(r"for secret in ([^;]+); do", entrypoint)
        self.assertIsNotNone(copied)
        self.assertIn("health_api_token", copied.group(1).split())
        self.assertIn('install -o 10000 -g 10000 -m 0400 "$source"', entrypoint)
        managed = re.search(
            r'install_skills /etc/hermes-home/skills "([^"]+)"', entrypoint
        )
        self.assertIsNotNone(managed)
        self.assertEqual(
            set(managed.group(1).split()),
            {"health", "home-assistant", "media", "web-research"},
        )


class EmbeddedHealthConfigTests(unittest.TestCase):
    def test_generated_profile_config_has_exact_lazy_http_bearer_contract(self):
        path = HERMES_ROOT / "scripts/merge_hermes_config.py"
        spec = importlib.util.spec_from_file_location("merge_hermes_config", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        for profile in PROFILES:
            managed = yaml.safe_load(read(f"profiles/{profile}/config/config.yaml"))
            current = {
                "mcp_servers": {
                    "health": {
                        "url": "http://stale.invalid/mcp",
                        "tools": {"include": ["stale"], "exclude": ["stale"]},
                    }
                }
            }
            generated = module.merge(current, managed)
            server = generated["mcp_servers"]["health"]
            self.assertEqual(server["url"], "${HEALTH_MCP_URL}")
            self.assertTrue(server["lazy"])
            self.assertEqual(
                server["headers"]["Authorization"], "Bearer ${HEALTH_API_TOKEN}"
            )
            self.assertEqual(server["tools"], {"resources": False, "prompts": False})


class EmbeddedHealthSkillTests(unittest.TestCase):
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
        )
        for rule in required:
            self.assertIn(rule, self.compact)

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
