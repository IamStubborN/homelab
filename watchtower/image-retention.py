#!/usr/bin/env python3
"""Retain current + previous images; remove only proven repository digests."""

import argparse
import copy
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone


ENABLE = "com.centurylinklabs.watchtower.enable"
COMPOSE = "com.docker.compose."
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")


def docker(*args):
    return subprocess.run(
        ["docker", "--host", "unix:///var/run/docker.sock", *args],
        check=True, text=True, capture_output=True, timeout=120,
    ).stdout


def inspect_many(kind, ids, template):
    result = []
    ids = sorted(set(ids))
    for offset in range(0, len(ids), 100):
        output = docker(kind, "inspect", "--format", template, *ids[offset:offset + 100])
        result.extend(json.loads(line) for line in output.splitlines())
    return result


def inventory():
    # Explicit projections: never persist environment variables or mounts.
    label_fields = ",".join(
        json.dumps(key) + ':{{json (index .Config.Labels ' + json.dumps(key) + ')}}'
        for key in (ENABLE, COMPOSE + "project", COMPOSE + "service",
                    COMPOSE + "container-number", COMPOSE + "oneoff")
    )
    containers = inspect_many("container", docker("ps", "-aq", "--no-trunc").split(),
        '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},'
        '"ref":{{json .Config.Image}},"labels":{' + label_fields + '},'
        '"status":{{json .State.Status}}}')
    images = inspect_many("image", docker("image", "ls", "-aq", "--no-trunc").split(),
        '{"id":{{json .Id}},"tags":{{json .RepoTags}},'
        '"digests":{{json .RepoDigests}},"size":{{json .Size}}}')
    for item in images:
        item["tags"] = sorted(item["tags"] or [])
        item["digests"] = sorted(item["digests"] or [])
    return {"daemon": docker("info", "--format", "{{.ID}}").strip(),
            "containers": containers, "images": {i["id"]: i for i in images}}


def stable_inventory():
    first = inventory()
    second = inventory()
    if first != second:
        raise ValueError("Docker inventory changed during observation; retry when idle")
    return second


def repository(ref):
    name = ref.split("@", 1)[0]
    if ":" in name.rsplit("/", 1)[-1]:
        name = name.rsplit(":", 1)[0]
    head = name.split("/", 1)[0]
    if "/" not in name or not ("." in head or ":" in head or head == "localhost"):
        name = "docker.io/" + name
    name = name.replace("index.docker.io/", "docker.io/", 1)
    if name.startswith("docker.io/") and name.count("/") == 1:
        name = name.replace("docker.io/", "docker.io/library/", 1)
    return name


def managed(snapshot, project):
    found = {}
    for container in snapshot["containers"]:
        labels = container["labels"]
        if ((labels.get(ENABLE) or "").lower() != "true"
                or labels.get(COMPOSE + "project") != project
                or (labels.get(COMPOSE + "oneoff") or "false").lower() == "true"
                or container["status"] not in ("running", "restarting")
                or "@" in container["ref"] or container["ref"].startswith("sha256:")):
            continue
        service = labels.get(COMPOSE + "service")
        slot = labels.get(COMPOSE + "container-number")
        if not service or not slot:
            continue
        key = f"{service}/{slot}"
        if key in found:
            raise ValueError(f"Ambiguous managed service: {key}")
        found[key] = container
    return found


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def observe(state, snapshot):
    if state["version"] != 1 or state["daemon"] != snapshot["daemon"]:
        raise ValueError("Unsupported state or different Docker daemon")
    current = managed(snapshot, state["project"])
    frozen = []
    for key, entry in state["services"].items():
        container = current.get(key)
        if container is None or container["ref"] != entry["ref"]:
            frozen.append(key)
            continue
        image_id = container["image"]
        if image_id not in snapshot["images"]:
            raise ValueError(f"Current image missing: {key}")
        proven = state.setdefault("digests", {}).setdefault(image_id, [])
        for digest in snapshot["images"][image_id]["digests"]:
            name, separator, value = digest.partition("@")
            if (separator and name and IMAGE_ID.fullmatch(value)
                    and repository(digest) == repository(entry["ref"])
                    and digest not in proven):
                proven.append(digest)
        proven.sort()
        history = entry["history"]
        if not history or history[-1] != image_id:
            # A rollback makes the returned-to ID current again.
            entry["history"] = [i for i in history if i != image_id] + [image_id]
    state["observed_at"] = timestamp()
    return frozen, sorted(set(current) - set(state["services"]))


