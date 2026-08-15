"""OmniRoute web search + extract — user plugin for Hermes.

Backed by the household OmniRoute gateway (OpenAI-compatible model gateway
with ``/v1/search`` and ``/v1/web/fetch``). Auth uses the omniroute key
exposed as ``OPENAI_API_KEY`` by the profile entrypoint.

Config keys this provider responds to::

    web:
      search_backend: "search-ladder"
      extract_backend: "search-ladder"

Env vars::

    OMNIROUTE_URL  (defaults to OPENAI_BASE_URL, then config model.base_url)
    OPENAI_API_KEY
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List

from agent.web_search_provider import WebSearchProvider

logger = logging.getLogger(__name__)

# OmniRoute "auto" selection is unreliable; mirror search-ladder's chain.
SEARCH_PROVIDER_CHAIN = ("exa-search", "tavily-search", "firecrawl", "ollama-search")


def _env(name: str) -> str:
    try:
        from hermes_cli.config import get_env_value

        value = get_env_value(name)
    except Exception:
        value = None
    if value is None:
        value = os.getenv(name, "")
    return (value or "").strip()


def _base_url() -> str:
    """Return the OmniRoute origin (without the /v1 suffix)."""
    base = _env("OMNIROUTE_URL") or _env("OPENAI_BASE_URL")
    if not base:
        try:
            from hermes_cli.config import load_config_readonly

            cfg = load_config_readonly() or {}
            base = (cfg.get("model") or {}).get("base_url") or ""
        except Exception:
            base = ""
    base = base.strip().rstrip("/")
    if base.endswith("/v1"):
        base = base[: -len("/v1")]
    return base


class OmniRouteWebSearchProvider(WebSearchProvider):
    """Search + extract through the household OmniRoute gateway."""

    @property
    def name(self) -> str:
        return "search-ladder"

    @property
    def display_name(self) -> str:
        return "Search Ladder"

    def is_available(self) -> bool:
        return bool(_base_url() and _env("OPENAI_API_KEY"))

    def supports_search(self) -> bool:
        return True

    def supports_extract(self) -> bool:
        return True

    def _post(self, path: str, body: Dict[str, Any], timeout: float) -> Dict[str, Any]:
        import httpx

        base = _base_url()
        if not base:
            raise RuntimeError("OMNIROUTE_URL is not set")
        resp = httpx.post(
            f"{base}{path}",
            json=body,
            timeout=timeout,
            headers={"Authorization": f"Bearer {_env('OPENAI_API_KEY')}"},
        )
        resp.raise_for_status()
        return resp.json()

    def search(self, query: str, limit: int = 5) -> Dict[str, Any]:
        """Search via /v1/search, walking the provider chain like search-ladder."""
        last_error = "no search provider available"
        for provider in SEARCH_PROVIDER_CHAIN:
            try:
                payload = self._post(
                    "/v1/search",
                    {"query": query, "max_results": limit, "provider": provider},
                    timeout=30,
                )
                results = payload.get("results") or []
                if not results:
                    last_error = f"{provider}: empty results"
                    continue
                web = [
                    {
                        "title": str(item.get("title") or ""),
                        "url": str(item.get("url") or ""),
                        "description": str(item.get("snippet") or item.get("description") or ""),
                        "position": index,
                    }
                    for index, item in enumerate(results[:limit])
                ]
                return {"success": True, "data": {"web": web}}
            except Exception as exc:  # noqa: BLE001
                last_error = f"{provider}: {exc}"
                logger.warning("OmniRoute search via %s failed: %s", provider, exc)
        return {"success": False, "error": f"OmniRoute search failed: {last_error}"}

    def extract(self, urls: List[str], **kwargs: Any) -> List[Dict[str, Any]]:
        """Extract readable markdown via /v1/web/fetch."""
        outputs: List[Dict[str, Any]] = []
        for url in urls:
            try:
                payload = self._post("/v1/web/fetch", {"url": url}, timeout=60)
                content = str(payload.get("content") or "")
                if not content:
                    outputs.append({"url": url, "error": "empty page content"})
                    continue
                metadata = payload.get("metadata")
                if not isinstance(metadata, dict):
                    metadata = {}
                outputs.append(
                    {
                        "url": str(payload.get("url") or url),
                        "title": str(metadata.get("title") or ""),
                        "content": content,
                        "raw_content": content,
                        "metadata": metadata,
                    }
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("OmniRoute extract %s failed: %s", url, exc)
                outputs.append({"url": url, "error": str(exc)})
        return outputs
