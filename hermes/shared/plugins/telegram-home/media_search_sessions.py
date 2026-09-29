"""Shared search snapshots in the callback store's atomic JSON document."""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy


_PAGE_FIELDS = {"search_page": "search_page_ref", "carousel_page": "carousel_page_ref"}
_REFERENCE_FIELDS = {reference: field for field, reference in _PAGE_FIELDS.items()}


class SearchSessions:
    """Keep historical search pages once while callbacks retain their view state."""

    def __init__(self, pages: dict | None = None):
        self.pages = pages if pages is not None else {}

    def _capture(self, page: dict) -> str:
        serialized = json.dumps(
            page, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        key = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
        if key not in self.pages:
            self.pages[key] = json.loads(serialized)
        return key

    def encode(self, value):
        if isinstance(value, list):
            return [self.encode(item) for item in value]
        if not isinstance(value, dict):
            return value
        result = {}
        for key, item in value.items():
            if key in _PAGE_FIELDS and isinstance(item, dict):
                result[_PAGE_FIELDS[key]] = self._capture(item)
            elif (
                key == "search_pages"
                and isinstance(item, list)
                and all(isinstance(page, dict) for page in item)
            ):
                result["search_page_refs"] = [self._capture(page) for page in item]
            else:
                result[key] = self.encode(item)
        return result

    def _restore(self, key: str) -> dict:
        page = self.pages.get(key) if isinstance(key, str) else None
        if not isinstance(page, dict):
            raise ValueError("callback search session is missing")
        # Renderers annotate their own view, never the shared stored snapshot.
        return deepcopy(page)

    def decode(self, value):
        if isinstance(value, list):
            return [self.decode(item) for item in value]
        if not isinstance(value, dict):
            return value
        result = {}
        for key, item in value.items():
            if key in _REFERENCE_FIELDS:
                result[_REFERENCE_FIELDS[key]] = self._restore(item)
            elif key == "search_page_refs":
                if not isinstance(item, list):
                    raise ValueError("callback search sessions are invalid")
                result["search_pages"] = [self._restore(reference) for reference in item]
            else:
                result[key] = self.decode(item)
        return result

    def prune(self, actions: dict) -> None:
        used = set()

        def collect(value):
            if isinstance(value, list):
                for item in value:
                    collect(item)
            elif isinstance(value, dict):
                for key, item in value.items():
                    if key in _REFERENCE_FIELDS and isinstance(item, str):
                        used.add(item)
                    elif key == "search_page_refs" and isinstance(item, list):
                        used.update(
                            reference for reference in item if isinstance(reference, str)
                        )
                    else:
                        collect(item)

        collect(actions)
        self.pages = {key: page for key, page in self.pages.items() if key in used}
