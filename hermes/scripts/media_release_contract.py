#!/usr/bin/env python3
"""Load and validate a Media Orchestrator release bundle."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import pathlib
import re


SHA256 = re.compile(r"^[0-9a-f]{64}$")
REVISION = re.compile(r"^[0-9a-f]{40}$")
MIGRATION = re.compile(r"^m[0-9]{8}_[0-9]{6}_[a-z0-9_]+$")
PATH_COMPONENT = re.compile(r"^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$")
DOMAIN_COMPONENT = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$")
TAG = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")
ARTIFACTS = (
    "MCP_SCHEMA.json",
    "media-capabilities.json",
    "media-linux-amd64.sha256",
)
CAPABILITY_FIELDS = {"description", "mcp_server", "schema_version", "tools"}
RELEASE_FIELDS = {
    "application_version",
    "files",
    "migration_version",
    "runner_build_digest",
    "runner_image",
    "schema_version",
    "service_image",
    "source_revision",
    "source_tree_digest",
}


class ContractError(ValueError):
    """The release directory does not satisfy schema version 1."""


def _load_json(path: pathlib.Path, label: str) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ContractError(f"{label} is missing or invalid: {path}") from error


def _sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise ContractError(f"release artifact is missing or unreadable: {path}") from error
    return digest.hexdigest()


def _valid_registry(value: str) -> bool:
    if value.startswith("["):
        match = re.fullmatch(r"\[([0-9A-Fa-f:.]+)\](?::([0-9]+))?", value)
        if match is None:
            return False
        try:
            ipaddress.IPv6Address(match.group(1))
        except ipaddress.AddressValueError:
            return False
        return match.group(2) is None or 1 <= int(match.group(2)) <= 65535
    host, separator, port = value.rpartition(":")
    if separator:
        if not port.isdigit() or not 1 <= int(port) <= 65535:
            return False
    else:
        host = value
    return bool(host) and all(
        DOMAIN_COMPONENT.fullmatch(component) for component in host.split(".")
    )


def _valid_immutable_image(value: object) -> bool:
    if not isinstance(value, str) or value.count("@sha256:") != 1:
        return False
    repository, digest = value.split("@sha256:")
    if SHA256.fullmatch(digest) is None:
        return False
    repository_path, separator, tag = repository.rpartition(":")
    if separator and len(repository_path) > repository.rfind("/"):
        if TAG.fullmatch(tag) is None:
            return False
        repository = repository_path
    if not repository or len(repository) > 255:
        return False
    components = repository.split("/")
    if any(not component for component in components):
        return False
    first = components[0]
    has_registry = len(components) > 1 and (
        first == "localhost" or "." in first or ":" in first or first.startswith("[")
    )
    path = components[1:] if has_registry else components
    return (
        (not has_registry or _valid_registry(first))
        and bool(path)
        and all(PATH_COMPONENT.fullmatch(component) for component in path)
    )


def _tool_names(schema: object, capabilities: object) -> tuple[list[str], list[str]]:
    if not isinstance(schema, dict) or set(schema) != {"schema_version", "source_digest", "tools"}:
        raise ContractError("MCP schema must use the schema-version-1 object shape")
    if schema["schema_version"] != 1 or isinstance(schema["schema_version"], bool):
        raise ContractError("MCP schema must use schema version 1")
    if not isinstance(schema["source_digest"], str) or SHA256.fullmatch(schema["source_digest"]) is None:
        raise ContractError("MCP schema source digest is invalid")
    tools = schema["tools"]
    if not isinstance(tools, list) or not tools or not all(isinstance(tool, dict) for tool in tools):
        raise ContractError("MCP schema tools must be a non-empty object array")
    schema_names = [tool.get("name") for tool in tools]
    if not all(isinstance(name, str) and name for name in schema_names):
        raise ContractError("MCP schema contains an invalid tool name")

    if not isinstance(capabilities, dict) or set(capabilities) != CAPABILITY_FIELDS:
        raise ContractError("media capability manifest must use the exact schema-version-1 object shape")
    if capabilities["schema_version"] != 1 or isinstance(capabilities["schema_version"], bool):
        raise ContractError("media capability manifest must use schema version 1")
    if capabilities["mcp_server"] != "media_admin":
        raise ContractError("media capability manifest must target media_admin")
    if not isinstance(capabilities["description"], str) or not capabilities["description"]:
        raise ContractError("media capability manifest description is missing or invalid")
    capability_names = capabilities.get("tools")
    if not isinstance(capability_names, list) or not capability_names or not all(
        isinstance(name, str) and name for name in capability_names
    ):
        raise ContractError("media capability manifest tools must be a non-empty string array")
    if len(schema_names) != len(set(schema_names)) or len(capability_names) != len(set(capability_names)):
        raise ContractError("MCP schema and capability tool names must be unique")
    return schema_names, capability_names


def load_release_contract(path: pathlib.Path) -> dict:
    """Return a validated schema-version-1 release object from *path*."""
    release_dir = pathlib.Path(path)
    release = _load_json(release_dir / "release.json", "release manifest")
    if not isinstance(release, dict) or set(release) != RELEASE_FIELDS:
        raise ContractError("release manifest fields are missing or unsupported")
    if release["schema_version"] != 1 or isinstance(release["schema_version"], bool):
        raise ContractError("release manifest must use schema version 1")
    if not isinstance(release["application_version"], str) or not release["application_version"]:
        raise ContractError("application version is missing or invalid")
    if not isinstance(release["source_revision"], str) or REVISION.fullmatch(release["source_revision"]) is None:
        raise ContractError("source revision is missing or invalid")
    for field in ("source_tree_digest", "runner_build_digest"):
        value = release[field]
        if not isinstance(value, str) or SHA256.fullmatch(value) is None:
            raise ContractError(f"{field.replace('_', ' ')} is missing or invalid")
    if not isinstance(release["migration_version"], str) or MIGRATION.fullmatch(release["migration_version"]) is None:
        raise ContractError("migration version is missing or invalid")
    for field in ("service_image", "runner_image"):
        if not _valid_immutable_image(release[field]):
            raise ContractError(f"{field.replace('_', ' ')} must be an immutable name@sha256 reference")

    files = release["files"]
    if not isinstance(files, dict) or set(files) != set(ARTIFACTS):
        raise ContractError("release file metadata is missing or unsupported")
    for name in ARTIFACTS:
        metadata = files[name]
        if not isinstance(metadata, dict) or set(metadata) != {"sha256"}:
            raise ContractError(f"release file metadata is invalid: {name}")
        expected = metadata["sha256"]
        if not isinstance(expected, str) or SHA256.fullmatch(expected) is None:
            raise ContractError(f"release file hash is invalid: {name}")
        if _sha256(release_dir / name) != expected:
            raise ContractError(f"release artifact hash differs: {name}")

    schema = _load_json(release_dir / "MCP_SCHEMA.json", "MCP schema")
    capabilities = _load_json(release_dir / "media-capabilities.json", "capability manifest")
    schema_names, capability_names = _tool_names(schema, capabilities)
    if schema_names != capability_names:
        raise ContractError("MCP schema and capability tool names differ")
    if schema["source_digest"] != release["source_tree_digest"]:
        raise ContractError("MCP schema source digest differs from the release manifest")

    try:
        checksum = (release_dir / "media-linux-amd64.sha256").read_text(encoding="ascii").strip()
    except (OSError, UnicodeError) as error:
        raise ContractError("CLI checksum is missing or invalid") from error
    parts = checksum.split()
    if len(parts) != 2 or SHA256.fullmatch(parts[0]) is None or parts[1].lstrip("*") != "media-linux-amd64":
        raise ContractError("CLI checksum is missing or invalid")

    release["cli_sha256"] = parts[0]
    return release


def validate_staged_cli(path: pathlib.Path, expected_sha256: str) -> None:
    """Fail unless a staged CLI regular file matches the authenticated checksum."""
    candidate = pathlib.Path(path)
    if not candidate.is_file():
        raise ContractError(f"staged media CLI is missing or is not a regular file: {candidate}")
    if _sha256(candidate) != expected_sha256:
        raise ContractError("staged media CLI checksum differs from the release bundle")
