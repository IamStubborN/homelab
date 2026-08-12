import importlib.util
import pathlib
import sys
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
PLUGIN_PATH = ROOT / "scripts" / "agent_browser_plugin_vaultwarden.py"


def load_plugin():
    spec = importlib.util.spec_from_file_location("agent_browser_plugin_vaultwarden_tests", PLUGIN_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class VaultwardenCredentialPluginTests(unittest.TestCase):
    def test_manifest_declares_only_credential_read(self):
        plugin = load_plugin()
        self.assertEqual(
            plugin.TOKEN_FILE,
            pathlib.Path("/run/hermes-home-secrets/media_api_token"),
        )
        response = plugin.handle(
            {
                "protocol": "agent-browser.plugin.v1",
                "type": "plugin.manifest",
                "capability": "plugin.manifest",
                "request": {},
            }
        )
        self.assertEqual(response["manifest"]["name"], "vaultwarden")
        self.assertEqual(response["manifest"]["capabilities"], ["credential.read"])

    def test_resolves_one_approved_request_into_agent_browser_credential(self):
        plugin = load_plugin()
        broker_response = {
            "username": "andrii@example.test",
            "password": "secret",
            "url": "https://example.test/login",
        }
        with mock.patch.object(plugin, "call_broker", return_value=broker_response) as call:
            response = plugin.handle(
                {
                    "protocol": "agent-browser.plugin.v1",
                    "type": "credential.resolve",
                    "capability": "credential.read",
                    "request": {"profileName": "example", "itemRef": "request-1"},
                }
            )

        call.assert_called_once_with("browser_credential_resolve", "request-1")
        self.assertEqual(response["credential"]["password"], "secret")
        self.assertNotIn("data", response)


if __name__ == "__main__":
    unittest.main()
