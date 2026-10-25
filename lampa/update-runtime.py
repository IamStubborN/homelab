#!/usr/bin/env python3
"""Operator-only Lampac runtime updates. Python standard library; Linux host only."""

import argparse
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid


UPSTREAM = "ghcr.io/lampac-nextgen/lampac:latest"
LIVE_TAG = "homelab/lampac-intel:latest"
DOCKER = ["docker", "--host", "unix:///var/run/docker.sock"]
MOUNTS = {
    "/lampac/init.conf": ("config/init.conf", True),
    "/lampac/passwd": ("config/passwd", True),
    "/lampac/module/LampaWeb/plugins/lampainit-invc.js": ("config/lampainit-invc.js", True),
    "/lampac/wwwroot/plugins/homelab": ("plugins", True),
    "/lampac/mods/Tracks": ("mods/Tracks", True),
    "/lampac/cache": ("cache", False),
    "/lampac/database": ("database", False),
    "/lampac/logs": ("logs", False),
}
PLANS = {
    "stage": "Verify Compose config-hash matches the deployed service, startup contract and mounts; pin current image; pull upstream latest; build uniquely tagged candidate; record immutable IDs. No restart or live-tag change.",
    "check": "Match candidate Entrypoint/Cmd/User/WorkingDir to baseline image and runtime; launch with empty temporary app state and synthetic config, without network, ports or GPU; probe version; remove canary; record input fingerprint. No private config copies or production writes.",
    "apply": "Require maintenance-window acknowledgement and successful current check; stop only lampa; snapshot all binds and resolved Compose; tag candidate as latest; recreate only lampa; verify HTTP. Failure leaves recovery journal for explicit rollback.",
    "rollback": "Require maintenance-window acknowledgement; stop only lampa; preserve displaced bind data; restore pre-apply bind snapshots and previous image using saved service configuration; recreate only lampa; verify HTTP.",
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(args, *, log=None):
    # Never emit command arguments, resolved environment, config, or application logs.
    if log:
        with log.open("ab") as stream:
            result = subprocess.run(args, stdout=stream, stderr=stream)
    else:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    require(result.returncode == 0, "Command failed; inspect private logs/state on the host.")
    return result.stdout.decode() if not log else ""


def docker(*args, **kwargs):
    return run(DOCKER + list(args), **kwargs)


def inspect(kind, name):
    return json.loads(docker(kind, "inspect", name))[0]


def save(path, value):
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def load(path):
    return json.loads(path.read_text())


def compose(root):
    # Explicit files avoid COMPOSE_FILE and preserve the host's private override.
    result = DOCKER + ["compose", "--project-directory", str(root), "-p", "homelab", "-f", str(root / "compose.yml")]
    if (root / "compose.override.yml").exists():
        result += ["-f", str(root / "compose.override.yml")]
    return result


def startup_contract(config):
    require(config.get("Entrypoint") == ["/usr/share/dotnet/dotnet", "Core.dll"] and
            config.get("Cmd") in (None, []) and config.get("WorkingDir") == "/lampac" and
            config.get("User") in ("lampac", "1000", "1000:1000"),
            "Unsupported image/container startup contract; review manually.")
    # Docker may represent an inherited empty image Cmd as either null or [].
    return (config["User"], config["WorkingDir"], tuple(config["Entrypoint"]), tuple(config.get("Cmd") or []))


def current(root):
    model = json.loads(run(compose(root) + ["config", "--format", "json"]))
    container = inspect("container", "lampa")
    labels = container["Config"].get("Labels") or {}
    require(labels.get("com.docker.compose.project") == "homelab" and
            labels.get("com.docker.compose.service") == "lampa" and
            labels.get("com.docker.compose.project.working_dir") == str(root),
            "lampa must belong to this root homelab Compose project.")
    expected_files = [str(root / "compose.yml")]
    if (root / "compose.override.yml").exists():
        expected_files.append(str(root / "compose.override.yml"))
    require(labels.get("com.docker.compose.project.config_files", "").split(",") == expected_files,
            "Unexpected Compose files; reconcile deployment before staging.")
    service_hash = re.fullmatch(r"lampa[ \t]+([0-9a-f]{64})", run(compose(root) + ["config", "--hash", "lampa"]).strip())
    require(service_hash and service_hash.group(1) == labels.get("com.docker.compose.config-hash"),
            "Compose model differs from the deployed config-hash or hash output is unsupported. Reconcile before staging.")
    service = model["services"]["lampa"]
    require(service.get("image") == LIVE_TAG and
            service.get("container_name") == "lampa", "Unexpected Lampa image/name.")
    require(service.get("labels", {}).get("com.centurylinklabs.watchtower.enable") == "false",
            "Lampa must opt out of Watchtower.")
    for key in ("entrypoint", "command"):
        require(service.get(key) is None, "Unsupported service override (including empty values): " + key)
    for key in ("post_start", "pre_stop", "volumes_from", "secrets", "configs"):
        require(not service.get(key), "Unsupported service field: " + key)
    require(startup_contract(container["Config"]) == startup_contract(inspect("image", container["Image"])["Config"]) and
            container.get("Path") == "/usr/share/dotnet/dotnet" and container.get("Args") == ["Core.dll"],
            "Running startup contract differs from the baseline image.")
    build = service.get("build", {})
    require(build.get("context") == str(root / "lampa/runtime") and
            build.get("dockerfile", "Dockerfile") == "Dockerfile" and
            not (set(build) - {"context", "dockerfile"}), "Unexpected runtime build configuration.")
    require(len(service.get("volumes", [])) == len(MOUNTS) and len(container["Mounts"]) == len(MOUNTS),
            "Mount set changed; review the updater before use.")
    mounts = []
    for target, (relative, readonly) in MOUNTS.items():
        source = root / "lampa" / relative
        require(source.exists() and source.resolve() == source, "Missing or symlinked bind source.")
        configured = [v for v in service["volumes"] if v["target"] == target]
        active = [v for v in container["Mounts"] if v["Destination"] == target]
        require(len(configured) == len(active) == 1 and configured[0]["type"] == active[0]["Type"] == "bind" and
                configured[0]["source"] == active[0]["Source"] == str(source) and
                bool(configured[0].get("read_only")) == readonly and active[0]["RW"] != readonly,
                "Configured and active bind mounts must match the supported layout.")
        require(not source.is_dir() or not any(p.is_symlink() for p in source.rglob("*")),
                "Symlinks inside bind trees need manual review.")
        mounts.append({"source": str(source), "target": target, "readonly": readonly})
    return model, container, mounts


def fingerprint(model, container, mounts, root):
    service = model["services"]["lampa"]
    deployment = {"service": service,
                  "networks": {key: model["networks"][key] for key in service.get("networks", {})}}
    digest = hashlib.sha256(json.dumps(deployment, sort_keys=True).encode())
    digest.update(container["Id"].encode())
    digest.update(container["Image"].encode())
    for name in ("Dockerfile", ".dockerignore", "verify-sqlite-build.py"):
        digest.update(name.encode())
        digest.update((root / "lampa/runtime" / name).read_bytes())
    for mount in mounts:
        if not mount["readonly"]:
            continue
        source = Path(mount["source"])
        paths = sorted(source.rglob("*")) if source.is_dir() else [source]
        for path in paths:
            digest.update(str(path).encode())
            digest.update(str(path.stat().st_mode).encode())
            if path.is_file():
                digest.update(path.read_bytes())
    return digest.hexdigest()


def snapshot(mounts, destination):
    destination.mkdir(mode=0o700)
    for index, mount in enumerate(mounts):
        run(["cp", "-a", "--", mount["source"], str(destination / str(index))])
    # Flush copied data before recording a rollback-ready checkpoint.
    os.sync()


# The first start of a new version compiles every enabled module before it
# listens: about 5 minutes on production data, against 1 minute afterwards.
READY_SECONDS = 600


def http_ready(name, endpoints=("/version?type=hash",)):
    deadline = time.monotonic() + READY_SECONDS
    while True:
        state = inspect("container", name)["State"]
        if not state["Running"]:
            return False
        try:
            for endpoint in endpoints:
                body = docker("exec", name, "curl", "--fail", "--silent", "--show-error",
                              "--max-time", "3", "http://127.0.0.1:9118" + endpoint)
                require(bool(body.strip()), "Empty HTTP probe response.")
            return True
        except RuntimeError:
            if time.monotonic() >= deadline:
                return False
            time.sleep(2)


def stage(root, state):
    if (state / "pending.json").exists():
        previous = load(state / "pending.json")
        require(previous["phase"] in ("staged", "checked", "applied", "rolled-back"),
                "An apply/rollback transaction exists. Resolve it before staging again.")
    model, container, mounts = current(root)
    baseline = fingerprint(model, container, mounts, root)
    require(container["State"]["Running"], "Stage requires a running baseline.")
    require(inspect("image", LIVE_TAG)["Id"] == container["Image"],
            "Live tag differs from running image; reconcile it before staging.")
    generation = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + uuid.uuid4().hex[:8]
    directory = state / generation
    directory.mkdir(mode=0o700)
    record = {"generation": generation, "root": str(root), "previous": container["Image"],
              "container": container["Id"], "mounts": mounts, "phase": "building"}
    save(directory / "record.json", record)
    docker("image", "tag", container["Image"], "homelab/lampac-intel:rollback-" + generation)
    docker("pull", UPSTREAM, log=directory / "build.log")
    upstream = inspect("image", UPSTREAM)
    digest = next((d for d in upstream.get("RepoDigests", []) if d.startswith(UPSTREAM.rsplit(":", 1)[0] + "@")), None)
    require(digest, "Pulled upstream has no registry digest.")
    source = (root / "lampa/runtime/Dockerfile").read_text()
    require(source.splitlines()[0] in ("FROM " + UPSTREAM, "FROM " + UPSTREAM + " AS runtime-base"),
            "Unexpected Dockerfile base; review before updating.")
    # Freeze the pulled base without modifying the repository Dockerfile.
    (directory / "Dockerfile").write_text(source.replace("FROM " + UPSTREAM, "FROM " + digest, 1))
    tag = "homelab/lampac-intel:candidate-" + generation
    docker("build", "--pull", "--tag", tag, "--file", str(directory / "Dockerfile"),
           str(root / "lampa/runtime"), log=directory / "build.log")
    require(fingerprint(*current(root), root) == baseline, "Deployment changed during stage; stage again.")
    record.update(candidate=inspect("image", tag)["Id"], upstream=digest, phase="staged", fingerprint=baseline)
    save(directory / "record.json", record)
    save(state / "pending.json", record)
    print("Staged " + generation + ". Run check next.")


def check(root, state, record):
    require(record["phase"] in ("staged", "checked"), "Check requires a staged candidate.")
    model, container, mounts = current(root)
    require(fingerprint(model, container, mounts, root) == record["fingerprint"],
            "Deployment changed since stage. Stage again.")
    record["phase"] = "staged"
    save(state / "pending.json", record)
    image = inspect("image", record["candidate"])
    require(startup_contract(image["Config"]) == startup_contract(container["Config"]),
            "Candidate startup contract differs from the validated baseline image/runtime.")
    directory = state / record["generation"]
    probe = directory / ("probe-" + uuid.uuid4().hex[:8])
    probe.mkdir(mode=0o700)
    # The canary never sees production secrets, plugins, databases or cache.
    config = probe / "init.conf"
    save(config, {"listen": {"version": True, "ip": "127.0.0.1", "port": 9118},
                  "chromium": {"enable": False}, "gst": {"enable": False},
                  "BaseModule": {"LoadModules": ["LampaWeb"]}})
    os.chown(config, 1000, 1000)
    password = probe / "passwd"
    password.write_text(uuid.uuid4().hex + uuid.uuid4().hex + "\n")
    os.chown(password, 1000, 1000)
    name = "lampac-check-" + record["generation"]
    args = ["create", "--name", name, "--network", "none", "--restart", "no", "--no-healthcheck",
            "--label", "com.centurylinklabs.watchtower.enable=false", "--label", "traefik.enable=false",
            "--security-opt", "no-new-privileges:true", "--cap-drop", "ALL", "--pids-limit", "256",
            "--memory", "2g", "--cpus", "1", "--shm-size", "256m", "--workdir", "/lampac",
            "--entrypoint", "/usr/share/dotnet/dotnet"]
    for filename in ("init.conf", "passwd"):
        args += ["--mount", "type=bind,source=" + str(probe / filename) + ",target=/lampac/" + filename + ",readonly"]
    # Keep image-bundled data (including offline Cloudflare IP lists) visible.
    # It remains in the disposable container layer, never a production bind.
    for subdir in ("cache", "database", "logs"):
        empty = probe / subdir
        empty.mkdir(mode=0o700)
        os.chown(empty, 1000, 1000)
        args += ["--mount", "type=bind,source=" + str(empty) + ",target=/lampac/" + subdir]
    created = False
    try:
        docker(*args, record["candidate"], "Core.dll")
        created = True
        docker("start", name)
        require(http_ready(name),
                "Candidate startup/local HTTP probe failed; inspect private check.log.")
    finally:
        if created:
            try:
                docker("logs", name, log=probe / "check.log")
            finally:
                docker("rm", "--force", "--volumes", name)
    require(fingerprint(*current(root), root) == record["fingerprint"],
            "Deployment changed during check. Stage again.")
    record["phase"] = "checked"
    save(state / "pending.json", record)
    print("Candidate startup passed in network isolation. GPU and playback remain unverified.")


def frozen_model(model, image):
    service = copy.deepcopy(model["services"]["lampa"])
    service["image"] = image
    service.pop("build", None)
    service.pop("depends_on", None)
    # No dependencies or unrelated services can be created by this model.
    result = {"name": "homelab", "services": {"lampa": service},
              "networks": {key: model["networks"][key] for key in service.get("networks", {})}}
    # Compose interpolates JSON too; resolved dollar characters must remain literal.
    def literal(value):
        if isinstance(value, str):
            return value.replace("$", "$$")
        if isinstance(value, list):
            return [literal(item) for item in value]
        if isinstance(value, dict):
            return {key: literal(item) for key, item in value.items()}
        return value
    return literal(result)


def recreate(root, model_file, directory):
    run(DOCKER + ["compose", "--project-directory", str(root), "-p", "homelab", "-f", str(model_file),
                  "up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "lampa"],
        log=directory / "deploy.log")


def apply(root, state, record):
    require(record["phase"] == "checked", "Apply requires a successful check.")
    model, container, mounts = current(root)
    require(fingerprint(model, container, mounts, root) == record["fingerprint"],
            "Deployment changed after check. Stage and check again.")
    require(inspect("image", LIVE_TAG)["Id"] == record["previous"], "Live tag changed after stage.")
    inspect("image", record["candidate"])
    directory = state / record["generation"]
    require(all(Path(m["source"]).parent.stat().st_dev == state.stat().st_dev for m in mounts),
            "Private state and bind source parents must share a filesystem for atomic rollback.")
    save(directory / "before.json", frozen_model(model, record["previous"]))
    run(DOCKER + ["compose", "--project-directory", str(root), "-p", "homelab",
                  "-f", str(directory / "before.json"), "config", "--quiet"],
        log=directory / "deploy.log")
    # Saved before stopping: interrupted operations remain explicitly recoverable.
    record["phase"] = "stopping"
    save(state / "pending.json", record)
    docker("stop", "--time", "30", container["Id"])
    snapshot(mounts, directory / "backup")
    record["phase"] = "backed-up"
    save(state / "pending.json", record)
    require(fingerprint(*current(root), root) == record["fingerprint"],
            "Deployment changed while backing up. Roll back before staging again.")
    docker("image", "tag", record["candidate"], LIVE_TAG)
    # Use the real root files so normal root Compose remains the deployment owner.
    run(compose(root) + ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "lampa"],
        log=directory / "deploy.log")
    require(inspect("container", "lampa")["Image"] == record["candidate"] and http_ready("lampa"),
            "Apply failed health verification. Run explicit rollback in the maintenance window.")
    record["phase"] = "applied"
    save(state / "pending.json", record)
    print("Applied. Retain private snapshots and rollback image; playback needs operator verification.")


def restore_mount(mount, index, directory):
    source = Path(mount["source"])
    require(source.parent.resolve() == source.parent and not source.is_symlink(),
            "Restore path changed or became a symlink.")
    displaced = directory / ("displaced-" + str(index))
    temporary = directory / ("restore-" + str(index))
    # Deterministic names permit resuming after a crash between either rename.
    if displaced.exists() and source.exists():
        return
    if temporary.exists():
        # Never guess whether a previous interrupted copy completed.
        temporary.rename(temporary.with_name(temporary.name + "-incomplete-" + uuid.uuid4().hex[:8]))
    run(["cp", "-a", "--", str(directory / "backup" / str(index)), str(temporary)])
    os.sync()
    if source.exists():
        source.rename(displaced)
    temporary.rename(source)
    os.sync()


def rollback(root, state, record):
    require(record["phase"] in ("stopping", "backed-up", "applied", "restoring"),
            "No interrupted or completed apply to roll back.")
    directory = state / record["generation"]
    present = docker("ps", "-aq", "--filter", "name=^/lampa$").strip()
    container = inspect("container", "lampa") if present else None
    if container:
        labels = container["Config"].get("Labels") or {}
        require(labels.get("com.docker.compose.project") == "homelab" and
                labels.get("com.docker.compose.service") == "lampa" and
                labels.get("com.docker.compose.project.working_dir") == str(root) and
                container["Image"] in (record["previous"], record["candidate"]),
                "Unexpected live container; refuse rollback.")
    inspect("image", record["previous"])
    if record["phase"] == "stopping":
        require(container and container["Id"] == record["container"] and container["Image"] == record["previous"],
                "Pre-backup baseline changed; manual recovery required.")
        docker("start", container["Id"])
    else:
        require(all(Path(m["source"]).parent.stat().st_dev == state.stat().st_dev for m in record["mounts"]),
                "Rollback paths must share a filesystem with private state.")
        record["phase"] = "restoring"
        save(state / "pending.json", record)
        if container:
            docker("stop", "--time", "30", container["Id"])
        for index, mount in enumerate(record["mounts"]):
            restore_mount(mount, index, directory)
        docker("image", "tag", record["previous"], LIVE_TAG)
        recreate(root, directory / "before.json", directory)
    require(http_ready("lampa"), "Rollback HTTP check failed; preserve state and inspect private logs.")
    record["phase"] = "rolled-back"
    save(state / "pending.json", record)
    print("Rolled back image, configuration and bind data. See UPDATE.md for root Compose reconciliation.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=PLANS)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--state-dir", type=Path, default=Path("/var/lib/lampac-update"))
    parser.add_argument("--maintenance-window", action="store_true",
                        help="Operator confirms playback and backup are idle, with new starts prevented until completion")
    parser.add_argument("--dry-run", action="store_true", help="Print plan only; no Docker, network or filesystem writes")
    args = parser.parse_args()
    if args.dry_run:
        print(PLANS[args.action])
        return
    require(sys.platform == "linux" and os.geteuid() == 0, "Run as root on the Linux Docker host.")
    require(args.root.is_absolute() and args.root.resolve() == args.root, "Root must be a canonical absolute path.")
    root = args.root
    require((root / "compose.yml").is_file(), "Root compose.yml is missing.")
    state = args.state_dir
    require(state.is_absolute() and state.resolve() == state and state != Path("/") and
            not state.is_relative_to(root) and not root.is_relative_to(state),
            "State must be a canonical dedicated path outside the repository.")
    require(not any((parent / ".git").exists() for parent in (state, *state.parents)),
            "Private state must be outside all Git working trees.")
    require(not any(c in str(root) + str(state) for c in (",", "\n", "\r")), "Unsupported path characters.")
    if args.action in ("apply", "rollback"):
        require(args.maintenance_window, "Confirm idle playback/backup and prevent new starts with --maintenance-window.")
    for key in list(os.environ):
        if key.startswith("COMPOSE_") or key.startswith("DOCKER_"):
            os.environ.pop(key)
    os.chdir(root)
    os.umask(0o077)
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(state.stat().st_uid == 0 and state.stat().st_mode & 0o777 == 0o700,
            "State directory must be root-owned with mode 0700.")
    with (state / "lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == "stage":
            stage(root, state)
        else:
            record = load(state / "pending.json")
            require(record["root"] == str(root) and re.fullmatch(r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}", record["generation"]),
                    "State belongs to another deployment or has an invalid generation.")
            {"check": check, "apply": apply, "rollback": rollback}[args.action](root, state, record)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        # OS exceptions may include paths but never dump file contents or subprocess stderr.
        print("Update stopped: " + str(error), file=sys.stderr)
        sys.exit(1)
