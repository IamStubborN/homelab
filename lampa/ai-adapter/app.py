#!/usr/bin/env python3
"""Compatibility adapter for Lampa's built-in AI routes."""

import json
import os
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


CLI_PROXY_BASE = os.environ.get("CLI_PROXY_BASE", "http://cli-proxy-api:8317/v1").rstrip("/")
CLI_PROXY_KEY_FILE = os.environ.get("CLI_PROXY_KEY_FILE", "/run/secrets/cliproxy_api_key")
MODEL = os.environ.get("CLI_PROXY_MODEL", "gpt-6-luna")
TMDB_BASE = os.environ.get("TMDB_BASE", "http://lampa:9118/tmdb/api/3").rstrip("/")
TMDB_API_KEY_FILE = os.environ.get("TMDB_API_KEY_FILE", "/run/secrets/tmdb_api_key")
TAVILY_API_KEY_FILE = os.environ.get("TAVILY_API_KEY_FILE", "/run/secrets/tavily_api_key")
LAMPAC_FALLBACK_BASE = os.environ.get("LAMPAC_FALLBACK_BASE", "http://lampa:9118").rstrip("/")
HTTP_TIMEOUT = float(os.environ.get("HTTP_TIMEOUT", "55"))

TLS_CONTEXT = ssl.create_default_context()
TITLE_FIELDS = ("name", "title", "original_name", "original_title")


def json_response(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def http_json(url, *, method="GET", payload=None, headers=None, timeout=HTTP_TIMEOUT):
    data = None
    request_headers = {"Accept": "application/json"}
    if headers:
        request_headers.update(headers)
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout, context=TLS_CONTEXT) as response:
        return json.loads(response.read().decode("utf-8"))


def cliproxy_key():
    with open(CLI_PROXY_KEY_FILE, "r", encoding="utf-8") as key_file:
        return key_file.read().strip()


def tmdb_key():
    with open(TMDB_API_KEY_FILE, "r", encoding="utf-8") as key_file:
        return key_file.read().strip()


def completion(system_prompt, user_prompt, *, max_tokens=1400, timeout=HTTP_TIMEOUT):
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
        result = http_json(CLI_PROXY_BASE + "/chat/completions", method="POST", payload=payload, headers=headers, timeout=timeout)
    except urllib.error.HTTPError as error:
        if error.code != 400:
            raise
        payload.pop("reasoning_effort", None)
        result = http_json(CLI_PROXY_BASE + "/chat/completions", method="POST", payload=payload, headers=headers, timeout=timeout)
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


def tmdb(path, *, timeout=HTTP_TIMEOUT, **params):
    params = {"api_key": tmdb_key(), **params}
    url = TMDB_BASE + path + "?" + urllib.parse.urlencode(params)
    return http_json(url, timeout=timeout)


def card_from_tmdb(item, media_type=None):
    card = dict(item)
    kind = media_type or card.get("media_type")
    if kind not in ("movie", "tv"):
        kind = "tv" if card.get("name") else "movie"
    card["media_type"] = kind
    return card


def tmdb_titles(query, lookup):
    results = lookup("/search/multi", query=query, language="ru-RU", include_adult="false").get("results")
    if not isinstance(results, list):
        return []
    return [item for item in results if isinstance(item, dict) and item.get("media_type") in ("movie", "tv")]


def resolve_candidate(candidate, required_type=None, *, lookup=None, strict_title=False):
    if not isinstance(candidate, dict):
        return None
    lookup = lookup or tmdb
    title = candidate.get("title") or ""
    if not isinstance(title, str):
        return None
    title = title.strip()[:200]
    candidate_type = candidate.get("type")
    if candidate_type not in ("movie", "tv"):
        candidate_type = required_type
    imdb_id = candidate.get("imdb_id")
    tmdb_id = candidate.get("tmdb_id")
    if strict_title and isinstance(imdb_id, str) and re.fullmatch(r"tt\d{7,12}", imdb_id):
        found = lookup("/find/" + imdb_id, external_source="imdb_id", language="ru-RU")
        items = []
        for kind in ("movie", "tv"):
            hits = found.get(kind + "_results")
            if isinstance(hits, list):
                items.extend(card_from_tmdb(item, kind) for item in hits if isinstance(item, dict))
    elif strict_title and type(tmdb_id) is int and tmdb_id > 0 and candidate_type in ("movie", "tv"):
        item = lookup(f"/{candidate_type}/{tmdb_id}", language="ru-RU")
        items = [card_from_tmdb(item, candidate_type)] if item.get("id") == tmdb_id else []
    elif title:
        items = tmdb_titles(title, lookup)
    else:
        return None
    matching = [item for item in items if matches_criteria(item, candidate_type, candidate.get("year"))]
    if not title:
        return next(iter(matching), None)
    phrase = title_words(title)
    by_name = next((item for item in matching if has_title_phrase(item, phrase)), None)
    return by_name if strict_title else by_name or next(iter(matching), None)


