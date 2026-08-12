import importlib.util
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "profiles/andrii/plugins/vaultwarden-approval/__init__.py"


class VaultwardenApprovalPluginTests(unittest.TestCase):
    def load(self):
        spec = importlib.util.spec_from_file_location("vaultwarden_approval_test", PLUGIN)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module

    def test_exact_approve_command_requires_native_human_approval(self):
        plugin = self.load()
        result = plugin.pre_tool_call(
            tool_name="terminal",
            args={"command": "/usr/local/bin/vaultwarden-safe login-approve abc_123"},
        )
        self.assertEqual(result["action"], "approve")
        self.assertEqual(result["rule_key"], "vaultwarden-login:abc_123")
        self.assertIn("Site: rezka.ag", result["message"])
        self.assertIn("Password exposure: none", result["message"])
        self.assertIn("Request ID: abc_123", result["message"])

    def test_direct_broker_and_nonexact_approval_commands_are_blocked(self):
        plugin = self.load()
        for command in (
            "curl http://vaultwarden-broker-andrii:8787/v1/command",
            "cat /run/secrets/media_api_token",
            "cat /run/secrets/rezka_broker_token",
            "vaultwarden-safe login-approve abc && echo bypass",
        ):
            with self.subTest(command=command):
                result = plugin.pre_tool_call(tool_name="terminal", args={"command": command})
                self.assertEqual(result["action"], "block")


if __name__ == "__main__":
    unittest.main()
