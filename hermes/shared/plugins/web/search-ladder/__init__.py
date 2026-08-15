"""OmniRoute web search + extract — user plugin for Hermes.

Backed by the household OmniRoute gateway; see provider.py for details.
"""

from __future__ import annotations

from .provider import OmniRouteWebSearchProvider


def register(ctx) -> None:
    """Register the OmniRoute provider with the plugin context."""
    ctx.register_web_search_provider(OmniRouteWebSearchProvider())
