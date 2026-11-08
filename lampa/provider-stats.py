#!/usr/bin/env python3
"""Per-provider health of Lampac online sources, from Traefik's access log.

`collect` reads new `/lite/<provider>` requests from `docker logs traefik` and
adds them to daily counters. Only provider names and numbers are stored: no
paths, queries, addresses or identities. `report` prints the last days and
names the providers that mostly fail or answer slowly, as candidates to
disable in Lampac's init.conf.

    provider-stats.py collect [--state FILE]
    provider-stats.py report [--state FILE] [--days 7]
"""
import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys

ROOT = os.environ.get("LAMPA_ROOT", "/opt/homelab")
STATE = os.path.join(ROOT, "lampa", "cache", "provider-stats.json")
KEEP_DAYS = 60
SLOW_MS = 8000          # the picker gives up on a catalog page after 8 s
EMPTY_BYTES = 300       # an answer this small carries no voices or stream
PATH = re.compile(r"^/lite/([a-z0-9_.-]{1,40})(/[^?]*)?(?:\?|$)", re.I)
SKIP = {"events", "lifeevents"}


def load(path):
    try:
        with open(path) as handle:
            state = json.load(handle)
        if isinstance(state, dict) and isinstance(state.get("days"), dict):
            if state.get("version") != 2:
                state["version"], state["last"] = 2, ""  # the old StartUTC cursor is not a write time
            return state
    except (OSError, ValueError):
        pass
    return {"version": 2, "last": "", "days": {}}


def save(path, state):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = path + ".tmp"
    with open(temporary, "w") as handle:
        json.dump(state, handle, separators=(",", ":"), sort_keys=True)
    os.replace(temporary, path)


# `docker logs --timestamps` prefixes each line with the time Docker wrote it, in a
# fixed-width RFC 3339 form. That is the cursor: it grows in write order, while
# StartUTC (trimmed by Go, and earlier for slow requests) does not.
WRITTEN = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z) (\{.*)$")


def records(lines):
    for line in lines:
        match = WRITTEN.match(line)
        if not match or '"/lite/' not in match.group(2):
            continue
        try:
            entry = json.loads(match.group(2))
        except ValueError:
            continue
        path = PATH.match(str(entry.get("RequestPath", "")))
        start = str(entry.get("StartUTC", ""))
        if not path or not re.match(r"^\d{4}-\d{2}-\d{2}", start) or path.group(1).lower() in SKIP:
            continue
        yield {
            "written": match.group(1),
            "start": start,
            "provider": path.group(1).lower(),
            "kind": "video" if path.group(2) and path.group(2) != "/" else "catalog",
            "status": int(entry.get("DownstreamStatus") or 0),
            "ms": int(entry.get("Duration") or 0) // 1_000_000,
            "bytes": int(entry.get("DownstreamContentSize") or 0),
        }


def add(state, record):
    day = record["start"][:10]
    bucket = state["days"].setdefault(day, {}).setdefault(record["provider"], {})
    counter = bucket.setdefault(record["kind"], {"n": 0, "fail": 0, "empty": 0, "slow": 0, "ms": 0})
    counter["n"] += 1
    counter["ms"] += record["ms"]
    if record["status"] >= 400 or record["status"] == 0:
        counter["fail"] += 1
    elif record["bytes"] < EMPTY_BYTES:
        counter["empty"] += 1
    if record["ms"] >= SLOW_MS:
        counter["slow"] += 1


def collect(state, lines):
    last, newest, added = state.get("last", ""), state.get("last", ""), 0
    for record in records(lines):
        if record["written"] <= last:
            continue
        add(state, record)
        added += 1
        newest = max(newest, record["written"])
    state["last"] = newest
    cutoff = (dt.date.today() - dt.timedelta(days=KEEP_DAYS)).isoformat()
    for day in [day for day in state["days"] if day < cutoff]:
        del state["days"][day]
    return added


def summary(state, days):
    cutoff = (dt.date.today() - dt.timedelta(days=days - 1)).isoformat()
    total = {}
    for day, providers in state["days"].items():
        if day < cutoff:
            continue
        for provider, kinds in providers.items():
            for kind, counter in kinds.items():
                into = total.setdefault((provider, kind), {"n": 0, "fail": 0, "empty": 0, "slow": 0, "ms": 0})
                for key in into:
                    into[key] += counter.get(key, 0)
    return total


def verdict(counter):
    n = counter["n"]
    if n < 5:
        return ""
    if counter["fail"] / n >= 0.5:
        return "отключить: чаще ошибается"
    if counter["slow"] / n >= 0.5:
        return "отключить: слишком медленный"
    if (counter["fail"] + counter["empty"]) / n >= 0.8:
        return "проверить: почти всегда пусто"
    return ""


def report(state, days, out=sys.stdout):
    total = summary(state, days)
    if not total:
        print(f"За {days} дн. запросов к источникам нет.", file=out)
        return
    rows = sorted(total.items(), key=lambda item: (not verdict(item[1]), -(item[1]["fail"] + item[1]["slow"]) / item[1]["n"], item[0]))
    print(f"Источники Lampac за {days} дн.", file=out)
    print(f"{'источник':20} {'вид':8} {'запр.':>6} {'ошиб.':>6} {'пусто':>6} {'медл.':>6} {'сред. мс':>9}  вывод", file=out)
    for (provider, kind), counter in rows:
        average = counter["ms"] // counter["n"]
        print(f"{provider:20} {kind:8} {counter['n']:6} {counter['fail']:6} {counter['empty']:6} {counter['slow']:6} {average:9}  {verdict(counter)}", file=out)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["collect", "report"])
    parser.add_argument("--state", default=STATE)
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--container", default="traefik")
    args = parser.parse_args(argv)
    state = load(args.state)
    if args.command == "collect":
        since = state.get("last") or "72h"
        logs = subprocess.run(["docker", "logs", "--timestamps", "--since", since, args.container], capture_output=True, text=True, check=True)
        added = collect(state, (logs.stdout + "\n" + logs.stderr).splitlines())
        save(args.state, state)
        print(f"added {added}")
    else:
        report(state, max(1, args.days))


if __name__ == "__main__":
    main()