def resolve_candidates(candidates, required_type=None, *, lookup=None, strict_title=False):
    with ThreadPoolExecutor(max_workers=4) as executor:
        resolved = executor.map(lambda item: resolve_candidate(item, required_type, lookup=lookup, strict_title=strict_title), candidates[:8])
    return unique_cards(resolved)


def unique_cards(cards):
    results = []
    seen = set()
    for card in cards:
        if not card or type(card.get("id")) is not int or card["id"] <= 0:
            continue
        identity = (card.get("media_type"), card.get("id"))
        if identity in seen:
            continue
        seen.add(identity)
        results.append(card)
    return results[:8]


def title_words(text):
    if not isinstance(text, str):
        return []
    return re.findall(r"[^\W_]+", text.casefold().replace("ё", "е"))


def has_title_phrase(item, phrase):
    if not phrase:
        return False
    for field in TITLE_FIELDS:
        words = title_words(item.get(field) or "")
        if len(words) <= len(phrase) + 1 and f" {' '.join(phrase)} " in f" {' '.join(words)} ":
            return True
    return False


def matches_criteria(item, kind, year):
    date = item.get("release_date") or item.get("first_air_date") or ""
    return (not kind or item["media_type"] == kind) and (not year or isinstance(date, str) and date[:4] == str(year))


def catalog_title_search(query, phrase, lookup, kind, year):
    def matching_titles(text, words):
        return [item for item in tmdb_titles(text, lookup)
                if matches_criteria(item, kind, year) and has_title_phrase(item, words)]

    matching = matching_titles(query, phrase)
    words = re.findall(r"[^\W_]+", query)
    if matching or not 4 <= len(words) <= 6:
        return unique_cards(matching)

    # An extra word inside a remembered title can prevent a catalog match.
    # Keep the edge words, which can carry the intent of a query.
    variants = list(dict.fromkeys(
        " ".join(words[:index] + words[index + 1:])
        for index in range(1, len(words) - 1)
    ))
    with ThreadPoolExecutor(max_workers=4) as executor:
        groups = executor.map(lambda text: matching_titles(text, title_words(text)), variants)
        matches = unique_cards(item for found in groups for item in found)
    return matches if len(matches) == 1 else []


def web_candidates(query, timeout):
    with open(TAVILY_API_KEY_FILE, "r", encoding="utf-8") as key_file:
        key = key_file.read().strip()
    if not key:
        return []
    response = http_json(
        "https://api.tavily.com/search", method="POST", timeout=timeout,
        headers={"Authorization": "Bearer " + key},
        payload={"query": query[:240], "search_depth": "basic", "max_results": 5,
                 "include_answer": False, "include_raw_content": False},
    )
    hits = response.get("results") if isinstance(response, dict) else None
    if not isinstance(hits, list):
        return []
    candidates = []
    for hit in hits[:5]:
        if not isinstance(hit, dict):
            continue
        url_text = hit.get("url")
        if not isinstance(url_text, str):
            continue
        try:
            url = urllib.parse.urlsplit(url_text)
        except ValueError:
            continue
        imdb = re.match(r"^/title/(tt\d{7,12})(?:/|$)", url.path)
        tmdb_id = re.match(r"^/(movie|tv)/(\d{1,10})(?:[-/]|$)", url.path)
        if imdb and url.hostname in ("imdb.com", "www.imdb.com"):
            candidates.append({"imdb_id": imdb[1]})
        elif tmdb_id and url.hostname in ("themoviedb.org", "www.themoviedb.org"):
            candidates.append({"type": tmdb_id[1], "tmdb_id": int(tmdb_id[2])})
        else:
            title = hit.get("title")
            if not isinstance(title, str):
                continue
            title = re.split(r"\s+[|–—-]\s+|\s+(?:на русском|смотреть онлайн)\b", title, maxsplit=1, flags=re.I)[0]
            qualifier = r"(?:film|movie|TV (?:series|show)|anime|фильм|сериал)"
            suffix = re.search(rf"\s*\((?:(\d{{4}})(?:\s+{qualifier})?|{qualifier})\)\s*$", title, re.I)
            candidates.append({"title": title[:suffix.start()] if suffix else title,
                               "year": int(suffix[1]) if suffix and suffix[1] else None})
    return candidates


