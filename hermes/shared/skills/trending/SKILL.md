---
name: trending
description: Show the current worldwide weekly TMDB trends for movies and series.
---

# Trending

Use `mcp_media_admin_media_trending` with `category=all`. This command is
read-only and must not start provider search or download. Use page 1 unless the
user supplied a positive page number.

Show up to ten results in TMDB order with localized title, original title when
present, year, media type, and rating. In Telegram prefer the native rich card
and its inline navigation over repeating the list as prose. State that these
are worldwide weekly TMDB trends. If the user asks for more, request the next
page with the same category. A selected title is not a download result. The
download action opens an explicit provider and release selection; it must not
create a job by itself.
