#!/usr/bin/env python3
"""Publish selected Docker health and filesystem capacity; no Docker API in Kuma."""
import argparse
import concurrent.futures
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.parse
import urllib.request

STATE_FORMAT = ('{"name":{{json .Name}},"state":{{json .State.Status}},'
                '"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},'
                '"exit_code":{{.State.ExitCode}},"oom":{{.State.OOMKilled}}}')


def container_status(state):
    if not state:
        return "down", "Container missing"
    if state["oom"]:
        return "down", "Container OOM-killed"
    if state["state"] != "running":
        return "down", "Container " + state["state"]
    if state["health"] and state["health"] != "healthy":
        return "down", "Docker health: " + state["health"]
    return "up", "Docker health: healthy" if state["health"] else "Running; no native healthcheck"


def capacity_status(path, minimum_percent, minimum_bytes):
    value = os.statvfs(path)
    total = value.f_blocks * value.f_frsize
    free = value.f_bavail * value.f_frsize
    percent = free / total * 100 if total else 0
    status = "down" if percent < minimum_percent or free < minimum_bytes else "up"
    label = "Low free space" if status == "down" else "Free space"
    return status, (f"{path}: {label}; {free / 2**30:.1f} GiB available / "
                    f"{total / 2**30:.1f} GiB total ({percent:.1f}% free); "
                    f"required >= {minimum_percent:g}% and >= {minimum_bytes / 2**30:g} GiB")


def publish(base, item, status, message):
    token = urllib.parse.quote(item["token"], safe="")
    query = urllib.parse.urlencode({"status": status, "msg": message})
    url = f"{base}/api/push/{token}?{query}"
    with urllib.request.urlopen(url, timeout=10) as response:
        if not json.load(response).get("ok"):
            raise RuntimeError("Heartbeat rejected")


def save_health_errors(path, state):
    """Keep the latest 100 distinct failed probes, privately and across recovery."""
    if not state:
        return 0
    failed = [row for row in state.get("health_log", []) if row["ExitCode"] != 0]
    if not failed:
        return 0
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.parent.stat().st_mode & 0o077 or path.is_symlink():
        raise ValueError("Health error storage must be private")
    data = json.loads(path.read_text()) if path.exists() else {"container": state["name"], "entries": []}
    if data["container"] != state["name"]:
        raise ValueError("Health error container changed")
    entries = data["entries"]
    seen = {(row["start"], row["end"]) for row in entries}
    added = 0
    for row in failed:
        key = (row["Start"], row["End"])
        if key in seen:
            continue
        entries.append({"start": row["Start"], "end": row["End"], "exit_code": row["ExitCode"],
                        "output": row["Output"][:4096], "health": state["health"],
                        "state": state["state"], "oom": state["oom"],
                        "observed_at": datetime.now(timezone.utc).isoformat()})
        seen.add(key)
        added += 1
    if not added:
        return 0
    data["entries"] = entries[-100:]
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".health-errors-", delete=False) as output:
            temporary = Path(output.name)
            json.dump(data, output, ensure_ascii=True)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return added


def collect(config):
    items = config.get("containers", [])
    names = [item["name"] for item in items]
    states = {}
    capture = config.get("health_error_capture")
    if names:
        state_format = STATE_FORMAT
        if capture:
            if capture["container"] not in names:
                raise ValueError("Health error target must be a monitored container")
            state_format = STATE_FORMAT[:-1] + ',"health_log":{{if and .State.Health (eq .Name ' + \
                json.dumps("/" + capture["container"]) + ')}}{{json .State.Health.Log}}{{else}}[]{{end}}}'
        result = subprocess.run(["docker", "inspect", "--format", state_format, *names],
                                capture_output=True, text=True, timeout=20)
        if result.returncode and not result.stdout.strip():
            # Do not invent per-container state when the data source is unavailable.
            # Existing Push monitors will expire if the collector cannot recover.
            raise RuntimeError("Docker state unavailable")
        # docker inspect returns nonzero if one container is missing; keep valid rows.
        for line in result.stdout.splitlines():
            state = json.loads(line)
            states[state["name"].lstrip("/")] = state
    if capture:
        try:
            added = save_health_errors(Path(capture["path"]), states.get(capture["container"]))
            if added:
                print(f"Captured {added} failed healthchecks")
        except Exception as error:
            # Diagnostic persistence must not prevent normal heartbeat publication.
            print(f"Health error capture failed ({type(error).__name__})")
    output = [(item, *container_status(states.get(item["name"]))) for item in items]
    for item in config.get("mounts", []):
        try:
            if item.get("require_mount") and not os.path.ismount(item["path"]):
                status, message = "down", item["path"] + ": required filesystem is not mounted"
            else:
                status, message = capacity_status(item["path"], item.get("min_free_percent", 5),
                                                  item.get("min_free_bytes", 5 * 2**30))
        except OSError:
            status, message = "down", item["path"] + ": filesystem unavailable"
        output.append((item, status, message))
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    base = config["base_url"].rstrip("/")
    if not base.startswith("https://"):
        raise ValueError("Use the trusted HTTPS frontend")
    errors = 0
    try:
        output = collect(config)
    except Exception as error:
        print(f"Collection failed ({type(error).__name__}); no heartbeats published")
        return 1
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(publish, base, item, status, message): item["name"]
                   for item, status, message in output}
        for future in concurrent.futures.as_completed(futures):
            try:
                future.result()
            except Exception as error:
                # Exceptions may contain token-bearing URLs; log only name and class.
                print(f"Heartbeat failed: {futures[future]} ({type(error).__name__})")
                errors += 1
    print(f"Published {len(output) - errors}/{len(output)} health results")
    return int(bool(errors))


if __name__ == "__main__":
    raise SystemExit(main())
