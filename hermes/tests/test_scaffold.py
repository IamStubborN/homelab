import ast
import contextlib
import hashlib
import io
import json
import importlib.machinery
import importlib.util
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import yaml


ROOT = pathlib.Path(__file__).resolve().parents[1]


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


class ImageContractTests(unittest.TestCase):
    def test_hermes_uses_unmodified_official_pinned_image_without_watchtower(self):
        compose = yaml.safe_load(read("compose.yaml"))
        self.assertFalse((ROOT / "Dockerfile").exists())
        self.assertFalse((ROOT / "scripts/patch_hermes_telegram.py").exists())
        for profile in ("andrii", "valentyna"):
            service = compose["services"][f"hermes-{profile}"]
            self.assertEqual(
                service["image"],
                "nousresearch/hermes-agent@sha256:1eafbbd7357ef92265ab2ba3e11edd0ff550b36bd7a1643ca88a142d5a4d4f8f",
            )
            self.assertNotIn("pull_policy", service)
            self.assertEqual(
                service["labels"]["com.centurylinklabs.watchtower.enable"], "false"
            )

    def test_external_tools_update_without_rebuilding_hermes(self):
        compose = yaml.safe_load(read("compose.yaml"))
        updater = compose["services"]["agent-browser-updater"]
        self.assertEqual(updater["image"], "node:latest")
        self.assertIn("agent-browser@latest", updater["command"][0])
        installer = read("scripts/install_bitwarden_cli.py")
        self.assertIn('asset.get("digest"', installer)
        self.assertIn("hashlib.sha256", installer)
        self.assertIn("hmac.compare_digest", installer)


class _ComposeContractBase:
    @classmethod
    def setUpClass(cls):
        cls.compose_text = read("compose.yaml")
        cls.compose = yaml.safe_load(cls.compose_text)

    def test_profiles_use_same_image_with_isolated_state(self):
        services = self.compose["services"]
        andrii = services["hermes-andrii"]
        valentyna = services["hermes-valentyna"]
        self.assertEqual(andrii["image"], valentyna["image"])
        self.assertTrue(andrii["read_only"])
        self.assertTrue(valentyna["read_only"])
        self.assertNotEqual(andrii["volumes"], valentyna["volumes"])
        for profile, service in (("andrii", andrii), ("valentyna", valentyna)):
            mounts = "\n".join(service["volumes"])
            self.assertIn(
                f"./profiles/{profile}/config/config.yaml:/etc/hermes-home/config.yaml:ro",
                mounts,
            )
            self.assertIn(
                "./scripts/hermes-home-entrypoint:/usr/local/bin/hermes-home-entrypoint:ro",
                mounts,
            )
            self.assertIn(f"hermes_{profile}_memory:/opt/data/memories", mounts)
            self.assertIn(f"hermes_{profile}_browser:/opt/data/browser_auth", mounts)
            self.assertNotIn("/opt/data/vaultwarden", mounts)
        self.assertNotIn("vaultwarden", "\n".join(valentyna["volumes"]))


