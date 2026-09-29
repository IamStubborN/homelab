#!/usr/bin/env python3
"""Attest an existing local Docker build without inventing registry digests."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess

from media_release_contract import ContractError, REVISION, SHA256

ROOT = pathlib.Path(__file__).resolve().parents[1]
SERVICES = ("media-service", "download-runner")
PROFILES = ("hermes-primary", "hermes-secondary")
PROVENANCE_FIELDS = {"revision", "source_tree_digest", "runner_build_digest"}
LABELS = {
    "revision": "org.opencontainers.image.revision",
    "version": "org.opencontainers.image.version",
    "source_tree_digest": "dev.iamstubborn.media.source-tree-digest",
    "runner_build_digest": "dev.iamstubborn.media.runner-build-digest",
}


def canonical_tools(tools):
    if not isinstance(tools, list) or not tools or not all(
        isinstance(t, dict) and isinstance(t.get("name"), str) and t["name"] for t in tools
    ):
        raise ContractError("local runtime tools must be a nonempty named object array")
    if len({t["name"] for t in tools}) != len(tools):
        raise ContractError("duplicate local runtime tool names")
    return sorted(tools, key=lambda t: t["name"])


def schema_tools(schema):
    if not isinstance(schema, dict) or set(schema) != {"schema_version", "source_digest", "tools"}:
        raise ContractError("invalid tracked/mounted MCP schema fields")
    if type(schema["schema_version"]) is not int or schema["schema_version"] != 1:
        raise ContractError("invalid tracked/mounted MCP schema version")
    if not isinstance(schema["source_digest"], str) or not SHA256.fullmatch(schema["source_digest"]):
        raise ContractError("invalid tracked/mounted MCP source digest")
    # The catalog may predate this build when its complete tool contract is
    # unchanged. Runtime source provenance is attested independently above.
    return canonical_tools(schema["tools"])


def validate_shape(receipt):
    fields = {"kind", "schema_version", "provenance", "images", "cli_sha256", "tools"}
    if not isinstance(receipt, dict) or set(receipt) != fields:
        raise ContractError("local runtime receipt fields are missing or unsupported")
    if receipt["kind"] != "local-runtime" or type(receipt["schema_version"]) is not int or receipt["schema_version"] != 1:
        raise ContractError("invalid local runtime receipt kind/version")
    provenance = receipt["provenance"]
    if not isinstance(provenance, dict) or set(provenance) != PROVENANCE_FIELDS:
        raise ContractError("invalid local source provenance fields")
    for field in PROVENANCE_FIELDS:
        pattern = REVISION if field == "revision" else SHA256
        if not isinstance(provenance[field], str) or not pattern.fullmatch(provenance[field]):
            raise ContractError("invalid local source provenance value")
    images = receipt["images"]
    if not isinstance(images, dict) or set(images) != set(SERVICES):
        raise ContractError("both local runtime images are required")
    for image in images.values():
        if not isinstance(image, dict) or set(image) != PROVENANCE_FIELDS | {"image", "version"}:
            raise ContractError("invalid local image attestation fields")
        if not isinstance(image["image"], str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image["image"]):
            raise ContractError("local image must use an immutable Docker image ID")
        if not isinstance(image["version"], str) or not image["version"] or "example" in image["version"].lower():
            raise ContractError("invalid local application version")
        if any(image[field] != provenance[field] for field in PROVENANCE_FIELDS):
            raise ContractError("local image differs from verified source provenance")
    if not isinstance(receipt["cli_sha256"], str) or not SHA256.fullmatch(receipt["cli_sha256"]):
        raise ContractError("invalid local CLI checksum")
    canonical_tools(receipt["tools"])


def validate(receipt, actual, tracked_tools, staged_cli_sha256):
    for value in (receipt, actual):
        validate_shape(value)
    expected = {**receipt, "tools": canonical_tools(receipt["tools"])}
    observed = {**actual, "tools": canonical_tools(actual["tools"])}
    if expected != observed:
        raise ContractError("live local runtime differs from its receipt")
    if expected["tools"] != canonical_tools(tracked_tools):
        raise ContractError("live local MCP contract differs from tracked tools")
    if receipt["cli_sha256"] != staged_cli_sha256:
        raise ContractError("staged CLI differs from the local runtime image")


def run(*args, env=None):
    return subprocess.check_output(args, text=True, env=env, timeout=60).strip()


def image_attestation(name):
    container = json.loads(run("docker", "inspect", name))[0]
    image_id = container["Image"]
    if container["Config"]["Image"] != image_id:
        raise ContractError(f"{name} must already be pinned to its local image ID")
    image = json.loads(run("docker", "image", "inspect", image_id))[0]
    if image["Id"] != image_id or not container["State"]["Running"] or container["State"].get("Health", {}).get("Status") != "healthy":
        raise ContractError(f"{name} immutable image or running state differs")
    image_labels = image["Config"].get("Labels") or {}
    container_labels = container["Config"].get("Labels") or {}
    labels = {key: image_labels.get(label) for key, label in LABELS.items()}
    if labels != {key: container_labels.get(label) for key, label in LABELS.items()}:
        raise ContractError(f"{name} container labels differ from its image")
    return {"image": image_id, **labels}


MCP_PROBE = '''
import json, pathlib, urllib.request
token=pathlib.Path('/run/secrets/media_api_token').read_text().strip()
headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','Accept':'application/json, text/event-stream'}
def call(payload, protocol=None):
    request_headers=dict(headers)
    if protocol: request_headers['MCP-Protocol-Version']=protocol
    request=urllib.request.Request('http://media-service:8080/internal/mcp',data=json.dumps(payload).encode(),headers=request_headers,method='POST')
    with urllib.request.urlopen(request,timeout=15) as response: return json.loads(response.read())
call({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'local-preflight','version':'1'}}})
print(json.dumps(call({'jsonrpc':'2.0','id':2,'method':'tools/list'},'2025-03-26')['result']['tools']))
'''


def collect(provenance):
    images = {name: image_attestation(name) for name in SERVICES}
    checksums = {run("docker", "exec", name, "sha256sum", "/usr/local/bin/media").split()[0] for name in SERVICES}
    if len(checksums) != 1:
        raise ContractError("service and runner embedded CLI checksums differ")
    tools = canonical_tools(json.loads(run("docker", "exec", PROFILES[0], "python3", "-c", MCP_PROBE)))
    tracked = json.loads((ROOT / "shared/skills/media/MCP_SCHEMA.json").read_text())
    if schema_tools(tracked) != tools:
        raise ContractError("live local MCP contract differs from tracked tools")
    for profile in PROFILES:
        mounted = json.loads(run("docker", "exec", profile, "cat", "/etc/hermes-home/skills/media/MCP_SCHEMA.json"))
        if schema_tools(mounted) != tools or mounted != tracked:
            raise ContractError(f"{profile} mounted MCP contract differs from live tools")
    return {"kind": "local-runtime", "schema_version": 1, "provenance": provenance,
            "images": images, "cli_sha256": checksums.pop(), "tools": tools}


def source_provenance(source_root, revision):
    if not REVISION.fullmatch(revision):
        raise ContractError("source revision must be a full Git commit")
    env = {**os.environ, "OCI_REVISION": revision, "OCI_CREATED": "local-attestation", "OCI_SOURCE": "local-attestation"}
    script = source_root / "scripts/docker-build.sh"
    return {"revision": revision,
            "source_tree_digest": run("sh", str(script), "--print-source-tree-digest", env=env),
            "runner_build_digest": run("sh", str(script), "--print-runner-build-digest", env=env)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("export", "check"))
    parser.add_argument("receipt", type=pathlib.Path)
    parser.add_argument("--source-root", type=pathlib.Path)
    parser.add_argument("--source-revision")
    parser.add_argument("--staged-cli", type=pathlib.Path, default=ROOT / "artifacts/media-0.1.0-linux-amd64")
    args = parser.parse_args()
    try:
        if args.command == "export":
            if args.source_root is None or args.source_revision is None:
                raise ContractError("export requires an exact archived source root and revision")
            receipt = collect(source_provenance(args.source_root, args.source_revision))
        else:
            receipt = json.loads(args.receipt.read_text())
            validate_shape(receipt)
        actual = collect(receipt["provenance"])
        tools = schema_tools(json.loads((ROOT / "shared/skills/media/MCP_SCHEMA.json").read_text()))
        cli_sha = hashlib.sha256(args.staged_cli.read_bytes()).hexdigest()
        validate(receipt, actual, tools, cli_sha)
        if args.command == "export":
            # Never silently retarget an existing deployment receipt.
            with args.receipt.open("x", encoding="utf-8") as out:
                os.chmod(args.receipt, 0o600)
                json.dump(receipt, out, sort_keys=True, indent=2)
                out.write("\n")
        print(f"local runtime contract OK: {len(tools)} tools; both immutable images, source digests and CLI verified")
    except (ContractError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        raise SystemExit(f"local runtime contract error: {error}") from error


if __name__ == "__main__":
    main()
