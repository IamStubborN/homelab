#!/usr/bin/env python3
"""Prepare private daily application files and transaction-consistent DB exports.

Run inside Docker CT 300. The resulting directory is input to a PBS file backup;
this helper does not upload data, stop applications or remove old captures.
"""

import argparse
from contextlib import closing
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import time
import uuid

PRIVATE_CONFIG = Path("/etc/homelab/backup.json")
BACKUP_CONFIG = json.loads(PRIVATE_CONFIG.read_text(encoding="utf-8")) if PRIVATE_CONFIG.is_file() else {}
REPOSITORY = Path(os.environ.get("HOMELAB_REPOSITORY", BACKUP_CONFIG.get("repository", "/opt/homelab")))
if not REPOSITORY.is_absolute():
    raise ValueError("HOMELAB_REPOSITORY must be absolute")
STAGING_ROOT = Path("/var/lib/homelab-app-backup")
POSTGRES = ("media-postgres", "freedium-db")
DEFAULT_VOLUMES = (
    "homelab_hermes_primary_profile", "homelab_hermes_secondary_profile",
    "homelab_hermes_primary_browser", "homelab_hermes_secondary_browser",
    "homelab_hermes_primary_memory", "homelab_hermes_secondary_memory",
    "homelab_hermes_primary_vaultwarden", "homelab_media_notifier_primary",
    "homelab_media_notifier_secondary", "homelab_rezka_session_encrypted",
    "homelab_gluetun_rezka_state",
)
VOLUMES = tuple(filter(None, os.environ.get("HOMELAB_BACKUP_VOLUMES", ",".join(BACKUP_CONFIG.get("volumes", DEFAULT_VOLUMES))).split(",")))
SKIP_DIR_NAMES = {".git", "node_modules", "__pycache__", ".cache", ".npm",
                  "cache", "Cache", "Caches", "logs", "Logs", "log"}
SKIP_PREFIXES = (
    "backups", "jacred/data", "freedium/data/postgres", "freedium/data/redis",
    "karakeep/data/meilisearch", "wiki/syncthing/home/config/index-v2",
    "plex/config/Library/Application Support/Plex Media Server/Media",
    "plex/config/Library/Application Support/Plex Media Server/Metadata",
    "plex/config/Library/Application Support/Plex Media Server/Drivers",
    "plex/config/Library/Application Support/Plex Media Server/Codecs",
    "plex/config/Library/Application Support/Plex Media Server/Updates",
    "plex/config/Library/Application Support/Plex Media Server/Crash Reports",
)
PROFILE_SKIP = ("tesseract", ".local/lib", "home/.local/lib",
                ".local/share/pki/nssdb", "home/.local/share/pki/nssdb")


def excluded(relative, repository):
    if any(part in SKIP_DIR_NAMES for part in relative.parts):
        return True
    if repository and "Plex Media Server" in relative.parts:
        # Plex's dated database snapshots duplicate the current online export;
        # the full weekly guest backup still retains those older snapshots.
        if re.search(r"\.db-\d{4}-\d{2}-\d{2}(?:-wal|-shm)?$", relative.name):
            return True
    prefixes = SKIP_PREFIXES if repository else PROFILE_SKIP
    return any(relative == Path(prefix) or Path(prefix) in relative.parents for prefix in prefixes)


def roots():
    items = [(REPOSITORY, Path("rootfs") / REPOSITORY.relative_to("/"), True)]
    for name in VOLUMES:
        info = json.loads(subprocess.check_output(["docker", "volume", "inspect", name]))[0]
        source = Path(info["Mountpoint"])
        if not source.is_relative_to("/var/lib/docker/volumes") or source.name != "_data":
            raise RuntimeError(f"Unexpected volume location for {name}")
        items.append((source, Path("volumes", name), False))
    return items


def entries(source, repository):
    for parent, directories, files in os.walk(source, followlinks=False):
        relative_parent = Path(parent).relative_to(source)
        directories[:] = [name for name in directories if not excluded(relative_parent / name, repository)]
        for name in directories + files:
            relative = relative_parent / name
            path = source / relative
            if excluded(relative, repository):
                continue
            if stat.S_ISSOCK(path.lstat().st_mode) or stat.S_ISFIFO(path.lstat().st_mode):
                # Runtime IPC endpoints carry no recoverable application data.
                continue
            if path.name.endswith(("-wal", "-shm", "-journal")):
                base = path.with_name(path.name.rsplit("-", 1)[0])
                if base.is_file():
                    with base.open("rb") as database:
                        if database.read(16) == b"SQLite format 3\x00":
                            continue
            yield path, relative


