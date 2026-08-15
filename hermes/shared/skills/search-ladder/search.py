#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import sys
import urllib.request

URL = "http://search-ladder:8080/v1/research"
KEY_PATH = Path("/run/hermes-home-secrets/search_ladder_api_key")


def research(query=None, url=None, focus=None, mode="research", limit=5, pages=3, opener=urllib.request.urlopen):
    key = KEY_PATH.read_text(encoding="utf-8").strip()
    if not key:
        raise RuntimeError("search-ladder credential is empty")
    body = {"mode": mode, "max_results": limit, "max_pages": pages, "max_chars": 12000}
    if query:
        body["query"] = query
    if url:
        body["url"] = url
    if focus:
        body["focus"] = focus
    request = urllib.request.Request(
        URL,
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    with opener(request, timeout=30) as response:
        return json.load(response)


def render(payload):
    lines = [f"Mode: {payload.get('mode', 'research')}"]
    if provider := payload.get("provider"):
        lines[0] += f" · Search provider: {provider}"
    if summary := payload.get("summary"):
        lines.append(f"\n{' '.join(summary.split())}")
    if payload.get("mode") != "research":
        for index, result in enumerate(payload.get("results") or [], 1):
            lines.append(f"{index}. {result.get('title') or result.get('url', '')}\n   {result.get('url', '')}")
    for item in payload.get("evidence") or []:
        lines.append(f"\n{item.get('source_id')}: {item.get('title') or item.get('final_url', '')}")
        if summary := item.get("summary"):
            lines.append(f"   Summary: {' '.join(summary.split())}")
        for excerpt in item.get("excerpts") or []:
            lines.append(f"   > {' '.join(excerpt.split())}")
        lines.append(f"   Source: {item.get('final_url', '')}")
    if len(lines) == 1:
        raise RuntimeError("research pipeline returned no results")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Run the shared adaptive search-ladder pipeline")
    parser.add_argument("query", nargs="?")
    parser.add_argument("--url")
    parser.add_argument("--focus")
    parser.add_argument("--mode", choices=("raw", "summary", "research"), default="research")
    parser.add_argument("--limit", type=int, choices=range(1, 11), default=5)
    parser.add_argument("--pages", type=int, choices=range(1, 6), default=3)
    args = parser.parse_args()
    if bool(args.query) == bool(args.url):
        parser.error("provide exactly one of query or --url")
    try:
        print(render(research(args.query, args.url, args.focus, args.mode, args.limit, args.pages)))
        return 0
    except Exception:
        print("web research unavailable", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
