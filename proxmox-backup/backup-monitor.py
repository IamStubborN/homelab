#!/usr/bin/env python3
"""Report backup failures/staleness and recovery to the owner's private chat."""

from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.request

STATE = Path("/var/lib/homelab-backup-monitor")
CONFIG = Path("/etc/homelab-backup")


def load(path, default):
    return json.loads(path.read_text()) if path.exists() else default


def save(path, value):
    temporary = path.with_suffix(".new")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def telegram(method, payload):
    credentials = load(CONFIG / "telegram.json", {})
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{credentials['token']}/{method}",
        data=json.dumps({"chat_id": credentials["chat_id"], **payload}).encode(),
        headers={"Content-Type": "application/json"},
    )
    # Never log exceptions containing the request URL: it contains the bot token.
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            result = json.load(response)
        if not result.get("ok"):
            raise RuntimeError("Telegram rejected request")
        return result["result"]
    except Exception:
        raise RuntimeError("Telegram delivery failed; credentials omitted") from None


def send(message):
    chat = telegram("getChat", {})
    expected = str(load(CONFIG / "telegram.json", {})["chat_id"])
    if chat.get("type") != "private" or str(chat.get("id")) != expected:
        raise RuntimeError("Refusing delivery outside the configured owner's private chat")
    telegram("sendMessage", {"text": message, "disable_notification": False})


def pbs_issues(settings):
    probe = r'''
import json,os,pathlib,subprocess,sys
cloud=False
for p in pathlib.Path('/proc').glob('[0-9]*/cmdline'):
    try:
        args=p.read_bytes().decode(errors='replace').split('\0')
        if '/usr/local/sbin/pbs-pilot-cloud-backup' in args and pathlib.Path(args[0]).name in ('bash','sh'):
            cloud=True
    except OSError:
        pass
space=os.statvfs(sys.argv[1])
used=100*(space.f_blocks-space.f_bavail)/space.f_blocks
services=subprocess.run(['systemctl','is-active','proxmox-backup','proxmox-backup-proxy'],capture_output=True,text=True).stdout.splitlines()==['active','active']
maintenance=None
if services and not cloud:
    info=json.loads(subprocess.check_output(['proxmox-backup-manager','datastore','show',sys.argv[2],'--output-format','json'],timeout=20))
    maintenance=info.get('maintenance-mode')
print(json.dumps({'used_percent':used,'services':services,'cloud_active':cloud,'maintenance':maintenance}))
'''
    try:
        result = subprocess.run(
            ["pct", "exec", str(settings["ctid"]), "--", "python3", "-c", probe,
             settings["path"], settings["datastore"]],
            capture_output=True, text=True, timeout=45, check=True,
        )
        health = json.loads(result.stdout)
    except (subprocess.SubprocessError, ValueError):
        return ["PBS: не удалось проверить состояние сервера и хранилища"]
    issues = []
    threshold = settings.get("max_used_percent", 90)
    if health["used_percent"] >= threshold:
        # Stable text avoids repeated alerts for every small percentage change.
        issues.append(f"PBS: хранилище заполнено на {threshold}% или больше")
    if not health["cloud_active"]:
        if not health["services"]:
            issues.append("PBS: службы резервного копирования не работают")
        if health["maintenance"]:
            issues.append("PBS: хранилище осталось в режиме обслуживания вне облачного копирования")
    return issues


def check():
    config = load(CONFIG / "monitor.json", {})
    records = load(STATE / "jobs.json", {})
    previous = load(STATE / "alerts.json", {"issues": []})
    issues = []
    now = datetime.now(timezone.utc)
    for name, job in config["jobs"].items():
        if records.get(name, {}).get("failed"):
            issues.append(f"{name}: последний запуск завершился ошибкой")
        if job.get("failure_only"):
            continue
        if "success_file" in job:
            try:
                receipt = load(Path(job["success_file"]), {})
                completed = receipt.get("completed_utc")
                stale = not completed or (now - datetime.fromisoformat(completed)).total_seconds() > job["max_age_hours"] * 3600
            except (OSError, ValueError, TypeError):
                issues.append(f"{name}: не удалось проверить результат последнего бэкапа")
                continue
            if stale:
                issues.append(f"{name}: свежая резервная копия отсутствует")
            continue
        try:
            result = subprocess.run(
                ["rclone", "--bind", "0.0.0.0", "lsf", job["remote"],
                 "--files-only", "--include", job["pattern"]],
                capture_output=True, text=True, timeout=90,
            )
        except subprocess.TimeoutExpired:
            issues.append(f"{name}: истекло время проверки Google Drive")
            continue
        if result.returncode:
            issues.append(f"{name}: не удалось проверить копии в Google Drive")
            continue
        timestamps = []
        for filename in result.stdout.splitlines():
            match = re.search(r"(\d{4}_\d{2}_\d{2}-\d{2}_\d{2}_\d{2})", filename)
            if match:
                timestamps.append(datetime.strptime(match[1], "%Y_%m_%d-%H_%M_%S").replace(tzinfo=timezone.utc))
        if not timestamps or (now - max(timestamps)).total_seconds() > job["max_age_hours"] * 3600:
            issues.append(f"{name}: свежая резервная копия отсутствует")
    if config.get("pbs"):
        issues.extend(pbs_issues(config["pbs"]))
    if issues != previous["issues"]:
        if issues:
            send("Бэкапы Homelab: требуется внимание.\n" + "\n".join(issues))
        elif previous["issues"]:
            send("Бэкапы Homelab: работа восстановлена. Свежие копии доступны, зарегистрированные ошибки устранены.")
        save(STATE / "alerts.json", {"issues": issues, "checked_utc": now.isoformat()})
    print(f"Backup monitor checked {len(config['jobs'])} jobs; {len(issues)} issues")


def main():
    os.umask(0o077)
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    recording = len(sys.argv) == 3 and sys.argv[1] == "record"
    # A slow cloud probe must not block the backup unit's ExecStopPost hook.
    lock_name = "jobs.lock" if recording else "lock"
    with (STATE / lock_name).open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if sys.argv[1:] == ["test"]:
            send("Тест уведомлений о бэкапах Homelab. Этот бот будет сообщать об ошибках, отсутствии свежих копий и восстановлении работы. Обычные успешные запуски — без сообщений.")
            print("Test delivered to verified private owner chat")
        elif recording:
            if os.environ.get("EXIT_STATUS") == "75":
                print("Concurrent backup skipped; freshness monitor will check next run")
                return
            records = load(STATE / "jobs.json", {})
            records[sys.argv[2]] = {
                "failed": os.environ.get("SERVICE_RESULT") != "success",
                "recorded_utc": datetime.now(timezone.utc).isoformat(),
            }
            save(STATE / "jobs.json", records)
            # The independent unit performs bounded network checks and retries;
            # the backup unit only records its outcome and queues that check.
            subprocess.run(["systemctl", "start", "--no-block", "homelab-backup-monitor.service"],
                           check=True, timeout=10)
        elif sys.argv[1:] == ["check"]:
            check()
        else:
            raise SystemExit("Usage: backup-monitor.py test|check|record JOB")


if __name__ == "__main__":
    main()