def backup_sqlite(source, destination):
    deadline = time.monotonic() + 300

    def progress(status, remaining, total):
        if time.monotonic() > deadline:
            raise TimeoutError(f"SQLite backup exceeded 300 seconds: {source}")

    with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=5)) as original:
        with closing(sqlite3.connect(destination)) as copy:
            original.backup(copy, pages=256, progress=progress, sleep=0.1)
            # Plex's custom tokenizer is absent in the system SQLite build;
            # native Plex integrity checking must be done separately on restore.
            try:
                result = copy.execute("PRAGMA quick_check").fetchall()
            except sqlite3.OperationalError as error:
                if "Plex Media Server" in str(source) and "tokenizer" in str(error):
                    return "online-backup-complete; native Plex integrity check required"
                raise
            if result != [("ok",)]:
                raise RuntimeError(f"SQLite integrity check failed: {source}")
    return "online-backup-complete; quick_check=ok"


def copy_entry(source, destination):
    info = source.lstat()
    destination.parent.mkdir(parents=True, exist_ok=True)
    if stat.S_ISLNK(info.st_mode):
        destination.symlink_to(os.readlink(source))
    elif stat.S_ISDIR(info.st_mode):
        destination.mkdir(exist_ok=True)
    elif stat.S_ISREG(info.st_mode):
        with source.open("rb") as handle:
            sqlite = handle.read(16) == b"SQLite format 3\x00"
        if sqlite:
            result = backup_sqlite(source, destination)
        else:
            shutil.copyfile(source, destination)
            result = "file-copy; no cross-file transaction guarantee"
        os.chmod(destination, stat.S_IMODE(info.st_mode))
        os.utime(destination, ns=(info.st_atime_ns, info.st_mtime_ns))
        os.chown(destination, info.st_uid, info.st_gid)
        return result if sqlite else None
    else:
        raise RuntimeError(f"Unsupported special file in application data: {source}")
    if not destination.is_symlink():
        os.chmod(destination, stat.S_IMODE(info.st_mode))
    os.chown(destination, info.st_uid, info.st_gid, follow_symlinks=False)
    return None


def postgres_exports(destination):
    results = []
    for container in POSTGRES:
        directory = destination / "postgres" / container
        directory.mkdir(parents=True)
        query = "SELECT json_agg(datname) FROM pg_database WHERE NOT datistemplate"
        databases = json.loads(subprocess.check_output([
            "docker", "exec", container, "sh", "-c",
            'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"', "sh", query,
        ], timeout=30))
        with (directory / "globals.sql").open("wb") as output:
            subprocess.run(["docker", "exec", container, "sh", "-c",
                            'exec pg_dumpall -U "$POSTGRES_USER" --globals-only'],
                           stdout=output, check=True, timeout=120)
        for database in databases:
            filename = database.encode().hex() + ".dump"
            target = directory / filename
            with target.open("wb") as output:
                subprocess.run([
                    "docker", "exec", container, "sh", "-c",
                    'exec pg_dump -U "$POSTGRES_USER" -Fc -Z1 --dbname="$1"', "sh", database,
                ], stdout=output, check=True, timeout=1800)
            with target.open("rb") as original:
                subprocess.run(["docker", "exec", "-i", container, "pg_restore", "--list"],
                               stdin=original, stdout=subprocess.DEVNULL, check=True, timeout=120)
            results.append({"container": container, "database": database,
                            "file": str(target.relative_to(destination)), "archive_list_valid": True})
    return results


def capture_manifest(path):
    try:
        value = json.loads((path / "manifest.json").read_text())
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) and value.get("format") == 1 and value.get("completed_utc") else None


def publish_current(path):
    current = STAGING_ROOT / "current"
    if path == current or (current.exists() and not current.is_symlink()):
        return  # Keep a legacy real directory until prepare retires it.
    temporary = STAGING_ROOT / (".current-" + uuid.uuid4().hex)
    try:
        temporary.symlink_to(path.name)
        temporary.replace(current)
    finally:
        temporary.unlink(missing_ok=True)


