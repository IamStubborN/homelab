import json
import os
import pathlib
import re
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import yaml


HERMES_ROOT = pathlib.Path(__file__).resolve().parents[1]
HOMELAB_ROOT = HERMES_ROOT.parent
PROFILES = ("primary", "secondary")
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
            "PRIMARY_TELEGRAM_USER_ID": "1",
            "PRIMARY_TELEGRAM_CHAT_ID": "1",
            "SECONDARY_TELEGRAM_USER_ID": "2",
            "SECONDARY_TELEGRAM_CHAT_ID": "2",
            "WIKI_ROOT": "/mnt/internal/wiki",
        }
    )
    return environment


def rendered_compose(
    path: pathlib.Path,
    cwd: pathlib.Path,
    *,
    interpolate: bool = True,
    profiles: tuple[str, ...] = (),
) -> dict:
    command = ["docker", "compose", "-f", str(path), "config"]
    if not interpolate:
        command.append("--no-interpolate")
    command.extend(("--format", "json"))
    environment = compose_environment()
    if profiles:
        environment["COMPOSE_PROFILES"] = ",".join(profiles)
    result = subprocess.run(
        command,
        cwd=cwd,
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def volume_target(service: dict, target: str) -> dict:
    matches = [volume for volume in service["volumes"] if volume["target"] == target]
    if len(matches) != 1:
        raise AssertionError(f"expected one volume at {target}, got {matches}")
    return matches[0]


class EmbeddedHealthComposeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.hermes = rendered_compose(HERMES_ROOT / "compose.yaml", HERMES_ROOT)
        cls.health = rendered_compose(
            HOMELAB_ROOT / "health/compose.yml", HOMELAB_ROOT / "health"
        )
        cls.wiki = rendered_compose(
            HOMELAB_ROOT / "wiki/compose.yml",
            HOMELAB_ROOT / "wiki",
            profiles=("g2-oauth",),
        )
        cls.homelab = {
            "services": {
                **cls.hermes["services"],
                **cls.health["services"],
                **cls.wiki["services"],
            },
            "volumes": {
                **cls.hermes.get("volumes", {}),
                **cls.health.get("volumes", {}),
                **cls.wiki.get("volumes", {}),
            },
        }

    def test_both_embedded_profiles_share_the_health_stack_network(self):
        for profile in PROFILES:
            service = self.hermes["services"][f"hermes-{profile}"]
            self.assertEqual(
                service["environment"]["HEALTH_MCP_URL"],
                "http://health-service:8080/internal/mcp",
            )
            self.assertEqual(service["environment"]["HEALTH_PRIMARY_PERSON"], "primary")
            self.assertEqual(service["environment"]["HEALTH_SECONDARY_PERSON"], "secondary")
            self.assertEqual(service["environment"]["HEALTH_DEFAULT_PERSON"], profile)
            self.assertIn("health-internal", service["networks"])
            self.assertEqual(
                service["image"],
                "nousresearch/hermes-agent:stable",
            )
            self.assertEqual(
                service["labels"]["com.centurylinklabs.watchtower.enable"],
                "true",
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
                    and volume["target"] == "/opt/data/skills/home"
                    and volume["read_only"]
                    for volume in service["volumes"]
                )
            )
            self.assertEqual(service["environment"]["WIKI_PATH"], "/wiki")
            self.assertNotIn("OBSIDIAN_VAULT_PATH", service["environment"])

        network = self.hermes["networks"]["health-internal"]
        self.assertTrue(network["external"])
        self.assertEqual(network["name"], "health-internal")

    def test_both_profiles_receive_private_health_person_ids(self):
        with patch.dict(os.environ, {
            "HEALTH_PRIMARY_PERSON": "legacy_one",
            "HEALTH_SECONDARY_PERSON": "legacy_two",
        }):
            compose = rendered_compose(HERMES_ROOT / "compose.yaml", HERMES_ROOT)
        for role in PROFILES:
            environment = compose["services"][f"hermes-{role}"]["environment"]
            self.assertEqual(environment["HEALTH_PRIMARY_PERSON"], "legacy_one")
            self.assertEqual(environment["HEALTH_SECONDARY_PERSON"], "legacy_two")
            self.assertEqual(environment["HEALTH_DEFAULT_PERSON"], f"legacy_{'one' if role == 'primary' else 'two'}")

    def test_root_compose_connects_health_service_and_both_hermes_profiles(self):
        includes = (HOMELAB_ROOT / "compose.yml").read_text(encoding="utf-8")
        for path in ("hermes/compose.yaml", "health/compose.yml", "wiki/compose.yml"):
            self.assertIn(path, includes)
        services = self.homelab["services"]
        self.assertIn("health-service", services)
        self.assertNotIn("health-postgres", services)
        self.assertNotIn("health-pg-data", self.homelab.get("volumes", {}))
        for name in ("health-service", "hermes-primary", "hermes-secondary"):
            self.assertIn("health-internal", services[name]["networks"])
        for name in ("health-drive", "syncthing"):
            self.assertIn(name, services)
            self.assertNotIn("health-internal", services[name].get("networks", {}))

    def test_health_compose_ships_python_cashier_not_rust_postgres(self):
        services = self.health["services"]
        self.assertEqual(set(services), {"health-service"})
        service = services["health-service"]
        self.assertEqual(service["image"], "family-health-mcp:local")
        self.assertEqual(service["container_name"], "health-service")
        self.assertEqual(service["user"], "10000:10000")
        self.assertEqual(
            pathlib.Path(service["build"]["context"]),
            HOMELAB_ROOT / "health/mcp",
        )
        self.assertEqual(
            service["labels"]["com.centurylinklabs.watchtower.enable"],
            "false",
        )
        self.assertEqual(
            service["environment"]["WIKI_HEALTH_ROOT"],
            "/wiki/shared/health",
        )
        wiki = volume_target(service, "/wiki/shared/health")
        self.assertEqual(wiki["source"], "/mnt/internal/wiki/shared/health")
        self.assertNotIn("health-postgres", services)
        self.assertNotIn("health-pg-data", self.health.get("volumes", {}))
        self.assertNotIn("health_pg_bootstrap_password", self.health.get("secrets", {}))
        self.assertNotIn("health_service_db_password", self.health.get("secrets", {}))

        dockerfile = (HOMELAB_ROOT / "health/mcp/Dockerfile").read_text(encoding="utf-8")
        self.assertIn(
            "python:3.12-slim-bookworm@sha256:",
            dockerfile,
        )
        self.assertIn("USER 10000:10000", dockerfile)
        self.assertIn('CMD ["python", "-m", "health_mcp.server"]', dockerfile)
        self.assertNotIn("cargo", dockerfile.lower())

        compose_text = (HOMELAB_ROOT / "health/compose.yml").read_text(encoding="utf-8")
        self.assertIn("context: ./mcp", compose_text)
        self.assertNotIn("context: ./service", compose_text)
        self.assertNotIn("image: family-health-service:local", compose_text)
        self.assertNotIn("health-postgres", compose_text)
        self.assertTrue((HOMELAB_ROOT / "health/service").is_dir())

    def test_wiki_compose_mounts_host_vault_and_stays_off_health_internal(self):
        for name, target, read_only, watchtower in (
            ("health-drive", "/data", True, "false"),
            ("syncthing", "/var/syncthing/wiki", False, "true"),
        ):
            service = self.wiki["services"][name]
            mount = volume_target(service, target)
            self.assertEqual(mount["source"], "/mnt/internal/wiki")
            self.assertEqual(bool(mount.get("read_only")), read_only)
            self.assertEqual(service["user"], "10000:10000")
            self.assertEqual(
                service["labels"]["com.centurylinklabs.watchtower.enable"],
                watchtower,
            )
            self.assertNotIn("health-internal", service.get("networks", {}))
        self.assertEqual(
            self.wiki["services"]["syncthing"]["image"],
            "syncthing/syncthing:latest",
        )

    def test_hermes_secrets_reuse_the_health_stack_token_files(self):
        health = rendered_compose(HOMELAB_ROOT / "health/compose.yml", HOMELAB_ROOT / "health")
        for profile in PROFILES:
            hermes_file = pathlib.Path(
                self.hermes["secrets"][f"{profile}_health_api_token"]["file"]
            )
            health_file = pathlib.Path(
                health["secrets"][f"{profile}_health_api_token"]["file"]
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
            self.assertNotIn("_config_version", config)
            disabled = config["skills"]["platform_disabled"]["telegram"]
            self.assertNotIn("llm-wiki", disabled)
            self.assertIn("obsidian", disabled)

    def test_wiki_nested_binds_personal_root_and_shared_tree(self):
        wiki_root = pathlib.Path("/mnt/internal/wiki")
        for profile in PROFILES:
            service = self.hermes["services"][f"hermes-{profile}"]
            volumes = {volume["target"]: volume for volume in service["volumes"]}
            personal = volumes["/wiki"]
            shared = volumes["/wiki/shared"]
            self.assertEqual(pathlib.Path(personal["source"]), wiki_root / profile)
            self.assertEqual(pathlib.Path(shared["source"]), wiki_root / "shared")
            self.assertFalse(personal.get("read_only", False))
            self.assertFalse(shared.get("read_only", False))
            other = "secondary" if profile == "primary" else "primary"
            self.assertNotEqual(pathlib.Path(personal["source"]), wiki_root / other)
            self.assertNotEqual(pathlib.Path(personal["source"]), wiki_root)

        health = self.homelab["services"]["health-service"]
        self.assertEqual(health["image"], "family-health-mcp:local")

    def test_health_runbook_documents_python_cashier_and_human_gates(self):
        runbook = (HOMELAB_ROOT / "health/README.md").read_text(encoding="utf-8")
        compact = " ".join(runbook.split())
        self.assertIn("family-health-mcp:local", runbook)
        self.assertIn("build context `health/mcp`", runbook)
        self.assertIn("`${WIKI_ROOT}/shared/health`", runbook)
        self.assertIn("ignored deployment environment", runbook)
        self.assertIn("install -o 10000 -g 10000 -m 0400", runbook)
        self.assertIn("`10000:10000 400`", runbook)
        self.assertIn("There are no Postgres passwords", compact)
        self.assertIn("no UID `10001` files", compact)
        self.assertIn("missing health wiki directory", runbook)
        self.assertIn("wiki/bootstrap-vault.sh", runbook)
        self.assertIn("wiki/README.md", runbook)
        self.assertIn("No Watchtower", runbook)
        self.assertIn("No GitHub Actions", runbook)
        self.assertIn("NEXTAUTH_SECRET", runbook)
        self.assertIn("cd health/mcp", runbook)
        self.assertIn("python3 -m pytest", runbook)
        for gate in ("**G1**", "**G2**", "**G3**", "**G4**", "**G5**"):
            self.assertIn(gate, runbook)
        self.assertIn("Obsidian Sync", runbook)
        self.assertIn("Server rclone OAuth", runbook)
        self.assertIn("Host directory", runbook)
        self.assertIn("Keep Google archive", runbook)
        self.assertIn("Recreate Hermes", runbook)
        self.assertIn(
            "docker compose up -d --force-recreate hermes-primary hermes-secondary",
            runbook,
        )
        self.assertNotIn("docker compose up --wait health-postgres", runbook)
        self.assertNotIn("pg_dump -U health", runbook)
        self.assertNotIn("cd health/service", runbook)
        self.assertNotIn("install -o 10001", runbook)

    def test_health_runbook_fails_closed_without_rust_or_postgres_rollback(self):
        runbook = (HOMELAB_ROOT / "health/README.md").read_text(encoding="utf-8")
        compact = " ".join(runbook.split())
        lower = compact.lower()
        self.assertIn("image-only rollback and in-place downgrade are unsupported", lower)
        self.assertIn("stop `health-service` and both hermes services", lower)
        self.assertIn("recommended default is to roll forward", lower)
        self.assertIn("leftover phase 1 rust source", lower)
        self.assertIn("do **not** switch compose back to the leftover rust crate", lower)
        self.assertIn("later manual", lower)
        self.assertLess(
            runbook.index("later manual"),
            runbook.index("docker volume rm health-pg-data"),
        )
        self.assertIn("not a deploy or rollback command", lower)
        self.assertNotIn("family-health-service:rollback", runbook)
        self.assertNotIn("retag `family-health-service:rollback`", runbook)
        self.assertNotIn("ALTER TABLE sleep_records DROP CONSTRAINT", runbook)
        self.assertNotIn("DELETE FROM seaql_migrations", runbook)
        self.assertNotIn("git switch --detach", runbook)
        self.assertNotIn("prior_revision=", runbook)
        self.assertNotIn("coordinated downgrade", runbook)
        self.assertNotIn("docker compose up -d health-postgres", runbook)

    def test_health_network_guard_rejects_legacy_non_internal_network(self):
        runbook = (HOMELAB_ROOT / "health/README.md").read_text(encoding="utf-8")
        block = re.search(
            r"before the first `up`:\n\n```bash\n(.*?)\n```", runbook, re.DOTALL
        )
        self.assertIsNotNone(block)
        self.assertNotIn("volume create", block.group(1))
        self.assertNotIn("health-pg-data", block.group(1))
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


class EmbeddedHealthSkillContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.skill = read("shared/skills/health/SKILL.md")
        cls.compact = " ".join(cls.skill.split())

    def test_skill_does_not_restate_tool_parameter_tables(self):
        catalog = set(
            re.findall(r"^\| `([a-z_]+)` \|", self.skill, flags=re.MULTILINE)
        )
        self.assertFalse(catalog & HEALTH_TOOLS)
        writes = read("shared/skills/health/WRITES.md")
        self.assertIn("mcp_health_*` schema", writes)

    def test_person_confirmation_duplicate_voice_chart_and_fact_rules(self):
        required = (
            "The bot owner is the default person.",
            "An explicitly named person always wins.",
            "Это относится к Primary или Secondary?",
            "two buttons: `Primary` and `Secondary`",
            "Do not write until the person is resolved.",
            "✅ Записать / ✏️ Исправить / 🚫 Отмена",
            "confirmed=true",
            "outcome=duplicate",
            "do not retry",
            "Transcribe voice messages",
            "exactly like text",
            "send the returned `image/png` PNG to the chat",
            "Keep `status` at `user_reported`",
            "Leave missing values unset",
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
                    "native clarify: Primary / Secondary; no write",
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
        rows = re.findall(r"^\| «", self.skill, flags=re.MULTILINE)
        self.assertGreaterEqual(len(rows), 6)
        self.assertIn(
            "«Давление 138/92, пульс 80» | `add_measurement(kind=blood_pressure, values={systolic:138,diastolic:92,pulse:80})`",
            self.skill,
        )
        self.assertIn(
            '«Запиши Secondary вес 78,2» | `add_measurement(person=$HEALTH_SECONDARY_PERSON, kind=weight, values={value:78.2,unit:"kg"})`',
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
        writes = " ".join(read("shared/skills/health/WRITES.md").split())
        self.assertIn("stable source update/message ID", writes)
        self.assertIn("stable per-fact identity", writes)
        self.assertIn("deterministic fact ordinal", writes)
        self.assertIn(":fact:1", read("shared/skills/health/WRITES.md"))
        self.assertIn("raw message/update ID alone", writes)
        self.assertIn("makes no retry-deduplication promise", writes)
        self.assertIn("user-intended verbatim repeat", self.compact)
        self.assertIn("call `query_health_data`", self.compact)
        self.assertIn("Compare the complete typed values", self.compact)
        self.assertIn("do not call a write tool", self.compact)
        self.assertIn("explicit new time or context", self.compact)
        self.assertIn("agent-side preflight", self.compact)

    def test_skill_uses_mcp_for_facts_and_llm_wiki_for_synthesis(self):
        required = (
            "Medical facts go through MCP",
            "MCP-only for facts",
            "Use only discovered `mcp_health_*` tools for facts",
            "not terminal, direct HTTP, SQL, or jsonl",
            "Never edit `data/` or `generated/`",
            "shared/health/generated",
            "llm-wiki",
            "not jsonl",
            "No silent wiki-as-ledger fallback",
            "Do not mix Primary and Secondary on one synthesis page",
        )
        for rule in required:
            self.assertIn(rule, self.compact)
        self.assertNotIn(
            "Never use terminal, files, or SQL for `data/` or `generated/`",
            self.skill,
        )
        self.assertNotIn("never use files for generated", self.skill.lower())


class EmbeddedHealthWikiExampleTests(unittest.TestCase):
    def test_compose_declares_nested_wiki_binds_and_wiki_path(self):
        compose = yaml.safe_load(read("compose.yaml"))
        for profile in PROFILES:
            service = compose["services"][f"hermes-{profile}"]
            self.assertEqual(service["environment"]["WIKI_PATH"], "/wiki")
            self.assertNotIn("OBSIDIAN_VAULT_PATH", service["environment"])
            mounts = "\n".join(service["volumes"])
            self.assertIn(
                f"${{HERMES_{profile.upper()}_WIKI_PATH:-${{WIKI_ROOT:-/mnt/internal/wiki}}/{profile}}}:/wiki",
                mounts,
            )
            self.assertIn(
                "${WIKI_ROOT:-/mnt/internal/wiki}/shared:/wiki/shared",
                mounts,
            )
            self.assertNotIn(
                "${WIKI_ROOT:-/mnt/internal/wiki}:/wiki\n",
                mounts + "\n",
            )
            self.assertEqual(service["image"], "nousresearch/hermes-agent:stable")

        health = yaml.safe_load(
            (HOMELAB_ROOT / "health/compose.yml").read_text(encoding="utf-8")
        )
        self.assertEqual(
            health["services"]["health-service"]["image"],
            "${HEALTH_MCP_IMAGE:-family-health-mcp:local}",
        )

    def test_example_schema_files_keep_mcp_as_the_medical_ledger(self):
        personal = (HOMELAB_ROOT / "health/docs/wiki-SCHEMA.example.md").read_text(
            encoding="utf-8"
        )
        shared = (
            HOMELAB_ROOT / "health/docs/wiki-health-SCHEMA.example.md"
        ).read_text(encoding="utf-8")
        personal_compact = " ".join(personal.split())
        shared_compact = " ".join(shared.split())

        self.assertIn("Medical facts go through MCP", personal_compact)
        self.assertIn("shared/health", personal)
        self.assertIn("Do not store blood pressure", personal_compact)
        self.assertIn("not jsonl", personal_compact)

        self.assertIn("person` on every page", shared)
        self.assertIn("No mixing Primary and Secondary on one synthesis page", shared)
        self.assertIn("Never edit `data/` or `generated/`", shared)
        self.assertIn("Medical facts go through MCP", shared_compact)


if __name__ == "__main__":
    unittest.main()
