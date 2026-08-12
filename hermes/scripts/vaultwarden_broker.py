#!/usr/bin/env python3
import dataclasses
import ipaddress
import hmac
import json
import os
import pathlib
import re
import secrets
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from time import time
from urllib.parse import urlsplit, urlunsplit

BW = os.environ.get("BW_PATH", "/opt/tools/bw")
SERVER_FILE = pathlib.Path("/etc/hermes-home/vaultwarden-server")
SESSION_FILE = pathlib.Path("/run/secrets/vaultwarden_session")
BROKER_TOKEN_FILE = pathlib.Path("/run/secrets/broker_api_token")
RUNNER_TOKEN_FILE = pathlib.Path("/run/secrets/rezka_broker_token")
APPDATA = "/opt/data/vaultwarden"
AUDIT_FILE = pathlib.Path(APPDATA) / "audit.jsonl"
ALLOWLIST_FILE = pathlib.Path("/etc/hermes-home/vaultwarden-login-allowlist.json")
BW_LOCK = threading.Lock()
HOSTNAME_PATTERN = re.compile(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*\Z")
SESSION_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
LOGIN_TTL_SECONDS = 120
MAX_USERNAME_LENGTH = 512
MAX_PASSWORD_LENGTH = 4096
MAX_CREDENTIAL_URL_LENGTH = 2048


class InvalidCommand(Exception):
    pass


class InvalidLoginRequest(InvalidCommand):
    pass


@dataclasses.dataclass(frozen=True)
class LoginTarget:
    url: str
    hostname: str
    origin: str


@dataclasses.dataclass(frozen=True)
class AllowlistEntry:
    hostname: str
    include_subdomains: bool
    credential_item_id: str


@dataclasses.dataclass
class PendingLoginRequest:
    request_id: str
    hostname: str
    url: str
    expires_at: float
    status: str = "pending"
    outcome: str | None = None


class AuditLogger:
    ALLOWED_FIELDS = {"request_id", "hostname", "status", "outcome"}

    def __init__(self, path=AUDIT_FILE, clock=time):
        self.path = pathlib.Path(path)
        self.clock = clock
        self.lock = threading.Lock()

    def write(self, event, **fields):
        record = {"timestamp": int(self.clock()), "event": str(event)}
        record.update({key: value for key, value in fields.items() if key in self.ALLOWED_FIELDS})
        line = json.dumps(record, separators=(",", ":"), sort_keys=True)
        with self.lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as stream:
                stream.write(line + "\n")


def normalize_hostname(value):
    if not isinstance(value, str) or not value:
        raise InvalidLoginRequest("invalid hostname")
    try:
        ipaddress.ip_address(value)
    except ValueError:
        pass
    else:
        raise InvalidLoginRequest("IP addresses are not allowed")
    try:
        hostname = value.rstrip(".").encode("idna").decode("ascii").lower()
    except UnicodeError as error:
        raise InvalidLoginRequest("invalid hostname") from error
    if not HOSTNAME_PATTERN.fullmatch(hostname):
        raise InvalidLoginRequest("invalid hostname")
    return hostname


def normalize_login_url(value):
    if not isinstance(value, str):
        raise InvalidLoginRequest("invalid URL")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise InvalidLoginRequest("invalid URL") from error
    if parsed.scheme.lower() != "https" or not parsed.netloc:
        raise InvalidLoginRequest("only HTTPS URLs are allowed")
    if parsed.username or parsed.password or port not in (None, 443):
        raise InvalidLoginRequest("invalid URL")
    hostname = normalize_hostname(parsed.hostname)
    normalized_url = urlunsplit(
        ("https", hostname, parsed.path or "/", parsed.query, "")
    )
    return LoginTarget(
        url=normalized_url,
        hostname=hostname,
        origin=f"https://{hostname}",
    )


class LoginPolicy:
    def __init__(self, entries):
        self.entries = tuple(entries)

    @classmethod
    def from_file(cls, path):
        try:
            raw = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError("invalid Vaultwarden login allowlist") from error
        domains = raw.get("domains") if isinstance(raw, dict) else None
        if not isinstance(domains, list):
            raise ValueError("invalid Vaultwarden login allowlist")
        entries = []
        for domain in domains:
            if not isinstance(domain, dict):
                raise ValueError("invalid Vaultwarden login allowlist")
            hostname = normalize_hostname(domain.get("hostname"))
            include_subdomains = domain.get("include_subdomains", False)
            item_id = domain.get("credential_item_id")
            if (
                not isinstance(include_subdomains, bool)
                or not isinstance(item_id, str)
                or not item_id
            ):
                raise ValueError("invalid Vaultwarden login allowlist")
            entries.append(
                AllowlistEntry(
                    hostname,
                    include_subdomains,
                    item_id,
                )
            )
        return cls(entries)

    def match(self, hostname):
        for entry in self.entries:
            if hostname == entry.hostname or (
                entry.include_subdomains and hostname.endswith(f".{entry.hostname}")
            ):
                return entry
        return None


class PendingLoginStore:
    def __init__(self, clock=time):
        self.clock = clock
        self.lock = threading.Lock()
        self.requests = {}

    def _get(self, request_id):
        if not isinstance(request_id, str):
            raise InvalidLoginRequest("unknown login request")
        request = self.requests.get(request_id)
        if request is None:
            raise InvalidLoginRequest("unknown login request")
        if request.status in {"pending", "approved"} and self.clock() >= request.expires_at:
            request.status = "expired"
        return request

    def create(self, hostname, url):
        with self.lock:
            request = PendingLoginRequest(
                request_id=secrets.token_urlsafe(18),
                hostname=hostname,
                url=url,
                expires_at=self.clock() + LOGIN_TTL_SECONDS,
            )
            self.requests[request.request_id] = request
            return dataclasses.replace(request)

    def status(self, request_id):
        with self.lock:
            return dataclasses.replace(self._get(request_id))

    def deny(self, request_id):
        with self.lock:
            request = self._get(request_id)
            if request.status != "pending":
                raise InvalidLoginRequest("login request is not pending")
            request.status = "denied"
            return dataclasses.replace(request)

    def approve(self, request_id):
        with self.lock:
            request = self._get(request_id)
            if request.status != "pending":
                raise InvalidLoginRequest("login request is not pending")
            request.status = "approved"
            return dataclasses.replace(request)

    def consume_approved(self, request_id):
        with self.lock:
            request = self._get(request_id)
            if request.status != "approved":
                raise InvalidLoginRequest("login request is not approved")
            request.status = "consumed"
            return dataclasses.replace(request)

    def complete(self, request_id, outcome):
        with self.lock:
            request = self._get(request_id)
            if request.status not in {"approved", "consumed"}:
                raise InvalidLoginRequest("login request is not active")
            request.status = "completed"
            request.outcome = outcome
            return dataclasses.replace(request)

    def fail(self, request_id):
        with self.lock:
            request = self._get(request_id)
            request.status = "failed"
            request.outcome = "failed"
            return dataclasses.replace(request)


def redact_login_request(request):
    result = {
        "request_id": request.request_id,
        "hostname": request.hostname,
        "status": request.status,
        "expires_at": int(request.expires_at),
    }
    if request.outcome is not None:
        result["outcome"] = request.outcome
    return result


def sanitize_item(item):
    login = item.get("login") or {}
    return {
        "id": item.get("id"),
        "name": item.get("name"),
        "username": login.get("username"),
        "uris": [entry.get("uri") for entry in login.get("uris", [])[:5]],
    }


def exact_login_credentials(item, hostname, credential_item_id):
    if not isinstance(item, dict) or item.get("id") != credential_item_id:
        raise InvalidLoginRequest("credential selection failed")
    login = item.get("login")
    if not isinstance(login, dict):
        raise InvalidLoginRequest("credential selection failed")
    try:
        matches_hostname = any(
            isinstance(uri, dict)
            and normalize_login_url(uri.get("uri")).hostname == hostname
            for uri in login.get("uris", [])
        )
    except InvalidLoginRequest:
        matches_hostname = False
    username = login.get("username")
    password = login.get("password")
    if (
        not matches_hostname
        or not isinstance(username, str)
        or not username
        or len(username) > MAX_USERNAME_LENGTH
        or not isinstance(password, str)
        or not password
        or len(password) > MAX_PASSWORD_LENGTH
    ):
        raise InvalidLoginRequest("credential selection failed")
    return username, password


def run_bw(*arguments):
    server = SERVER_FILE.read_text(encoding="utf-8").strip()
    session = os.environ.get("BW_SESSION", "").strip()
    if not session:
        session = SESSION_FILE.read_text(encoding="utf-8").strip()
    environment = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": APPDATA,
        "BITWARDENCLI_APPDATA_DIR": APPDATA,
        "BW_SESSION": session,
    }
    with BW_LOCK:
        status_result = subprocess.run(
            [BW, "status", "--session", session],
            env=environment,
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
        status = json.loads(status_result.stdout)
        if status.get("serverUrl", "").rstrip("/") != server.rstrip("/"):
            raise subprocess.SubprocessError("Vaultwarden server mismatch")
        result = subprocess.run(
            [BW, *arguments, "--session", session],
            env=environment,
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
    return result.stdout


LOGIN_POLICY = (
    LoginPolicy.from_file(ALLOWLIST_FILE)
    if ALLOWLIST_FILE.is_file()
    else LoginPolicy(())
)
PENDING_LOGINS = PendingLoginStore()
AUDIT = AuditLogger()


def resolve_approved_credential(request_id):
    request = PENDING_LOGINS.consume_approved(request_id)
    entry = LOGIN_POLICY.match(request.hostname)
    if entry is None:
        raise InvalidLoginRequest("login request is no longer allowed")

    item = None
    username = None
    password = None
    try:
        if len(request.url) > MAX_CREDENTIAL_URL_LENGTH:
            raise InvalidLoginRequest("credential resolution failed")
        item = json.loads(run_bw("get", "item", entry.credential_item_id))
        username, password = exact_login_credentials(
            item, request.hostname, entry.credential_item_id
        )
        AUDIT.write(
            "credential_issued",
            request_id=request_id,
            hostname=request.hostname,
            status="consumed",
        )
        return {"username": username, "password": password, "url": request.url}
    except Exception as error:
        PENDING_LOGINS.fail(request_id)
        AUDIT.write(
            "credential_failed", request_id=request_id, hostname=request.hostname, status="failed"
        )
        if isinstance(error, InvalidCommand):
            raise
        raise InvalidLoginRequest("credential resolution failed") from error
    finally:
        if isinstance(item, dict):
            login = item.get("login")
            if isinstance(login, dict):
                login["username"] = ""
                login["password"] = ""
        username = None
        password = None


def execute(command, argument):
    if command == "status":
        value = json.loads(run_bw("status"))
        return {
            "status": value.get("status"),
            "serverUrl": value.get("serverUrl"),
            "userEmail": value.get("userEmail"),
        }
    if command == "sync":
        run_bw("sync")
        return {"status": "synced"}
    if command == "search" and isinstance(argument, str) and argument:
        values = json.loads(run_bw("list", "items", "--search", argument))
        return [sanitize_item(item) for item in values[:5]]
    if command in {"username", "uris"} and isinstance(argument, str) and argument:
        if argument.startswith("-"):
            raise InvalidCommand("argument must not look like a flag")
        item = sanitize_item(json.loads(run_bw("get", "item", argument)))
        return {command: item[command]}
    if command == "login_request" and isinstance(argument, str):
        target = normalize_login_url(argument)
        if LOGIN_POLICY.match(target.hostname) is None:
            raise InvalidLoginRequest("hostname is not allowed")
        request = PENDING_LOGINS.create(target.hostname, target.url)
        AUDIT.write(
            "login_requested",
            request_id=request.request_id,
            hostname=request.hostname,
            status=request.status,
        )
        return redact_login_request(request)
    if command == "login_status" and isinstance(argument, str):
        return redact_login_request(PENDING_LOGINS.status(argument))
    if command == "login_deny" and isinstance(argument, str):
        request = PENDING_LOGINS.deny(argument)
        AUDIT.write(
            "login_denied",
            request_id=request.request_id,
            hostname=request.hostname,
            status=request.status,
        )
        return redact_login_request(request)
    if command == "login_approve" and isinstance(argument, str):
        request = PENDING_LOGINS.approve(argument)
        AUDIT.write(
            "login_approved",
            request_id=request.request_id,
            hostname=request.hostname,
            status=request.status,
        )
        return redact_login_request(request)
    if command in {"credential_resolve", "browser_credential_resolve"} and isinstance(argument, str):
        return resolve_approved_credential(argument)
    raise InvalidCommand("unsupported command")


def is_authorized(command, supplied, broker_token, runner_token):
    expected = runner_token if command == "credential_resolve" else broker_token
    return bool(expected) and hmac.compare_digest(supplied, f"Bearer {expected}")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format, *_arguments):
        return

    def send_json(self, status, value):
        body = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"status": "ok"})
        else:
            self.send_json(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/v1/command":
            self.send_json(404, {"error": "not_found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 2 or length > 4096:
                raise ValueError("invalid body size")
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("body must be an object")
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": "invalid_request"})
            return
        broker_token = BROKER_TOKEN_FILE.read_text(encoding="utf-8").strip()
        runner_token = RUNNER_TOKEN_FILE.read_text(encoding="utf-8").strip()
        if not is_authorized(
            payload.get("command"),
            self.headers.get("Authorization", ""),
            broker_token,
            runner_token,
        ):
            self.send_json(401, {"error": "unauthorized"})
            return
        try:
            result = execute(payload.get("command"), payload.get("argument"))
        except InvalidCommand:
            self.send_json(400, {"error": "invalid_request"})
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            self.send_json(502, {"error": "vault_operation_failed"})
        else:
            self.send_json(200, result)


if __name__ == "__main__":
    os.umask(0o077)
    if not os.environ.get("BW_SESSION", "").strip() and (
        not SESSION_FILE.is_file() or not SESSION_FILE.read_text(encoding="utf-8").strip()
    ):
        raise SystemExit("Vaultwarden session secret is missing")
    for token_file in (BROKER_TOKEN_FILE, RUNNER_TOKEN_FILE):
        if not token_file.is_file() or not token_file.read_text(encoding="utf-8").strip():
            raise SystemExit("Vaultwarden broker token is missing")
    ThreadingHTTPServer(("0.0.0.0", 8787), Handler).serve_forever()