def search_cards(query):
    instruction = (
        'Return only a JSON object with keys intent, type, year, exclude, candidates, web_query. '
        'intent is "identify" for a remembered title, plot, or character, or "recommend" for a selection. '
        'Set top-level type (movie or tv) and year only for explicit restrictions, otherwise null. '
        'List excluded titles in exclude, including translated or original aliases you know. '
        'Offer up to 8 likely candidates with title, type and optional year, preserving the user’s clues. '
        'Write one short web_query in the user’s language from distinctive plot, title, cast or year clues; '
        'do not replace those clues with your guesses. Give an empty web_query if the request only excludes titles. '
        'Do not invent IDs or add explanations.'
    )
    deadline = time.monotonic() + 50

    def remaining(limit):
        seconds = deadline - time.monotonic()
        if seconds <= 0:
            raise TimeoutError("Lampa search deadline")
        return min(limit, seconds)

    def lookup(path, **params):
        return tmdb(path, timeout=remaining(5), **params)

    def lookup_web(path, **params):
        try:
            result = lookup(path, **params)
            return result if isinstance(result, dict) else {}
        except (OSError, ValueError):
            return {}

    plan = parse_json(completion(instruction, query, max_tokens=900, timeout=remaining(20)))
    if isinstance(plan, list):
        plan = {"candidates": plan}
    if not isinstance(plan, dict):
        plan = {}
    kind = plan.get("type") if plan.get("type") in ("movie", "tv") else None
    year = plan.get("year") if type(plan.get("year")) is int else None
    exclude = plan.get("exclude")
    excluded = set()
    if isinstance(exclude, list):
        for title in exclude[:16]:
            if isinstance(title, str) and (words := title_words(title)):
                excluded.add(tuple(words))
    suffix = re.search(r"\b(?:кроме|за исключением|except|excluding)\s+(.+)$", query, re.I)
    if suffix and (words := title_words(suffix[1])):
        excluded.add(tuple(words))

    def eligible(cards):
        return [card for card in cards if matches_criteria(card, kind, year) and all(
            tuple(title_words(card.get(field) or "")) not in excluded
            for field in TITLE_FIELDS
        )]

    phrase = title_words(query)
    # Keep explicit directional requests off the literal-title path even if an
    # older model answer left out the intent field.
    directions = {"не", "без", "кроме", "исключи", "исключая", "not", "without", "except", "exclude", "excluding"}
    intent = plan.get("intent")
    exclusion_prefix = re.match(r"^\s*(?:исключи(?:те)?|exclude|omit)\s+", query, re.I)
    follow_up = re.search(r"(?:[,;]|\bи\b|\band\b)\s*(?:найди|покажи|подбери|предложи|find|show|recommend)\b", query, re.I)
    if exclusion_prefix and not follow_up:
        return {"results": []}
    recommend = intent == "recommend" or bool(suffix) or bool(exclusion_prefix) or (
        intent != "identify" and not directions.isdisjoint(phrase)
    )
    if not recommend and len(phrase) <= 12:
        title_query = re.sub(r"^\s*(?:фильм|сериал|аниме|movie|film|series|tv show)\s+", "", query, count=1, flags=re.I)
        if year:
            title_query = re.sub(rf"\s*\(?\b{year}\b(?:\s*г(?:ода)?\.?)?\)?\s*$", "", title_query)
        exact = eligible(catalog_title_search(title_query, title_words(title_query), lookup, kind, year))
        if exact:
            return {"results": exact}

    candidates = plan.get("candidates")
    if not isinstance(candidates, list):
        candidates = []
    candidates = [{"title": item.get("title"), "type": kind or item.get("type"), "year": year or item.get("year")}
                  for item in candidates[:8] if isinstance(item, dict)]
    results = eligible(resolve_candidates(candidates, lookup=lookup))
    if results and recommend:
        return {"results": results}
    web_query = plan.get("web_query")
    if recommend and not web_query:
        return {"results": results}
    if not isinstance(web_query, str) or not web_query.strip():
        web_query = query + " film or TV title"

    try:
        web = web_candidates(web_query, remaining(6))
        if kind:
            web = [candidate for candidate in web if candidate.get("type") in (None, kind)]
        web = [{**candidate, "type": kind or candidate.get("type"), "year": year or candidate.get("year")}
               for candidate in web]
        verified = eligible(resolve_candidates(web, lookup=lookup_web, strict_title=True))
    except (OSError, ValueError, TypeError):
        return {"results": results}
    return {"results": unique_cards(verified + results)}


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
                fallback = http_json(LAMPAC_FALLBACK_BASE + path, timeout=5 if path.startswith("/ai/search/") else HTTP_TIMEOUT)
                return json_response(self, 200, fallback)
            except Exception:
                return json_response(self, 502, {"status": 502, "message": "AI backend unavailable"})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