class ReleaseContractTests(unittest.TestCase):
    @staticmethod
    def load_contract_module():
        path = ROOT / "scripts/media_release_contract.py"
        if not path.is_file():
            raise AssertionError(f"media release contract consumer is missing: {path}")
        spec = importlib.util.spec_from_file_location("media_release_contract", path)
        if spec is None or spec.loader is None:
            raise AssertionError(f"cannot load media release contract consumer: {path}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    @staticmethod
    def write_bundle(path: pathlib.Path) -> None:
        path.mkdir()
        schema = {
            "schema_version": 1,
            "source_digest": "a" * 64,
            "tools": [
                {"name": "media_jobs_list", "inputSchema": {"type": "object"}},
                {"name": "media_queue_status", "inputSchema": {"type": "object"}},
            ],
        }
        capabilities = {
            "schema_version": 1,
            "mcp_server": "media_admin",
            "description": "Sanitized test fixture.",
            "tools": ["media_jobs_list", "media_queue_status"],
        }
        artifacts = {
            "MCP_SCHEMA.json": json.dumps(
                schema, sort_keys=True, separators=(",", ":")
            ) + "\n",
            "media-capabilities.json": json.dumps(
                capabilities, sort_keys=True, separators=(",", ":")
            ) + "\n",
            "media-linux-amd64.sha256": f"{'c' * 64}  media-linux-amd64\n",
        }
        for name, content in artifacts.items():
            (path / name).write_text(content, encoding="utf-8")
        release = {
            "application_version": "v0.0.0-example",
            "files": {
                name: {"sha256": hashlib.sha256(content.encode()).hexdigest()}
                for name, content in artifacts.items()
            },
            "migration_version": "m20260810_000040_example",
            "runner_build_digest": "b" * 64,
            "runner_image": f"registry.example.invalid/example/media-runner@sha256:{'2' * 64}",
            "schema_version": 1,
            "service_image": f"registry.example.invalid/example/media-service@sha256:{'1' * 64}",
            "source_revision": "d" * 40,
            "source_tree_digest": "a" * 64,
        }
        (path / "release.json").write_text(
            json.dumps(release, sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )

    def mutate_release(self, path: pathlib.Path, mutation) -> None:
        release_path = path / "release.json"
        release = json.loads(release_path.read_text(encoding="utf-8"))
        mutation(release)
        release_path.write_text(json.dumps(release), encoding="utf-8")

    def mutate_artifact(self, path: pathlib.Path, name: str, mutation) -> None:
        artifact_path = path / name
        artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
        mutation(artifact)
        artifact_path.write_text(json.dumps(artifact), encoding="utf-8")
        self.mutate_release(
            path,
            lambda release: release["files"][name].__setitem__(
                "sha256", hashlib.sha256(artifact_path.read_bytes()).hexdigest()
            ),
        )

    def test_valid_example_release_bundle_loads(self):
        contract = self.load_contract_module()
        release = contract.load_release_contract(ROOT.parent / "media/release.example")
        self.assertEqual(release["schema_version"], 1)
        self.assertIn("example.invalid", release["service_image"])

    def test_release_contract_rejects_missing_or_malformed_fields(self):
        contract = self.load_contract_module()
        mutations = {
            "missing application version": lambda value: value.pop("application_version"),
            "boolean schema version": lambda value: value.__setitem__("schema_version", True),
            "short source revision": lambda value: value.__setitem__("source_revision", "abc"),
            "invalid migration": lambda value: value.__setitem__("migration_version", "latest"),
            "missing file metadata": lambda value: value["files"].pop("MCP_SCHEMA.json"),
        }
        for name, mutation in mutations.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                bundle = pathlib.Path(directory) / "release"
                self.write_bundle(bundle)
                self.mutate_release(bundle, mutation)
                with self.assertRaises(contract.ContractError):
                    contract.load_release_contract(bundle)

    def test_release_contract_rejects_mutable_image_references(self):
        contract = self.load_contract_module()
        for field in ("service_image", "runner_image"):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                bundle = pathlib.Path(directory) / "release"
                self.write_bundle(bundle)
                self.mutate_release(bundle, lambda value: value.__setitem__(field, "example/media:latest"))
                with self.assertRaisesRegex(contract.ContractError, "immutable"):
                    contract.load_release_contract(bundle)

    def test_release_contract_image_repository_path_length_matches_producer(self):
        contract = self.load_contract_module()
        digest = f"@sha256:{'3' * 64}"
        registry = "registry.example"
        valid_repositories = [
            f"{registry}/{'r' * 255}",
            f"{registry}:5000/{'r' * 255}",
        ]
        for field in ("service_image", "runner_image"):
            for repository in valid_repositories:
                for tag in ("", ":release-tag"):
                    with self.subTest(field=field, repository=repository, tag=tag), tempfile.TemporaryDirectory() as directory:
                        bundle = pathlib.Path(directory) / "release"
                        self.write_bundle(bundle)
                        self.mutate_release(
                            bundle,
                            lambda value: value.__setitem__(field, f"{repository}{tag}{digest}"),
                        )
                        contract.load_release_contract(bundle)
            with self.subTest(field=field, length=256), tempfile.TemporaryDirectory() as directory:
                bundle = pathlib.Path(directory) / "release"
                self.write_bundle(bundle)
                self.mutate_release(
                    bundle,
                    lambda value: value.__setitem__(field, f"{registry}/{'r' * 256}{digest}"),
                )
                with self.assertRaisesRegex(contract.ContractError, "immutable"):
                    contract.load_release_contract(bundle)

    def test_release_contract_rejects_malicious_image_references(self):
        contract = self.load_contract_module()
        malicious = (
            f"https://registry.example/media@sha256:{'3' * 64}",
            f"registry.example/Media@sha256:{'3' * 64}",
            f"registry.example/media;touch@sha256:{'3' * 64}",
            f"registry.example/media value@sha256:{'3' * 64}",
            f"registry.example:0/media@sha256:{'3' * 64}",
            f"registry.example:65536/media@sha256:{'3' * 64}",
        )
        for field in ("service_image", "runner_image"):
            for reference in malicious:
                with self.subTest(field=field, reference=reference), tempfile.TemporaryDirectory() as directory:
                    bundle = pathlib.Path(directory) / "release"
                    self.write_bundle(bundle)
                    self.mutate_release(bundle, lambda value: value.__setitem__(field, reference))
                    with self.assertRaisesRegex(contract.ContractError, "immutable"):
                        contract.load_release_contract(bundle)

    def test_release_contract_rejects_checksum_drift(self):
        contract = self.load_contract_module()
        with tempfile.TemporaryDirectory() as directory:
            bundle = pathlib.Path(directory) / "release"
            self.write_bundle(bundle)
            (bundle / "media-linux-amd64.sha256").write_text(
                f"{'0' * 64}  media-linux-amd64\n", encoding="ascii"
            )
            with self.assertRaisesRegex(contract.ContractError, "hash"):
                contract.load_release_contract(bundle)

    def test_release_contract_rejects_capability_schema_tool_drift(self):
        contract = self.load_contract_module()
        with tempfile.TemporaryDirectory() as directory:
            bundle = pathlib.Path(directory) / "release"
            self.write_bundle(bundle)
            capabilities_path = bundle / "media-capabilities.json"
            capabilities = json.loads(capabilities_path.read_text(encoding="utf-8"))
            capabilities["tools"].reverse()
            capabilities_path.write_text(json.dumps(capabilities), encoding="utf-8")
            self.mutate_release(
                bundle,
                lambda value: value["files"]["media-capabilities.json"].__setitem__(
                    "sha256", hashlib.sha256(capabilities_path.read_bytes()).hexdigest()
                ),
            )
            with self.assertRaisesRegex(contract.ContractError, "tool names differ"):
                contract.load_release_contract(bundle)

    def test_release_contract_rejects_duplicate_tools(self):
        contract = self.load_contract_module()
        with tempfile.TemporaryDirectory() as directory:
            bundle = pathlib.Path(directory) / "release"
            self.write_bundle(bundle)
            schema_path = bundle / "MCP_SCHEMA.json"
            schema = json.loads(schema_path.read_text(encoding="utf-8"))
            schema["tools"].append(schema["tools"][0])
            schema_path.write_text(json.dumps(schema), encoding="utf-8")
            self.mutate_release(
                bundle,
                lambda value: value["files"]["MCP_SCHEMA.json"].__setitem__(
                    "sha256", hashlib.sha256(schema_path.read_bytes()).hexdigest()
                ),
            )
            with self.assertRaisesRegex(contract.ContractError, "unique"):
                contract.load_release_contract(bundle)

    def test_release_contract_requires_exact_capability_manifest_shape(self):
        contract = self.load_contract_module()
        mutations = {
            "boolean schema version": lambda value: value.__setitem__("schema_version", True),
            "missing description": lambda value: value.pop("description"),
            "extra field": lambda value: value.__setitem__("private_source", "forbidden"),
            "duplicate tools": lambda value: value["tools"].append(value["tools"][0]),
        }
        for name, mutation in mutations.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                bundle = pathlib.Path(directory) / "release"
                self.write_bundle(bundle)
                self.mutate_artifact(bundle, "media-capabilities.json", mutation)
                with self.assertRaises(contract.ContractError):
                    contract.load_release_contract(bundle)

    def test_release_contract_exposes_validated_cli_sha256(self):
        contract = self.load_contract_module()
        with tempfile.TemporaryDirectory() as directory:
            bundle = pathlib.Path(directory) / "release"
            self.write_bundle(bundle)
            release = contract.load_release_contract(bundle)
            self.assertEqual(release["cli_sha256"], "c" * 64)


class ComposeContractTests(_ComposeContractBase, unittest.TestCase):

    def test_profiles_register_the_owner_scoped_media_admin_mcp(self):
        for profile in ("andrii", "valentyna"):
            config = yaml.safe_load(read(f"profiles/{profile}/config/config.yaml"))
            server = config["mcp_servers"]["media_admin"]
            self.assertEqual(server["url"], "http://media-service:8080/internal/mcp")
            self.assertEqual(
                server["headers"]["Authorization"], "Bearer ${MEDIA_API_TOKEN}"
            )
            self.assertTrue(server["lazy"])
            self.assertNotIn("include", server["tools"])
            self.assertNotIn("exclude", server["tools"])
            self.assertFalse(server["tools"]["resources"])
            self.assertFalse(server["tools"]["prompts"])
            tool_search = config["tools"]["tool_search"]
            self.assertEqual(tool_search["enabled"], "auto")
            self.assertEqual(tool_search["listing"], "auto")
            self.assertEqual(tool_search["listing_max_tokens"], 1000)

    def test_media_cli_is_operator_only_and_not_mounted_into_hermes(self):
        for profile in ("andrii", "valentyna"):
            mounts = "\n".join(
                self.compose["services"][f"hermes-{profile}"]["volumes"]
            )
            self.assertNotIn("/usr/local/bin/media", mounts)
            self.assertNotIn("/usr/local/bin/hermes-media", mounts)

        readme = read("README.md")
        self.assertIn("trusted-host operator tool", readme)
        self.assertIn("not mounted into either Hermes container", readme)

    def test_required_profile_secrets_are_isolated_and_search_key_is_shared(self):
        services = self.compose["services"]
        for profile in ("andrii", "valentyna"):
            names = {
                entry["source"] if isinstance(entry, dict) else entry
                for entry in services[f"hermes-{profile}"]["secrets"]
            }
            self.assertEqual(
                names,
                {
                    f"{profile}_telegram_token",
                    f"{profile}_media_api_token",
                    f"{profile}_health_api_token",
                    f"{profile}_homeassistant_token",
                    f"{profile}_omniroute_api_key",
                    f"{profile}_webhook_hmac",
                    "search_ladder_api_key",
                },
            )
            self.assertNotIn("/run/secrets/vaultwarden_session", str(services[f"hermes-{profile}"]))

        broker = services["vaultwarden-broker-andrii"]
        self.assertEqual(
            {secret["source"] for secret in broker["secrets"]},
            {
                "andrii_vaultwarden_session",
                "andrii_media_api_token",
                "andrii_rezka_broker_token",
            },
        )
        secret_targets = {secret["source"]: secret["target"] for secret in broker["secrets"]}
        self.assertEqual(secret_targets["andrii_media_api_token"], "broker_api_token")
        self.assertEqual(secret_targets["andrii_rezka_broker_token"], "rezka_broker_token")
        self.assertNotIn("rezka_broker_token", str(services["hermes-andrii"]))
        self.assertIn(
            "agent-browser-plugin-vaultwarden",
            services["hermes-andrii"]["environment"]["AGENT_BROWSER_PLUGINS"],
        )
        self.assertNotIn("valentyna_vaultwarden_session", self.compose_text)

    def test_hermes_controls_only_its_profile_notifier(self):
        services = self.compose["services"]
        notifier_names = {
            name for name in services if name.startswith("media-notifier-")
        }
        self.assertEqual(
            notifier_names,
            {"media-notifier-andrii", "media-notifier-valentyna"},
        )

        for profile in ("andrii", "valentyna"):
            hermes = services[f"hermes-{profile}"]
            notifier = services[f"media-notifier-{profile}"]
            other = "valentyna" if profile == "andrii" else "andrii"

            self.assertEqual(
                hermes["environment"]["MEDIA_NOTIFIER_CONTROL_URL"],
                f"http://media-notifier-{profile}:8644",
            )
            self.assertNotIn(
                f"media-notifier-{other}",
                str(hermes["environment"]),
            )
            self.assertEqual(
                hermes["depends_on"][f"media-notifier-{profile}"]["condition"],
                "service_healthy",
            )
            self.assertNotIn("ports", notifier)
            self.assertEqual(notifier["expose"], ["8644"])
            self.assertIn(f"media_notifier_{profile}:/data", notifier["volumes"])

            hermes_hmac = next(
                secret
                for secret in hermes["secrets"]
                if secret["target"] == "webhook_hmac"
            )
            notifier_hmac = next(
                secret
                for secret in notifier["secrets"]
                if secret["target"] == "webhook_hmac"
            )
            self.assertEqual(hermes_hmac["source"], f"{profile}_webhook_hmac")
            self.assertEqual(notifier_hmac["source"], f"{profile}_webhook_hmac")

    def test_vaultwarden_login_broker_is_andrii_only(self):
        services = self.compose["services"]
        self.assertIn("vaultwarden-broker-andrii", services)
        self.assertNotIn("vaultwarden-broker-valentyna", services)

        andrii_broker = services["vaultwarden-broker-andrii"]
        broker_mounts = "\n".join(andrii_broker["volumes"])
        self.assertIn("hermes_andrii_vaultwarden:/opt/data/vaultwarden", broker_mounts)
        self.assertNotIn("browser-sockets", broker_mounts)
        self.assertNotIn(".agent-browser", broker_mounts)
        self.assertNotIn("/opt/data/browser_auth", broker_mounts)
        self.assertIn(
            "./config/vaultwarden-login-allowlist.json:"
            "/etc/hermes-home/vaultwarden-login-allowlist.json:ro",
            broker_mounts,
        )
        self.assertEqual(
            set(andrii_broker["networks"]), {"andrii-private", "rezka-credentials"}
        )
        self.assertTrue(self.compose["networks"]["rezka-credentials"]["external"])
        self.assertEqual(
            self.compose["networks"]["rezka-credentials"]["name"],
            "rezka-credentials",
        )
        self.assertIn("vaultwarden-broker-andrii", services["hermes-andrii"]["depends_on"])
        self.assertNotIn("vaultwarden", str(services["hermes-valentyna"]))
        self.assertNotIn("vaultwarden-broker-valentyna", self.compose_text)
        self.assertNotIn("hermes_valentyna_vaultwarden", self.compose_text)
        self.assertEqual(
            andrii_broker["entrypoint"],
            ["/usr/local/bin/vaultwarden-broker-entrypoint"],
        )
        self.assertEqual(andrii_broker["user"], "10000:10000")
        self.assertNotIn("cap_add", andrii_broker)
        self.assertEqual(andrii_broker["cap_drop"], ["ALL"])
        init = services["vaultwarden-init-andrii"]
        self.assertEqual(init["cap_add"], ["CHOWN", "DAC_OVERRIDE", "FOWNER"])
        self.assertEqual(init["networks"], ["none"])

    def test_browser_output_boundaries_are_enabled(self):
        for profile in ("andrii", "valentyna"):
            environment = self.compose["services"][f"hermes-{profile}"]["environment"]
            self.assertEqual(environment["AGENT_BROWSER_CONTENT_BOUNDARIES"], "1")
        andrii = self.compose["services"]["hermes-andrii"]["environment"]
        self.assertEqual(
            andrii["AGENT_BROWSER_ARGS"],
            "--disable-blink-features=AutomationControlled",
        )
        self.assertEqual(andrii["AGENT_BROWSER_RESTORE"], "andrii")
        self.assertIn("Chrome/149", andrii["AGENT_BROWSER_USER_AGENT"])

    def test_profiles_share_native_web_backends_on_an_internal_service_network(self):
        self.assertEqual(self.compose["networks"]["agent-tools"]["name"], "agent-tools")
        for profile in ("andrii", "valentyna"):
            service = self.compose["services"][f"hermes-{profile}"]
            self.assertIn("agent-tools", service["networks"])
            self.assertNotIn("SEARXNG_URL", service["environment"])
            self.assertEqual(
                service["environment"]["FIRECRAWL_API_URL"],
                "http://firecrawl-api:3002",
            )
            self.assertIn(
                "./shared/skills:/etc/hermes-home/skills:ro", service["volumes"]
            )

    def test_telegram_uses_working_docker_dns_instead_of_fallback_ip_transport(self):
        common_hosts = self.compose["x-hermes-common"]["extra_hosts"]
        self.assertEqual(common_hosts, ["api.telegram.org=149.154.167.220"])
        for profile in ("andrii", "valentyna"):
            environment = self.compose["services"][f"hermes-{profile}"]["environment"]
            self.assertEqual(environment["HERMES_TELEGRAM_USE_DEFAULT_HTTP"], "false")
            self.assertEqual(
                environment["HERMES_TELEGRAM_DISABLE_FALLBACK_IPS"], "true"
            )

    def test_no_docker_socket_or_curl_healthcheck(self):
        self.assertNotIn("/var/run/docker.sock", self.compose_text)
        self.assertNotIn("curl", self.compose_text)
        for name, service in self.compose["services"].items():
            if name != "vaultwarden-init-andrii":
                self.assertIn("healthcheck", service)


class SkillContractTests(unittest.TestCase):
    @staticmethod
    def load_capability_checker():
        path = ROOT / "scripts/check-media-capabilities"
        sys.path.insert(0, str(path.parent))
        spec = importlib.util.spec_from_file_location("check_media_capabilities", path)
        if spec is None or spec.loader is None:
            loader = importlib.machinery.SourceFileLoader("check_media_capabilities", str(path))
            spec = importlib.util.spec_from_loader(loader.name, loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_shared_web_research_skill_prefers_bounded_adaptive_pipeline(self):
        skill = read("shared/skills/web-research/SKILL.md")
        self.assertIn("/opt/data/skills/web-research/search.py", skill)
        self.assertIn("bounded evidence", skill)
        self.assertIn("Spark Medium", skill)
        self.assertIn("`web_search` once", skill)
        self.assertIn("then `web_extract` only", skill)
        self.assertIn("untrusted data", skill)
        self.assertIn("Do not probe internal services", skill)
        self.assertIn("supporting excerpts", skill)

    def test_media_routes_public_evidence_to_web_research(self):
        skill = read("shared/skills/media/SKILL.md")
        self.assertIn("`web-research`", skill)
        self.assertNotIn("curl", skill.lower())

    def test_rezka_login_allowlist_is_bound_to_one_vault_item(self):
        policy = json.loads(read("config/vaultwarden-login-allowlist.json"))
        self.assertEqual(len(policy["domains"]), 1)
        rezka = policy["domains"][0]
        self.assertEqual(rezka["hostname"], "rezka.ag")
        self.assertTrue(rezka["credential_item_id"])
        self.assertEqual(set(rezka), {"hostname", "include_subdomains", "credential_item_id"})

    def test_rezka_runtime_renews_automatically_without_browser_login(self):
        media_skill = read("shared/skills/media/SKILL.md")
        vaultwarden_skill = read("profiles/andrii/skills/vaultwarden-login/SKILL.md")
        readme = read("README.md")
        self.assertIn("renewed automatically by `media-service`", media_skill)
        self.assertIn("Never ask\nfor Telegram approval or use the browser", media_skill)
        self.assertNotIn("media rezka session refresh --credential-request ID", media_skill)
        for document in (media_skill, vaultwarden_skill, readme):
            self.assertIn("media_rezka_session_refresh", document)
            self.assertIn("credential_request_id", document)
        for document in (media_skill, vaultwarden_skill, readme):
            self.assertNotIn("vaultwarden-browser-login", document)
            self.assertNotIn("Anubis", document)
            self.assertNotIn("DLE", document)
        self.assertFalse((ROOT / "scripts/vaultwarden_browser_login.py").exists())

    def test_tracking_distinguishes_release_only_and_rezka_download_modes(self):
        skill = read("shared/skills/media/SKILL.md")
        self.assertIn("Ordinary tracking is source-independent", skill)
        self.assertIn("Never create ordinary tracking from a title alone", skill)
        self.assertIn("later checks search both providers", skill)
        self.assertIn("Rezka-only mode", skill)
        self.assertIn("media_tracking_create", skill)
        self.assertIn("media_tracking_set_baseline", skill)
        self.assertIn("media_tracking_check", skill)
        self.assertIn("media_tracking_enable_download", skill)
        self.assertIn("a `release_identity`", skill)
        self.assertIn("positive `source_id`", skill)
        self.assertIn("Ordinary subscriptions run hourly", skill)
        self.assertIn("do not delete and recreate", skill)
        self.assertNotIn("tracking add --provider PROVIDER", skill)

    def test_media_skill_uses_the_mcp_search_and_download_contract(self):
        skill = read("shared/skills/media/SKILL.md")
        for tool in (
            "media_search",
            "media_download",
            "media_release_schedule",
            "media_trending",
        ):
            self.assertIn(tool, skill)
        self.assertIn("continuation", skill)
        self.assertNotIn("hermes-media search", skill)
        self.assertNotIn("hermes-media download", skill)

    def test_media_skill_routes_weekly_trending_through_media_service(self):
        skill = read("shared/skills/media/SKILL.md")
        self.assertIn("media_trending", skill)
        self.assertIn("worldwide weekly TMDB trends", skill)
        self.assertIn("(`all`, `movie`, or `tv`)", skill)

    def test_deterministic_media_shortcuts_are_not_llm_skills(self):
        for name in ("watching", "movies", "series", "trending"):
            self.assertFalse((ROOT / "shared" / "skills" / name).exists())

    def test_media_shortcuts_are_prioritized_in_both_telegram_profiles(self):
        for profile in ("andrii", "valentyna"):
            config = read(f"profiles/{profile}/config/config.yaml")
            self.assertIn("priority_mode: prepend", config)
            for command in ("watching", "movies", "series", "trending"):
                self.assertIn(f"- {command}", config)

    def test_media_admin_rules_live_in_one_bounded_media_skill(self):
        self.assertFalse((ROOT / "shared/skills/media-admin").exists())
        skill = read("shared/skills/media/SKILL.md")
        self.assertLessEqual(len(skill.split()), 500)
        for required in (
            "mcp_media_admin_*",
            "media_jobs_list",
            "media_tracking_check",
            "plex_search",
            "qbittorrent_list",
            "media_file_inspect",
            "media_destructive_prepare",
            "media_destructive_confirm",
            "one-time confirmation token",
        ):
            self.assertIn(required, skill)
        self.assertNotIn("Docker", skill)

    def test_media_skill_leaves_deterministic_card_details_to_the_plugin(self):
        skill = read("shared/skills/media/SKILL.md")
        normalized = " ".join(skill.split())
        self.assertIn("media_job_get", normalized)
        self.assertIn("Do not invent progress", normalized)
        self.assertIn("return exactly `NO_REPLY`", normalized)
        self.assertNotIn("10-cell progress bar", normalized)
        self.assertNotIn("at most every ten seconds", normalized)

    def test_media_replies_hide_internal_ids_and_offer_safe_quick_actions(self):
        skill = read("shared/skills/media/SKILL.md")
        normalized = " ".join(skill.split())
        self.assertIn("Hide credentials, endpoints, paths, raw JSON, and internal IDs", normalized)
        self.assertIn("native `clarify`", skill)
        self.assertNotIn("<telegram-quick-replies>", skill)
        self.assertIn("destructive action", normalized)

    def test_readme_documents_the_mcp_first_media_contract(self):
        readme = read("README.md")
        lowered = readme.lower()
        self.assertNotIn("current limitation", lowered)
        self.assertNotIn("search and tracking commands are not implemented", lowered)
        self.assertIn("owner-scoped `media_admin` MCP server", readme)
        self.assertIn("search and continuation", readme)
        self.assertIn("complete tracking lifecycle", readme)
        self.assertIn("never invokes\n`hermes-media`", readme)

    def test_custom_skills_have_valid_compact_frontmatter(self):
        paths = list((ROOT / "shared/skills").glob("*/SKILL.md"))
        paths += list((ROOT / "profiles/andrii/skills").glob("*/SKILL.md"))
        for path in paths:
            content = path.read_text(encoding="utf-8")
            frontmatter = yaml.safe_load(content.split("---", 2)[1])
            description = frontmatter["description"]
            self.assertLessEqual(len(description), 60, path)
            self.assertTrue(description.endswith("."), path)

    def test_profile_identity_files_are_fixed(self):
        self.assertEqual(read("profiles/andrii/identity").strip(), "andrii")
        self.assertEqual(read("profiles/valentyna/identity").strip(), "valentyna")

    def test_profiles_enforce_adaptive_research_priority_even_without_skill_activation(self):
        for profile in ("andrii", "valentyna"):
            soul = read(f"profiles/{profile}/SOUL.md")
            self.assertIn("adaptive research client first", soul)
            self.assertIn("native `web_search` as fallback", soul)
            self.assertIn("`web_extract`", soul)
            self.assertIn("Never search the public web through a browser", soul)

    def test_hermes_runtime_secrets_are_private_to_the_gateway_user(self):
        compose = yaml.safe_load(read("compose.yaml"))
        for profile in ("andrii", "valentyna"):
            service = compose["services"][f"hermes-{profile}"]
            self.assertEqual(service["environment"]["HERMES_UID"], "10000")
            self.assertEqual(service["environment"]["HERMES_GID"], "10000")
            self.assertNotIn("group_add", service)

        entrypoint = read("scripts/hermes-home-entrypoint")
        self.assertIn(
            "read_secret MEDIA_API_TOKEN /run/secrets/media_api_token", entrypoint
        )
        self.assertIn("/run/hermes-home-secrets", entrypoint)
        self.assertIn("install -o 10000 -g 10000 -m 0400", entrypoint)
        self.assertIn(
            "for secret in media_api_token health_api_token broker_api_token webhook_hmac search_ladder_api_key",
            entrypoint,
        )
        self.assertIn('source="/run/secrets/$secret"', entrypoint)

        self.assertIn(
            "/run/hermes-home-secrets/media_api_token",
            read("scripts/hermes-media"),
        )
        self.assertIn(
            "/run/hermes-home-secrets/broker_api_token",
            read("scripts/vaultwarden-safe"),
        )
        for profile in ("andrii", "valentyna"):
            service = compose["services"][f"hermes-{profile}"]
            self.assertEqual(
                service["environment"]["WEBHOOK_SECRET_FILE"],
                "/run/hermes-home-secrets/webhook_hmac",
            )
            self.assertIn(
                {"source": "search_ladder_api_key", "target": "search_ladder_api_key"},
                service["secrets"],
            )
        self.assertEqual(
            compose["secrets"]["search_ladder_api_key"]["file"],
            "./secrets/search_ladder.api_key",
        )

    def test_vaultwarden_login_skill_is_andrii_only_and_requires_explicit_approval(self):
        skill = read("profiles/andrii/skills/vaultwarden-login/SKILL.md")
        client = read("scripts/vaultwarden-safe")
        entrypoint = read("scripts/hermes-home-entrypoint")

        for command in (
            "login-request URL",
            "login-status ID",
            "login-approve ID",
            "login-deny ID",
        ):
            self.assertIn(command, skill)
            self.assertIn(command, client)

        self.assertIn("available only to Andrii", skill)
        self.assertIn("native Telegram approval control", skill)
        self.assertIn("andrii) ;;", client)
        self.assertNotIn("valentyna", client.lower())
        self.assertNotIn("password", client.lower())
        for client_command, broker_command in (
            ("login-request", "login_request"),
            ("login-status", "login_status"),
            ("login-approve", "login_approve"),
            ("login-deny", "login_deny"),
        ):
            self.assertIn(
                f"{client_command}) broker_command={broker_command} ;;",
                client,
            )
        self.assertFalse((ROOT / "profiles/valentyna/skills/vaultwarden-login").exists())
        self.assertIn(
            "install_skills /etc/hermes-home/personal-skills",
            entrypoint,
        )
        self.assertNotIn("browser-sockets", entrypoint)
        self.assertIn("install_plugins /etc/hermes-home/personal-plugins", entrypoint)
        self.assertIn("mkdir -p /opt/data/plugins", entrypoint)
        self.assertIn("/command/s6-setuidgid hermes", entrypoint)
        self.assertIn("media_mcp_schema_revision", entrypoint)
        self.assertIn("hermes-mcp-schema-revision", entrypoint)
        self.assertIn("rm -f", entrypoint)
        self.assertIn("/opt/data/cache/mcp_schema_cache.json", entrypoint)
        self.assertIn("/opt/data/cache/tool_discovery_cache.json", entrypoint)
        self.assertTrue((ROOT / "shared/skills/media/MCP_SCHEMA.json").is_file())
        self.assertFalse((ROOT / "shared/skills/media/MCP_SCHEMA_REVISION").exists())
        self.assertIn("vaultwarden-approval", read("profiles/andrii/config/config.yaml"))
        self.assertFalse((ROOT / "profiles/valentyna/plugins/vaultwarden-approval").exists())

    def test_entrypoint_initializes_schema_cache_on_a_fresh_volume(self):
        path = ROOT / "scripts/hermes-home-entrypoint"
        entrypoint = path.read_text(encoding="utf-8")

        self.assertTrue(os.access(path, os.X_OK))
        create = "install -d -o 10000 -g 10000 -m 0755 /opt/data/cache"
        write = '/tmp/media-mcp-schema-revision "$schema_revision_cache"'
        self.assertIn(create, entrypoint)
        self.assertLess(entrypoint.index(create), entrypoint.index(write))
        subprocess.run(["sh", "-n", str(path)], check=True)

    def test_media_mcp_schema_revision_tracks_only_the_tool_schema(self):
        helper = ROOT / "scripts/hermes-mcp-schema-revision"
        artifact = json.loads(read("shared/skills/media/MCP_SCHEMA.json"))

        def revision(payload):
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8") as file:
                json.dump(payload, file, ensure_ascii=False)
                file.flush()
                return subprocess.run(
                    [sys.executable, str(helper), file.name],
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout.strip()

        expected = hashlib.sha256(
            json.dumps(
                sorted(artifact["tools"], key=lambda tool: tool["name"]),
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        self.assertEqual(revision(artifact), expected)

        metadata_only = dict(artifact, source_digest="0" * 64)
        self.assertEqual(revision(metadata_only), expected)
        reordered = dict(artifact, tools=list(reversed(artifact["tools"])))
        self.assertEqual(revision(reordered), expected)

        changed = json.loads(json.dumps(artifact))
        changed["tools"][0]["description"] += " changed"
        self.assertNotEqual(revision(changed), expected)

    def test_media_mcp_schema_artifact_matches_all_capabilities(self):
        artifact = json.loads(read("shared/skills/media/MCP_SCHEMA.json"))
        capabilities = [
            line.removeprefix("- `").removesuffix("`")
            for line in read("shared/skills/media/CAPABILITIES.md").splitlines()
            if line.startswith("- `")
        ]
        self.assertEqual(artifact["schema_version"], 1)
        self.assertRegex(artifact["source_digest"], r"^[0-9a-f]{64}$")
        self.assertEqual(
            [tool["name"] for tool in artifact["tools"]],
            sorted(capabilities),
        )
        self.assertEqual(len(artifact["tools"]), 43)

    def test_media_capability_check_consumes_the_release_bundle(self):
        env = os.environ.copy()
        env["MEDIA_RELEASE_DIR"] = str(ROOT.parent / "media/release.example")
        result = subprocess.run(
            [str(ROOT / "scripts/check-media-capabilities")],
            text=True,
            capture_output=True,
            env=env,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("43 dynamically discovered tools", result.stdout)

    def test_media_capability_sync_rolls_back_on_second_publication_failure(self):
        checker = self.load_capability_checker()
        release_dir = ROOT.parent / "media/release.example"
        with tempfile.TemporaryDirectory() as directory:
            temporary = pathlib.Path(directory)
            schema = temporary / "MCP_SCHEMA.json"
            capabilities = temporary / "CAPABILITIES.md"
            schema.write_text("old schema\n", encoding="utf-8")
            capabilities.write_text("old capabilities\n", encoding="utf-8")
            real_replace = os.replace
            calls = 0

            def fail_second(source, destination):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("second publication failed")
                return real_replace(source, destination)

            with (
                mock.patch.object(checker, "SCHEMA_ARTIFACT", schema),
                mock.patch.object(checker, "CAPABILITY_DOC", capabilities),
                mock.patch.object(checker, "PROFILES", ()),
                mock.patch.object(checker, "referenced_tools", return_value=set(
                    json.loads((release_dir / "media-capabilities.json").read_text())["tools"]
                )),
                mock.patch.object(checker.os, "replace", side_effect=fail_second),
                mock.patch.object(sys, "argv", ["check-media-capabilities", "--release-dir", str(release_dir), "--sync"]),
                contextlib.redirect_stderr(io.StringIO()),
            ):
                self.assertEqual(checker.main(), 1)
            self.assertEqual(schema.read_text(encoding="utf-8"), "old schema\n")
            self.assertEqual(capabilities.read_text(encoding="utf-8"), "old capabilities\n")


    def test_media_deploy_preflight_uses_only_the_release_directory(self):
        preflight = ROOT / "scripts/deploy-preflight"
        source = preflight.read_text(encoding="utf-8")
        checker = (ROOT / "scripts/check-media-capabilities").read_text(encoding="utf-8")
        self.assertTrue(os.access(preflight, os.X_OK))
        self.assertIn("set -eu", source)
        self.assertIn("MEDIA_RELEASE_DIR is required", source)
        self.assertNotIn("MEDIA_ORCHESTRATOR_DIR", source + checker)
        self.assertNotIn("../../media-orchestrator", source + checker)
        self.assertIn("./scripts/deploy-preflight", read("scripts/check"))
        subprocess.run(["sh", "-n", str(preflight)], check=True)

    def test_media_deploy_preflight_compares_live_tools_canonically(self):
        release_dir = ROOT.parent / "media/release.example"
        artifact = json.loads((release_dir / "MCP_SCHEMA.json").read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            live_tools = pathlib.Path(directory) / "live-tools.json"
            live_tools.write_text(json.dumps(list(reversed(artifact["tools"]))), encoding="utf-8")
            env = os.environ.copy()
            env["MEDIA_RELEASE_DIR"] = str(release_dir)
            command = [str(ROOT / "scripts/deploy-preflight"), "--live-tools", str(live_tools)]
            matching = subprocess.run(command, text=True, capture_output=True, env=env, check=False)
            self.assertEqual(matching.returncode, 0, matching.stderr)
            artifact["tools"][0]["description"] += " drift"
            live_tools.write_text(json.dumps(artifact["tools"]), encoding="utf-8")
            drifted = subprocess.run(command, text=True, capture_output=True, env=env, check=False)
            self.assertNotEqual(drifted.returncode, 0)
            self.assertIn("differs from the release bundle", drifted.stderr)

    def test_media_deploy_preflight_compares_live_oci_attestation(self):
        release_dir = ROOT.parent / "media/release.example"
        release = json.loads((release_dir / "release.json").read_text(encoding="utf-8"))
        expected = {
            "image": release["service_image"],
            "revision": release["source_revision"],
            "version": release["application_version"],
            "source_tree_digest": release["source_tree_digest"],
            "runner_build_digest": release["runner_build_digest"],
        }
        with tempfile.TemporaryDirectory() as directory:
            attestation = pathlib.Path(directory) / "attestation.json"
            attestation.write_text(json.dumps(expected), encoding="utf-8")
            env = os.environ.copy()
            env["MEDIA_RELEASE_DIR"] = str(release_dir)
            command = [str(ROOT / "scripts/deploy-preflight"), "--live-attestation", str(attestation)]
            matching = subprocess.run(command, text=True, capture_output=True, env=env, check=False)
            self.assertEqual(matching.returncode, 0, matching.stderr)
            expected["revision"] = "0" * 40
            attestation.write_text(json.dumps(expected), encoding="utf-8")
            drifted = subprocess.run(command, text=True, capture_output=True, env=env, check=False)
            self.assertNotEqual(drifted.returncode, 0)
            self.assertIn("OCI attestation differs from the release bundle", drifted.stderr)

    def test_media_deploy_preflight_validates_staged_cli(self):
        with tempfile.TemporaryDirectory() as directory:
            release_dir = pathlib.Path(directory) / "release"
            ReleaseContractTests.write_bundle(release_dir)
            cli = pathlib.Path(directory) / "media"
            cli.write_bytes(b"staged cli\n")
            digest = hashlib.sha256(cli.read_bytes()).hexdigest()
            checksum = release_dir / "media-linux-amd64.sha256"
            checksum.write_text(f"{digest}  media-linux-amd64\n", encoding="ascii")
            release_path = release_dir / "release.json"
            release = json.loads(release_path.read_text(encoding="utf-8"))
            release["files"][checksum.name]["sha256"] = hashlib.sha256(checksum.read_bytes()).hexdigest()
            release_path.write_text(json.dumps(release), encoding="utf-8")
            checker = pathlib.Path(directory) / "checker.py"
            checker.write_text("import sys\nsys.exit(0)\n", encoding="utf-8")
            env = os.environ.copy()
            env["MEDIA_RELEASE_DIR"] = str(release_dir)
            env["HERMES_CAPABILITY_CHECKER"] = str(checker)
            command = [str(ROOT / "scripts/deploy-preflight"), "--staged-cli", str(cli)]
            matching = subprocess.run(command, text=True, capture_output=True, env=env, check=False)
            self.assertEqual(matching.returncode, 0, matching.stderr)
            cli.write_bytes(b"drifted cli\n")
            drifted = subprocess.run(command, text=True, capture_output=True, env=env, check=False)
            self.assertNotEqual(drifted.returncode, 0)
            self.assertIn("staged media CLI checksum differs", drifted.stderr)
            cli.unlink()
            missing = subprocess.run(command, text=True, capture_output=True, env=env, check=False)
            self.assertNotEqual(missing.returncode, 0)
            self.assertIn("staged media CLI", missing.stderr)



class WrapperContractTests(unittest.TestCase):
    def run_script(self, script: str, fake_name: str, fake_body: str, *args: str):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = pathlib.Path(temp_dir)
            fake = temp / fake_name
            fake.write_text(fake_body, encoding="utf-8")
            fake.chmod(0o755)
            env = os.environ.copy()
            env["PATH"] = f"{temp}:{env['PATH']}"
            env["HERMES_HOME_TESTING"] = "1"
            return subprocess.run(
                [str(ROOT / script), *args],
                text=True,
                capture_output=True,
                env=env,
                check=False,
            )

    def test_media_wrapper_forces_json_and_rejects_identity_flags(self):
        fake = "#!/bin/sh\nprintf '%s\\n' \"$*\"\n"
        result = self.run_script(
            "scripts/hermes-media", "media", fake, "queue", "status"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "queue status --json")

        rejected = self.run_script(
            "scripts/hermes-media",
            "media",
            fake,
            "jobs",
            "create",
            "--requested-by",
            "valentyna",
        )
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("identity-controlled option", rejected.stderr)

        for forbidden_flag in (
            "--requested-by=valentyna",
            "--requested_by=valentyna",
            "--token=abc",
            "--token-file=/etc/passwd",
            "--service-url=http://attacker.test",
        ):
            rejected_equals = self.run_script(
                "scripts/hermes-media", "media", fake, "jobs", "create", forbidden_flag
            )
            self.assertNotEqual(
                rejected_equals.returncode, 0, f"{forbidden_flag} should be rejected"
            )
            self.assertIn("identity-controlled option", rejected_equals.stderr)

        selected = self.run_script(
            "scripts/hermes-media",
            "media",
            fake,
            "download",
            "--session",
            "session-1",
            "--result",
            "result-1",
        )
        self.assertEqual(selected.returncode, 0, selected.stderr)
        self.assertEqual(
            selected.stdout.strip(),
            "download --session session-1 --result result-1 --json",
        )

        refreshed = self.run_script(
            "scripts/hermes-media",
            "media",
            fake,
            "rezka",
            "session",
            "refresh",
            "--credential-request",
            "request-1",
        )
        self.assertEqual(refreshed.returncode, 0, refreshed.stderr)
        self.assertEqual(
            refreshed.stdout.strip(),
            "rezka session refresh --credential-request request-1 --json",
        )

        released = self.run_script(
            "scripts/hermes-media",
            "media",
            fake,
            "release",
            "--title",
            "One Piece",
        )
        self.assertEqual(released.returncode, 0, released.stderr)
        self.assertEqual(
            released.stdout.strip(),
            "release --title One Piece --json",
        )

        trending = self.run_script(
            "scripts/hermes-media",
            "media",
            fake,
            "trending",
            "--category",
            "tv",
            "--page",
            "2",
        )
        self.assertEqual(trending.returncode, 0, trending.stderr)
        self.assertEqual(
            trending.stdout.strip(),
            "trending --category tv --page 2 --json",
        )

    def test_media_wrapper_marks_only_conversational_telegram_downloads(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = pathlib.Path(temp_dir)
            fake = temp / "media"
            fake.write_text("#!/bin/sh\nprintf '{\"status\":\"queued\"}\\n'\n", encoding="utf-8")
            fake.chmod(0o755)
            marker = temp / "download-succeeded"
            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{temp}:{env['PATH']}",
                    "HERMES_HOME_TESTING": "1",
                    "HERMES_SESSION_PLATFORM": "telegram",
                    "HERMES_MEDIA_SILENCE_MARKER": str(marker),
                }
            )

            result = subprocess.run(
                [str(ROOT / "scripts/hermes-media"), "download", "--session", "one"],
                text=True,
                capture_output=True,
                env=env,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(marker.is_file())
            marker.unlink()
            env["HERMES_MEDIA_CALLBACK"] = "1"
            callback = subprocess.run(
                [str(ROOT / "scripts/hermes-media"), "download", "--session", "two"],
                text=True,
                capture_output=True,
                env=env,
                check=False,
            )
            self.assertEqual(callback.returncode, 0, callback.stderr)
            self.assertFalse(marker.exists())

    def test_vaultwarden_broker_redacts_item_secrets(self):
        item = json.dumps(
            {
                "id": "item-1",
                "name": "Plex",
                "login": {
                    "username": "family@example.test",
                    "password": "never-visible",
                    "uris": [{"uri": "https://plex.example.test"}],
                },
                "notes": "also-secret",
            }
        )
        path = ROOT / "scripts/vaultwarden_broker.py"
        spec = importlib.util.spec_from_file_location("vaultwarden_broker", path)
        module = importlib.util.module_from_spec(spec)
        sys.path.insert(0, str(path.parent))
        try:
            spec.loader.exec_module(module)
        finally:
            sys.path.pop(0)
        sanitized = module.sanitize_item(json.loads(item))
        rendered = json.dumps(sanitized)
        self.assertEqual(sanitized["username"], "family@example.test")
        self.assertNotIn("never-visible", rendered)
        self.assertNotIn("also-secret", rendered)


class ProfileConfigTests(unittest.TestCase):
    def test_telegram_media_plugin_uses_focused_modules(self):
        plugin_root = ROOT / "shared/plugins/telegram-home"
        module_names = (
            "media_models.py",
            "media_action_store.py",
            "media_search.py",
            "media_callbacks.py",
            "media_commands.py",
            "media_panel.py",
        )

        for module_name in module_names:
            self.assertTrue((plugin_root / module_name).is_file())

        plugin = read("shared/plugins/telegram-home/__init__.py")
        module = ast.parse(plugin)
        top_level_classes = {
            node.name for node in module.body if isinstance(node, ast.ClassDef)
        }
        top_level_functions = {
            node.name
            for node in module.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }

        self.assertEqual(top_level_classes, {"HomeTelegramAdapter"})
        self.assertEqual(
            top_level_functions,
            {
                "_action_markup",
                "_dispatch_media_mcp",
                "_run_media",
                "_search_media_mcp",
                "_strip_internal_ids",
                "_suppress_download_confirmation",
                "_build_adapter",
                "register",
            },
        )
        self.assertIn("from .media_models import", plugin)
        self.assertIn("from .media_commands import", plugin)
        self.assertIn("from .media_panel import", plugin)
        self.assertIn("from .media_action_store import", plugin)
        self.assertIn("from .media_search import", plugin)
        self.assertIn("from .media_callbacks import", plugin)
        self.assertIn("class HomeTelegramAdapter(TelegramAdapter)", plugin)
        self.assertIn('ctx.register_platform(\n        name="telegram"', plugin)
        self.assertNotIn("create_subprocess_exec", plugin)
        self.assertNotIn("/usr/local/bin/hermes-media", plugin)

    def test_media_notifications_are_external_to_hermes(self):
        compose = yaml.safe_load(read("compose.yaml"))
        notifier = read("scripts/media-notifier")
        plugin = read("shared/plugins/telegram-home/__init__.py")
        self.assertIn("editMessageText", notifier)
        self.assertIn("sendMessage", notifier)
        self.assertIn("sendPhoto", notifier)
        self.assertIn("X-Webhook-Signature-V2", notifier)
        self.assertIn("class HomeTelegramAdapter(TelegramAdapter)", plugin)
        self.assertIn('ctx.register_platform(\n        name="telegram"', plugin)
        self.assertNotIn("handle_message", plugin)
        for profile in ("andrii", "valentyna"):
            service = compose["services"][f"media-notifier-{profile}"]
            self.assertEqual(service["image"], "python:latest")
            self.assertIn(f"media_notifier_{profile}:/data", service["volumes"])
            self.assertIn(
                "./shared/plugins/telegram-home/assets/media-menu.jpg:"
                "/usr/local/share/hermes-home/media-menu.jpg:ro",
                service["volumes"],
            )

    def test_profiles_use_native_clarify_and_no_webhook_adapter(self):
        for profile in ("andrii", "valentyna"):
            config = yaml.safe_load(read(f"profiles/{profile}/config/config.yaml"))
            self.assertEqual(config["terminal"]["home_mode"], "profile")
            self.assertIsNone(config["platforms"]["webhook"])
            self.assertIn("telegram-home", config["plugins"]["enabled"])
            self.assertIn("native `clarify`", read(f"profiles/{profile}/SOUL.md"))
            self.assertEqual(config["browser"]["inactivity_timeout"], 120)
            self.assertFalse(config["browser"]["camofox"]["managed_persistence"])
            self.assertIsNone(config["web"]["search_backend"])
            self.assertEqual(config["web"]["extract_backend"], "firecrawl")
            self.assertEqual(config["display"]["tool_progress"], "new")
            self.assertEqual(
                config["display"]["platforms"]["telegram"]["tool_progress"], "off"
            )
            self.assertEqual(config["display"]["memory_notifications"], "off")
            self.assertTrue(config["compression"]["codex_responses_native"])
            self.assertEqual(config["skills"]["creation_nudge_interval"], 10)
            self.assertEqual(config["model"]["provider"], "openai-api")
            self.assertEqual(config["model"]["default"], "gpt-5.6-luna")
            self.assertEqual(
                config["fallback_providers"],
                [
                    {
                        "provider": "openai-api",
                        "base_url": "http://omniroute:20129/v1",
                        "model": "gpt-5.6-terra",
                    },
                    {
                        "provider": "openai-api",
                        "base_url": "http://omniroute:20129/v1",
                        "model": "gpt-5.6-sol",
                    },
                ],
            )
            self.assertEqual(config["agent"]["reasoning_effort"], "low")
            self.assertEqual(
                config["agent"]["reasoning_overrides"],
                {
                    "gpt-5.6-terra": "high",
                    "gpt-5.6-luna": "high",
                    "gpt-5.6-sol": "low",
                },
            )

    def test_managed_shared_skills_are_pinned_at_startup(self):
        entrypoint = read("scripts/hermes-home-entrypoint")
        self.assertIn("for skill in /etc/hermes-home/skills/*", entrypoint)
        self.assertIn('curator pin "$(basename "$skill")"', entrypoint)


class ManagedConfigMergeTests(unittest.TestCase):
    def test_managed_mcp_tools_remove_stale_discovery_filters(self):
        path = ROOT / "scripts/merge_hermes_config.py"
        spec = importlib.util.spec_from_file_location("merge_hermes_config", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        merged = module.merge(
            {
                "mcp_servers": {
                    "media_admin": {
                        "tools": {
                            "include": ["old_tool"],
                            "exclude": ["other_tool"],
                            "resources": True,
                        }
                    }
                }
            },
            {
                "mcp_servers": {
                    "media_admin": {
                        "tools": {"resources": False, "prompts": False}
                    }
                }
            },
        )

        tools = merged["mcp_servers"]["media_admin"]["tools"]
        self.assertNotIn("include", tools)
        self.assertNotIn("exclude", tools)
        self.assertFalse(tools["resources"])
        self.assertFalse(tools["prompts"])

    def test_managed_null_removes_a_retired_config_key(self):
        path = ROOT / "scripts/merge_hermes_config.py"
        spec = importlib.util.spec_from_file_location("merge_hermes_config", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        merged = module.merge(
            {"platforms": {"telegram": {}, "webhook": {"enabled": True}}},
            {"platforms": {"webhook": None}},
        )

        self.assertNotIn("webhook", merged["platforms"])

    def test_managed_config_updates_web_without_losing_oauth_model_settings(self):
        path = ROOT / "scripts/merge_hermes_config.py"
        spec = importlib.util.spec_from_file_location("merge_hermes_config", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        current = {
            "model": {"provider": "openai-codex", "default": "gpt-5.6-luna"},
            "agent": {"verify_on_stop": True, "reasoning_effort": "high"},
        }
        managed = {
            "agent": {"verify_on_stop": False},
            "web": {"search_backend": "searxng", "extract_backend": "firecrawl"},
        }

        merged = module.merge(current, managed)

        self.assertEqual(merged["model"], current["model"])
        self.assertEqual(merged["agent"]["reasoning_effort"], "high")
        self.assertFalse(merged["agent"]["verify_on_stop"])
        self.assertEqual(merged["web"], managed["web"])


if __name__ == "__main__":
    unittest.main()
