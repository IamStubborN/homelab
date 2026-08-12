---
name: watching
description: Show what is currently playing in the household Plex server.
---

# Watching Now

Use `mcp_media_admin_plex_now_playing` and no other source. This command is
read-only. Never use tracking records, completed jobs, recent additions, TMDB,
or web search as evidence of active playback.

If nothing is playing, reply briefly that nobody is watching anything now.
Otherwise list each active session with the title, season and episode for a
series, Plex user, player, playback state, and progress when returned. Omit
missing fields and never expose raw JSON or technical identifiers.
