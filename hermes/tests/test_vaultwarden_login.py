import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))


def load_module(name, filename):
    path = SCRIPTS / filename
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


BROKER = load_module("vaultwarden_broker_login_tests", "vaultwarden_broker.py")
def required_attribute(test_case, module, name):
    test_case.assertTrue(hasattr(module, name), f"missing required API: {name}")
    return getattr(module, name)


class LoginPolicyTests(unittest.TestCase):
    def setUp(self):
        self.audit_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.audit_directory.cleanup)
        previous_audit = BROKER.AUDIT
        self.addCleanup(setattr, BROKER, "AUDIT", previous_audit)
        BROKER.AUDIT = BROKER.AuditLogger(
            pathlib.Path(self.audit_directory.name) / "audit.jsonl",
            clock=lambda: 1_000.0,
        )

    def write_policy(self, domains):
        temporary = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
        self.addCleanup(pathlib.Path(temporary.name).unlink, missing_ok=True)
        json.dump({"domains": domains}, temporary)
        temporary.close()
        return pathlib.Path(temporary.name)

    def test_normalizes_only_https_dns_hostnames(self):
        normalize_login_url = required_attribute(self, BROKER, "normalize_login_url")
        invalid_request = required_attribute(self, BROKER, "InvalidLoginRequest")
        target = normalize_login_url("HTTPS://Login.Example.Test:443/sign-in?next=/")
        self.assertEqual(target.hostname, "login.example.test")
        self.assertEqual(target.origin, "https://login.example.test")

        for value in (
            "http://login.example.test/sign-in",
            "https://127.0.0.1/sign-in",
            "https://[::1]/sign-in",
            "https://user:password@login.example.test/sign-in",
            "https:///sign-in",
        ):
            with self.subTest(value=value):
                with self.assertRaises(invalid_request):
                    normalize_login_url(value)

    def test_allowlist_requires_an_exact_hostname_unless_explicitly_enabled(self):
        login_policy = required_attribute(self, BROKER, "LoginPolicy")
        policy = login_policy.from_file(
            self.write_policy(
                [
                    {"hostname": "example.test", "credential_item_id": "item-1"},
                    {"hostname": "allowed.test", "include_subdomains": True, "credential_item_id": "item-2"},
                ]
            )
        )

        self.assertIsNotNone(policy.match("example.test"))
        self.assertIsNone(policy.match("www.example.test"))
        self.assertIsNotNone(policy.match("login.allowed.test"))
        self.assertIsNone(policy.match("allowed.test.attacker.test"))

    def test_nonempty_allowlist_entries_require_only_an_item_id(self):
        login_policy = required_attribute(self, BROKER, "LoginPolicy")
        with self.assertRaises(ValueError):
            login_policy.from_file(
                self.write_policy([{"hostname": "example.test"}])
            )

        policy = login_policy.from_file(
            self.write_policy(
                [{"hostname": "example.test", "credential_item_id": "vault-item-1"}]
            )
        )
        entry = policy.match("example.test")
        self.assertEqual(entry.credential_item_id, "vault-item-1")

    def test_expired_request_cannot_be_used(self):
        now = [1_000.0]
        pending_store = required_attribute(self, BROKER, "PendingLoginStore")
        invalid_request = required_attribute(self, BROKER, "InvalidLoginRequest")
        store = pending_store(clock=lambda: now[0])
        request = store.create("example.test", "https://example.test/login")
        now[0] += 121

        self.assertEqual(store.status(request.request_id).status, "expired")
        with self.assertRaises(invalid_request):
            store.approve(request.request_id)

    def test_request_can_be_denied_only_once(self):
        pending_store = required_attribute(self, BROKER, "PendingLoginStore")
        invalid_request = required_attribute(self, BROKER, "InvalidLoginRequest")
        store = pending_store(clock=lambda: 1_000.0)
        request = store.create("example.test", "https://example.test/login")

        self.assertEqual(store.deny(request.request_id).status, "denied")
        with self.assertRaises(invalid_request):
            store.deny(request.request_id)

    def test_login_request_response_is_redacted(self):
        login_policy = required_attribute(self, BROKER, "LoginPolicy")
        pending_store = required_attribute(self, BROKER, "PendingLoginStore")
        policy = login_policy.from_file(
            self.write_policy(
                [{"hostname": "example.test", "credential_item_id": "vault-item-1"}]
            )
        )
        previous_policy = BROKER.LOGIN_POLICY
        previous_store = BROKER.PENDING_LOGINS
        self.addCleanup(setattr, BROKER, "LOGIN_POLICY", previous_policy)
        self.addCleanup(setattr, BROKER, "PENDING_LOGINS", previous_store)
        BROKER.LOGIN_POLICY = policy
        BROKER.PENDING_LOGINS = pending_store(clock=lambda: 1_000.0)

        response = BROKER.execute(
            "login_request",
            "https://example.test/login?private=value",
        )
        rendered = json.dumps(response)
        self.assertEqual(response["hostname"], "example.test")
        self.assertEqual(response["status"], "pending")
        self.assertNotIn("private=value", rendered)
        self.assertNotIn("private=value", rendered)

    def test_terminal_result_is_retained_by_status(self):
        store = BROKER.PendingLoginStore(clock=lambda: 1_000.0)
        request = store.create("example.test", "https://example.test/login")
        store.approve(request.request_id)
        store.complete(request.request_id, "submitted")

        terminal = store.status(request.request_id)
        self.assertEqual(terminal.status, "completed")
        self.assertEqual(terminal.outcome, "submitted")

    def test_approved_login_is_resolved_once_by_the_credential_provider(self):
        policy = BROKER.LoginPolicy.from_file(
            self.write_policy(
                [{"hostname": "example.test", "credential_item_id": "vault-item-1"}]
            )
        )
        store = BROKER.PendingLoginStore(clock=lambda: 1_000.0)
        request = store.create("example.test", "https://example.test/login")
        store.approve(request.request_id)
        previous_policy, previous_store = BROKER.LOGIN_POLICY, BROKER.PENDING_LOGINS
        self.addCleanup(setattr, BROKER, "LOGIN_POLICY", previous_policy)
        self.addCleanup(setattr, BROKER, "PENDING_LOGINS", previous_store)
        BROKER.LOGIN_POLICY, BROKER.PENDING_LOGINS = policy, store
        item = {
            "id": "vault-item-1",
            "login": {
                "username": "andrii@example.test",
                "password": "secret",
                "uris": [{"uri": "https://example.test/login"}],
            },
        }
        with mock.patch.object(BROKER, "run_bw", return_value=json.dumps(item)) as run_bw:
            result = BROKER.execute("credential_resolve", request.request_id)

        run_bw.assert_called_once_with("get", "item", "vault-item-1")
        self.assertEqual(
            result,
            {
                "username": "andrii@example.test",
                "password": "secret",
                "url": "https://example.test/login",
            },
        )
        self.assertEqual(store.status(request.request_id).status, "consumed")
        with self.assertRaises(BROKER.InvalidLoginRequest):
            BROKER.execute("credential_resolve", request.request_id)

    def test_credential_resolve_uses_only_the_runner_broker_token(self):
        self.assertTrue(
            BROKER.is_authorized(
                "credential_resolve", "Bearer runner-token", "media-token", "runner-token"
            )
        )

        self.assertFalse(
            BROKER.is_authorized(
                "credential_resolve", "Bearer media-token", "media-token", "runner-token"
            )
        )

    def test_browser_credential_resolve_uses_only_the_broker_api_token(self):
        self.assertTrue(
            BROKER.is_authorized(
                "browser_credential_resolve",
                "Bearer media-token",
                "media-token",
                "runner-token",
            )
        )
        self.assertFalse(
            BROKER.is_authorized(
                "browser_credential_resolve",
                "Bearer runner-token",
                "media-token",
                "runner-token",
            )
        )

    def test_runner_and_browser_resolvers_share_one_shot_consumption(self):
        policy = BROKER.LoginPolicy.from_file(
            self.write_policy(
                [{"hostname": "example.test", "credential_item_id": "vault-item-1"}]
            )
        )
        store = BROKER.PendingLoginStore(clock=lambda: 1_000.0)
        request = store.create("example.test", "https://example.test/login")
        store.approve(request.request_id)
        previous_policy, previous_store = BROKER.LOGIN_POLICY, BROKER.PENDING_LOGINS
        self.addCleanup(setattr, BROKER, "LOGIN_POLICY", previous_policy)
        self.addCleanup(setattr, BROKER, "PENDING_LOGINS", previous_store)
        BROKER.LOGIN_POLICY, BROKER.PENDING_LOGINS = policy, store
        item = {
            "id": "vault-item-1",
            "login": {
                "username": "andrii@example.test",
                "password": "secret",
                "uris": [{"uri": "https://example.test/login"}],
            },
        }

        with mock.patch.object(BROKER, "run_bw", return_value=json.dumps(item)):
            BROKER.execute("browser_credential_resolve", request.request_id)
            with self.assertRaises(BROKER.InvalidLoginRequest):
                BROKER.execute("credential_resolve", request.request_id)

    def test_credential_response_rejects_oversized_values_and_consumes_request(self):
        policy = BROKER.LoginPolicy.from_file(
            self.write_policy(
                [{"hostname": "example.test", "credential_item_id": "vault-item-1"}]
            )
        )
        store = BROKER.PendingLoginStore(clock=lambda: 1_000.0)
        request = store.create("example.test", "https://example.test/login")
        store.approve(request.request_id)
        previous_policy, previous_store = BROKER.LOGIN_POLICY, BROKER.PENDING_LOGINS
        self.addCleanup(setattr, BROKER, "LOGIN_POLICY", previous_policy)
        self.addCleanup(setattr, BROKER, "PENDING_LOGINS", previous_store)
        BROKER.LOGIN_POLICY, BROKER.PENDING_LOGINS = policy, store
        item = {
            "id": "vault-item-1",
            "login": {
                "username": "u" * 513,
                "password": "secret",
                "uris": [{"uri": "https://example.test/login"}],
            },
        }

        with mock.patch.object(BROKER, "run_bw", return_value=json.dumps(item)):
            with self.assertRaises(BROKER.InvalidLoginRequest):
                BROKER.execute("credential_resolve", request.request_id)

        self.assertEqual(store.status(request.request_id).status, "failed")
        self.assertFalse(
            BROKER.is_authorized(
                "credential_resolve", "Bearer media-token", "media-token", "runner-token"
            )
        )

    def test_safe_operations_use_only_the_broker_api_token(self):
        for command in ("login_request", "login_status", "login_approve", "login_deny"):
            with self.subTest(command=command):
                self.assertTrue(
                    BROKER.is_authorized(
                        command, "Bearer media-token", "media-token", "runner-token"
                    )
                )
                self.assertFalse(
                    BROKER.is_authorized(
                        command, "Bearer runner-token", "media-token", "runner-token"
                    )
                )

    def test_approval_only_changes_state_and_never_drives_the_browser(self):
        policy = BROKER.LoginPolicy.from_file(
            self.write_policy(
                [{"hostname": "example.test", "credential_item_id": "vault-item-1"}]
            )
        )
        store = BROKER.PendingLoginStore(clock=lambda: 1_000.0)
        request = store.create("example.test", "https://example.test/login")
        previous_policy, previous_store = BROKER.LOGIN_POLICY, BROKER.PENDING_LOGINS
        self.addCleanup(setattr, BROKER, "LOGIN_POLICY", previous_policy)
        self.addCleanup(setattr, BROKER, "PENDING_LOGINS", previous_store)
        BROKER.LOGIN_POLICY, BROKER.PENDING_LOGINS = policy, store

        result = BROKER.execute("login_approve", request.request_id)

        self.assertEqual(result["status"], "approved")
        self.assertEqual(store.status(request.request_id).status, "approved")

    def test_audit_log_is_redacted_json_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "audit.jsonl"
            audit = BROKER.AuditLogger(path, clock=lambda: 1_000.0)
            audit.write("login_requested", request_id="request-1", hostname="example.test")
            rendered = path.read_text(encoding="utf-8")
            event = json.loads(rendered)
            self.assertEqual(event["event"], "login_requested")
            self.assertEqual(event["request_id"], "request-1")
            self.assertNotIn("url", event)
            self.assertNotIn("password", rendered.lower())

if __name__ == "__main__":
    unittest.main()