def plan(state, snapshot):
    effective = copy.deepcopy(state)
    frozen, unenrolled = observe(effective, snapshot)
    owners = {}
    retained = set()
    for key, entry in effective["services"].items():
        history = entry["history"]
        if not history or any(not IMAGE_ID.fullmatch(i) for i in history):
            raise ValueError(f"Invalid recorded image history: {key}")
        retained.update(history if key in frozen else history[-2:])
        for image_id in history:
            owners.setdefault(image_id, []).append(key)
    referenced = {c["image"] for c in snapshot["containers"]}
    candidates, preserved = [], []
    for image_id, item in sorted(snapshot["images"].items()):
        reasons = []
        services = owners.get(image_id, [])
        if not services:
            reasons.append("not-in-recorded-managed-history")
        if image_id in retained:
            reasons.append("current-or-previous-or-frozen-history")
        if image_id in referenced:
            reasons.append("referenced-by-container")
        if item["tags"]:
            reasons.append("tagged-including-manual-rollback")
        proven = set(effective.get("digests", {}).get(image_id, []))
        if not item["digests"]:
            reasons.append("no-repository-digest-never-delete-by-id")
        elif any(d not in proven for d in item["digests"]):
            reasons.append("repository-digest-not-recorded-while-managed")
        known_repos = {repository(effective["services"][key]["ref"]) for key in services}
        if any(repository(d) not in known_repos for d in item["digests"]):
            reasons.append("digest-in-untracked-repository")
        row = {**item, "services": services}
        if reasons:
            preserved.append({**row, "reasons": reasons})
        else:
            candidates.append({**row, "delete_refs": item["digests"]})
    return {
        "generated_at": timestamp(), "daemon": snapshot["daemon"],
        "project": state["project"], "policy": "current-plus-one-observed-previous",
        "managed_services": effective["services"], "frozen_services": frozen,
        "unenrolled_services": unenrolled, "container_count": len(snapshot["containers"]),
        "image_count": len(snapshot["images"]), "candidates": candidates,
        "candidate_logical_bytes": sum(i["size"] for i in candidates),
        "proven_reclaimable_bytes": 0 if not candidates else None,
        "bytes_note": "Logical sizes share layers; reclaimed bytes are not proven by image sizes.",
        "preserved": preserved,
    }


def save(path, state):
    fd, temporary = tempfile.mkstemp(prefix=".retention-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(state, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("discover", "init", "observe", "plan", "run"))
    parser.add_argument("--state", type=Path, required=True,
                        help="Private JSON state outside the checkout")
    parser.add_argument("--project", help="Required only for discover/init")
    parser.add_argument("--apply", action="store_true",
                        help="run only: remove eligible digests; enable only after policy review")
    args = parser.parse_args()
    if args.apply and args.command != "run":
        parser.error("--apply requires run")
    if args.command in ("init", "discover") and not args.project:
        parser.error("discover/init requires --project")
    if args.command == "discover":
        snapshot = stable_inventory()
        state = initial_state(snapshot, args.project)
        print(json.dumps(plan(state, snapshot), indent=2, sort_keys=True))
        return
    # plan is read-only; writers serialize both observations and deletion.
    if args.command == "plan":
        state = json.loads(args.state.read_text())
        print(json.dumps(plan(state, stable_inventory()), indent=2, sort_keys=True))
        return
    args.state.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.umask(0o077)
    with args.state.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        snapshot = stable_inventory()
        if args.command == "init":
            if args.state.exists():
                raise ValueError("State already exists; refusing to replace history")
            state = initial_state(snapshot, args.project)
        else:
            state = json.loads(args.state.read_text())
            observe(state, snapshot)
        save(args.state, state)
        report = plan(state, snapshot)
        report["deleted"] = []
        report["apply"] = args.apply
        # Emit the exact plan before the first mutation, including on failure.
        print(json.dumps(report, indent=2, sort_keys=True), flush=True)
        if args.apply:
            for candidate in report["candidates"]:
                image_id = candidate["id"]
                for digest in candidate["delete_refs"]:
                    fresh = stable_inventory()
                    observe(state, fresh)
                    save(args.state, state)
                    eligible = {i["id"]: i for i in plan(state, fresh)["candidates"]}
                    if image_id not in eligible or digest not in eligible[image_id]["delete_refs"]:
                        raise ValueError(f"Candidate protection changed; stopping: {image_id}")
                    resolved = docker("image", "inspect", "--format", "{{.Id}}", digest).strip()
                    if resolved != image_id:
                        raise ValueError(f"Digest no longer resolves to recorded ID: {digest}")
                    # A digest removes only itself; a concurrently added tag survives.
                    # Never fall back to an ID, tag, force, or parent pruning.
                    output = docker("image", "rm", "--no-prune", digest)
                    print(json.dumps({"removed_reference": digest,
                                      "image_deleted": f"Deleted: {image_id}" in output.splitlines(),
                                      "docker_output": output}), flush=True)


def initial_state(snapshot, project):
    services = {
        key: {"ref": container["ref"], "history": [container["image"]]}
        for key, container in managed(snapshot, project).items()
    }
    if not services:
        raise ValueError("No eligible labelled Compose services; refusing empty enrollment")
    state = {"version": 1, "daemon": snapshot["daemon"], "project": project,
             "observed_at": timestamp(), "services": services}
    observe(state, snapshot)
    return state


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        print(f"image retention stopped: {error}", file=sys.stderr)
        sys.exit(1)
