#!/usr/bin/env python3
"""Capture host recovery files and inventory without changing host state."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


PATHS = [
    "etc/pve", "etc/network", "etc/hosts", "etc/hostname", "etc/resolv.conf",
    "etc/fstab", "etc/vzdump.conf", "etc/apt", "etc/default", "etc/kernel",
    "etc/modprobe.d", "etc/modules", "etc/modules-load.d", "etc/sysctl.conf",
    "etc/sysctl.d", "etc/udev/rules.d", "etc/systemd/system",
    "etc/systemd/journald.conf.d", "etc/ssh/ssh_config", "etc/ssh/ssh_config.d",
    "etc/ssh/sshd_config", "etc/ssh/sshd_config.d", "root/.ssh/authorized_keys",
    "root/.ssh/config", "root/.ssh/known_hosts",
    "usr/local/sbin/homelab-backup-to-google-drive",
    "usr/local/libexec/homelab-opnsense-config-backup",
    "usr/local/libexec/homelab-host-config-backup",
    "usr/local/libexec/homelab-backup-monitor", "etc/homelab-backup/monitor.json",
    "usr/local/sbin/homelab-backup-apps-to-pbs", "usr/local/sbin/homelab-pbs-cloud",
    "usr/local/sbin/homelab-pbs-guests", "usr/local/sbin/proxmox-cpu-quiet.sh",
    "usr/local/sbin/homelab-pbs-maintenance", "usr/local/libexec/homelab-recovery",
    "etc/crontab", "etc/cron.d", "var/spool/cron/crontabs",
]
COMMANDS = {
    "proxmox-version.txt": ["pveversion", "--verbose"],
    "packages.txt": ["dpkg-query", "-W", "-f=${binary:Package}\t${Version}\n"],
    "block-devices.json": ["lsblk", "--json", "--bytes", "-O"],
    "filesystem-identifiers.txt": ["blkid"],
    "mounts.json": ["findmnt", "--json", "-o", "TARGET,SOURCE,FSTYPE,OPTIONS"],
    "physical-volumes.json": ["pvs", "--reportformat", "json"],
    "volume-groups.json": ["vgs", "--reportformat", "json"],
    "logical-volumes.json": ["lvs", "-a", "--reportformat", "json", "-o", "+devices"],
    "network-links.json": ["ip", "-json", "-details", "link", "show"],
    "network-addresses.json": ["ip", "-json", "address", "show"],
    "network-routes.json": ["ip", "-json", "route", "show", "table", "all"],
    "bridge-links.json": ["bridge", "-json", "link", "show"],
    "storage-status.txt": ["pvesm", "status"],
    "virtual-machines.txt": ["qm", "list"],
    "containers.txt": ["pct", "list"],
    "boot-tool.txt": ["proxmox-boot-tool", "status"],
    "kernel.txt": ["uname", "-a"],
    "cpu.txt": ["lscpu"],
}


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: host-config-backup.py ARCHIVE.tar.zst")
    os.umask(0o077)
    archive = Path(sys.argv[1]).resolve()
    if archive.exists():
        raise SystemExit("Refusing to overwrite an existing archive")
    required = ["etc/pve", "etc/fstab", "etc/network/interfaces",
                "usr/local/sbin/homelab-backup-to-google-drive"]
    for name in required:
        if not Path("/", name).exists():
            raise SystemExit(f"Missing required recovery file: {name}")

    with tempfile.TemporaryDirectory(prefix="homelab-host-config-") as staging:
        inventory = Path(staging, "recovery-inventory")
        inventory.mkdir(mode=0o700)
        results = {}
        for filename, command in COMMANDS.items():
            result = subprocess.run(command, capture_output=True, timeout=45)
            (inventory / filename).write_bytes(result.stdout + result.stderr)
            results[filename] = {"command": command, "exit_code": result.returncode}
            if result.returncode and filename != "boot-tool.txt":
                raise RuntimeError(f"Inventory command failed: {filename}")

        selected = [name for name in PATHS if Path("/", name).exists()]
        (inventory / "manifest.json").write_text(json.dumps({
            "format": 1,
            "created_utc": subprocess.check_output(["date", "-u", "+%FT%TZ"], text=True).strip(),
            "boot_mode": "UEFI" if Path("/sys/firmware/efi").exists() else "BIOS",
            "included_paths": selected,
            "missing_optional_paths": [name for name in PATHS if name not in selected],
            "commands": results,
            "excluded_credentials": ["root/.config/rclone/rclone.conf", "private SSH keys",
                                     "etc/homelab-backup/telegram.json"],
        }, indent=2) + "\n")
        subprocess.run([
            "tar", "--acls", "--numeric-owner", "-I", "zstd -T1 -3", "-cf", str(archive),
            "-C", "/", *selected, "-C", staging, "recovery-inventory",
        ], check=True)
    subprocess.run(["zstd", "-tq", str(archive)], check=True)
    print(f"Host recovery archive validated: {archive.name} ({archive.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