def prepare_capture(existing=False):
    """Caller holds the host backup lock; retain at most one pending capture."""
    STAGING_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    current = STAGING_ROOT / "current"
    requested = current.resolve() if existing and (current.exists() or current.is_symlink()) else None
    if requested and (requested.parent != STAGING_ROOT or not capture_manifest(requested)):
        raise RuntimeError("No completed current capture available")
    completed = []
    for path in STAGING_ROOT.iterdir():
        if path.is_symlink() or not path.is_dir():
            continue
        if path.name != "current" and not re.fullmatch(r"capture-\d{8}T\d{6}Z", path.name):
            continue
        manifest = capture_manifest(path)
        if manifest:
            completed.append((manifest["completed_utc"], path))
        else:
            shutil.rmtree(path)
    pending = [(stamp, path) for stamp, path in completed if not (path / ".uploaded").exists()]
    candidates = completed if existing else pending
    keep = requested or (max(candidates)[1] if candidates else None)
    if existing and keep is None:
        raise RuntimeError("No completed current capture available")
    # A successful cloud point remains off-host; local staging is not retention.
    for _, path in completed:
        if path != keep:
            shutil.rmtree(path)
    if current.is_symlink() and not current.exists():
        current.unlink()
    if keep:
        publish_current(keep)
    return keep


def complete_capture(path):
    path = path.resolve()
    manifest = capture_manifest(path)
    if path.parent != STAGING_ROOT or not manifest:
        raise RuntimeError("Unexpected completed capture")
    (path / ".uploaded").touch(mode=0o600)
    return manifest["completed_utc"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["inventory", "capture", "prepare", "complete"])
    parser.add_argument("destination", nargs="?")
    arguments = parser.parse_args()
    os.umask(0o077)
    if arguments.command == "prepare":
        if arguments.destination not in (None, "existing"):
            parser.error("prepare accepts only the optional existing selector")
        pending = prepare_capture(existing=arguments.destination == "existing")
        print(pending or "")
        return
    if arguments.command == "complete":
        if not arguments.destination:
            parser.error("complete requires a capture directory")
        print(complete_capture(Path(arguments.destination)))
        return
    selections = roots()
    counts = []
    for source, target, repository in selections:
        files = list(entries(source, repository))
        counts.append({"source": str(source), "target": str(target),
                       "entries": len(files), "bytes": sum(p.lstat().st_size for p, _ in files if p.is_file() and not p.is_symlink())})
    if arguments.command == "inventory":
        print(json.dumps({"roots": counts, "postgres": POSTGRES, "external_disks_included": False}, indent=2))
        return
    if not arguments.destination:
        parser.error("capture requires a new destination below /var/lib/homelab-app-backup")
    destination = Path(arguments.destination).resolve()
    if not destination.is_relative_to(STAGING_ROOT) or destination == STAGING_ROOT or destination.exists():
        parser.error("destination must be a new child directory of the staging root")
    STAGING_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    required = sum(item["bytes"] for item in counts)
    if shutil.disk_usage(STAGING_ROOT).free < required * 2 + 2 * 1024**3:
        raise RuntimeError("Insufficient staging headroom")
    destination.mkdir(mode=0o700)
    try:
        manifest = {"format": 1, "started_utc": datetime.now(timezone.utc).isoformat(),
                    "roots": counts, "sqlite": {}, "exclusions": list(SKIP_PREFIXES),
                    "external_disks_included": False, "cross_application_consistency": False}
        for source, target, repository in selections:
            copy_entry(source, destination / target)
            for path, relative in entries(source, repository):
                database_result = copy_entry(path, destination / target / relative)
                if database_result:
                    manifest["sqlite"][str(target / relative)] = database_result
        manifest["postgres"] = postgres_exports(destination)
        manifest["completed_utc"] = datetime.now(timezone.utc).isoformat()
        (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        publish_current(destination)
        print(f"Application capture completed: {len(manifest['sqlite'])} SQLite databases, {len(manifest['postgres'])} PostgreSQL databases")
    except BaseException:
        shutil.rmtree(destination)
        raise


if __name__ == "__main__":
    main()
