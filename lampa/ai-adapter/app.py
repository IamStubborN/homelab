#!/usr/bin/env python3
"""Compatibility adapter for Lampa's built-in AI routes."""

import json
import os
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


CLI_PROXY_BASE = os.environ.get("CLI_PROXY_BASE", "http://cli-proxy-api:8317/v1").rstrip("/")
CLI_PROXY_KEY_FILE = os.environ.get("CLI_PROXY_KEY_FILE", "/run/secrets/cliproxy_api_key")
MODEL = os.environ.get("CLI_PROXY_MODEL", "gpt-5.6-luna")
TMDB_BASE = os.environ.get("TMDB_BASE", "http://lampa:9118/tmdb/api/3").rstrip("/")
TMDB_API_KEY_FILE = os.environ.get("TMDB_API_KEY_FILE", "/run/secrets/tmdb_api_key")
LAMPAC_FALLBACK_BASE = os.environ.get("LAMPAC_FALLBACK_BASE", "http://lampa:9118").rstrip("/")
HTTP_TIMEOUT = float(os.environ.get("HTTP_TIMEOUT", "55"))

TLS_CONTEXT = ssl.create_default_context()


def json_response(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def http_json(url, *, method="GET", payload=None, headers=None):
    data = None
    request_headers = {"Accept": "application/json"}
    if headers:
        request_headers.update(headers)
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT, context=TLS_CONTEXT) as response:
        return json.loads(response.read().decode("utf-8"))


def cliproxy_key():
    with open(CLI_PROXY_KEY_FILE, "r", encoding="utf-8") as key_file:
        return key_file.read().strip()


def tmdb_key():
    with open(TMDB_API_KEY_FILE, "r", encoding="utf-8") as key_file:
        return key_file.read().strip()


def completion(system_prompt, user_prompt, *, max_tokens=1400):
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.2,
        "max_tokens": max_tokens,
        "reasoning_effort": "medium",
    }
    headers = {"Authorization": "Bearer " + cliproxy_key()}
    try:
        result = http_json(CLI_PROXY_BASE + "/chat/completions", method="POST", payload=payload, headers=headers)
    except urllib.error.HTTPError as error:
        if error.code != 400:
            raise
        payload.pop("reasoning_effort", None)
        result = http_json(CLI_PROXY_BASE + "/chat/completions", method="POST", payload=payload, headers=headers)
    return result["choices"][0]["message"]["content"]


def parse_json(text):
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"(\{.*\}|\[.*\])", cleaned, re.DOTALL)
        if not match:
            raise
        return json.loads(match.group(1))


def tmdb(path, **params):
    params = {"api_key": tmdb_key(), **params}
    url = TMDB_BASE + path + "?" + urllib.parse.urlencode(params)
    return http_json(url)


def card_from_tmdb(item, media_type=None):
    card = dict(item)
    kind = media_type or card.get("media_type")
    if kind not in ("movie", "tv"):
        kind = "tv" if card.get("name") else "movie"
    card["media_type"] = kind
    return card


def resolve_candidate(candidate, required_type=None):
    if not isinstance(candidate, dict):
        return None
    title = str(candidate.get("title", "")).strip()
    if not title:
        return None
    candidate_type = candidate.get("type")
    if candidate_type not in ("movie", "tv"):
        candidate_type = required_type
    try:
        found = tmdb("/search/multi", query=title, language="ru-RU", include_adult="false").get("results", [])
    except Exception:
        return None
    for item in found:
        if item.get("media_type") not in ("movie", "tv"):
            continue
        if candidate_type and item["media_type"] != candidate_type:
            continue
        return card_from_tmdb(item)
    return None


def resolve_candidates(candidates, required_type=None):
    with ThreadPoolExecutor(max_workers=4) as executor:
        resolved = executor.map(lambda item: resolve_candidate(item, required_type), candidates[:8])
    results = []
    seen = set()
    for card in resolved:
        if not card:
            continue
        identity = (card.get("media_type"), card.get("id"))
        if identity in seen:
            continue
        seen.add(identity)
        results.append(card)
    return results[:8]


def search_cards(query):
    instruction = (
        "Return only JSON, an array of up to 8 objects with keys title and type. "
        "type must be movie or tv. Find films and series matching the user's natural-language request. "
        "Do not invent IDs and do not include explanations."
    )
    raw = completion(instruction, query, max_tokens=900)
    candidates = parse_json(raw)
    return {"results": resolve_candidates(candidates if isinstance(candidates, list) else [])}


def card_details(card_id, card_type):
    details = tmdb("/" + ("tv" if card_type == "tv" else "movie") + "/" + urllib.parse.quote(card_id), language="ru-RU")
    details["media_type"] = card_type
    return details


def facts(card_id, card_type):
    details = card_details(card_id, card_type)
    prompt = "Summarize the most interesting facts about this title in Russian as concise Markdown. Do not claim uncertain facts.\n" + json.dumps(details, ensure_ascii=False)
    return {"text": completion("You are a careful film guide. Return only the Markdown answer.", prompt, max_tokens=1000)}


def recommendations(card_id, card_type):
    details = card_details(card_id, card_type)
    prompt = (
        "Return only JSON, an array of up to 8 objects with keys title and type. "
        "Recommend similar films or series. type must be movie or tv. Do not include explanations.\n"
        + json.dumps(details, ensure_ascii=False)
    )
    candidates = parse_json(completion("You are a film recommendation engine.", prompt, max_tokens=900))
    return {"results": resolve_candidates(candidates if isinstance(candidates, list) else [])}


class Handler(BaseHTTPRequestHandler):
    server_version = "LampaAIAdapter/1.0"

    def log_message(self, format, *args):
        # Do not log prompts, responses, or authorization material.
        return

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        try:
            if path == "/health":
                return json_response(self, 200, {"status": "ok", "model": MODEL})
            if path.startswith("/ai/search/"):
                query = urllib.parse.unquote(path.removeprefix("/ai/search/"))
                return json_response(self, 200, search_cards(query))
            match = re.fullmatch(r"/ai/generate/(facts|recommend)/([^/]+)/([^/]+)", path)
            if match:
                operation, card_id, card_type = match.groups()
                result = facts(card_id, card_type) if operation == "facts" else recommendations(card_id, card_type)
                return json_response(self, 200, result)
            return json_response(self, 404, {})
        except Exception:
            # Keep the original Lampac/CUB implementation available when the
            # local adapter or CLIProxy is temporarily unavailable.
            try:
                fallback = http_json(LAMPAC_FALLBACK_BASE + path)
                return json_response(self, 200, fallback)
            except Exception:
                return json_response(self, 502, {"status": 502, "message": "AI backend unavailable"})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
