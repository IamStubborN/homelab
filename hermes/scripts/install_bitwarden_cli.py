#!/usr/bin/env python3
"""Install the latest standalone Bitwarden Password Manager CLI."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import platform
import shutil
import stat
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path


def latest_asset() -> tuple[str, str, str]:
    request = urllib.request.Request(
        "https://api.github.com/repos/bitwarden/clients/releases?per_page=100",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "hermes-home"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, list):
        raise RuntimeError("Bitwarden release response is invalid")
    architecture = "arm64" if platform.machine() in {"aarch64", "arm64"} else "amd64"
    name_prefix = "bw-linux-arm64-" if architecture == "arm64" else "bw-linux-"
    for release in payload:
        tag = str(release.get("tag_name", "")) if isinstance(release, dict) else ""
        if tag.startswith("cli-v"):
            version = tag.removeprefix("cli-v")
            for asset in release.get("assets", []):
                name = str(asset.get("name", "")) if isinstance(asset, dict) else ""
                if name != f"{name_prefix}{version}.zip":
                    continue
                digest = str(asset.get("digest", ""))
                url = str(asset.get("browser_download_url", ""))
                if digest.startswith("sha256:") and url.startswith("https://"):
                    return version, url, digest.removeprefix("sha256:")
            raise RuntimeError("Bitwarden CLI asset metadata is incomplete")
    raise RuntimeError("Bitwarden CLI release was not found")


def main() -> None:
    destination = Path(sys.argv[1])
    version_file = destination.with_suffix(".version")
    try:
        version, url, expected_digest = latest_asset()
    except Exception:
        if destination.is_file():
            return
        raise
    if (
        destination.is_file()
        and version_file.is_file()
        and version_file.read_text(encoding="utf-8").strip() == version
    ):
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent) as directory:
        archive = Path(directory) / "bw.zip"
        urllib.request.urlretrieve(url, archive)
        actual_digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        if not hmac.compare_digest(actual_digest, expected_digest):
            raise RuntimeError("Bitwarden CLI checksum mismatch")
        with zipfile.ZipFile(archive) as zipped:
            zipped.extract("bw", directory)
        temporary = destination.with_suffix(".tmp")
        shutil.copy2(Path(directory) / "bw", temporary)
        temporary.chmod(temporary.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        os.replace(temporary, destination)
        version_file.write_text(version + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
