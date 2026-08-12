---
name: series
description: Show the current worldwide weekly TMDB series trends.
---

# Top Series

Use `mcp_media_admin_media_trending` with `category=tv`. This command is
read-only and must not start provider search or download. Use page 1 unless the
user supplied a positive page number.

Show up to ten results in TMDB order with localized title, original title when
present, year, and rating. State that these are worldwide weekly TMDB trends.
If the user asks for more, request the next page with the same category. A
selected title is not a download result. In Telegram use the rich card actions;
finding a download remains an explicit provider and release selection.
