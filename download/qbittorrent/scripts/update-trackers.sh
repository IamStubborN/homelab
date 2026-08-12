#!/bin/sh

# Auto-update public trackers for qBittorrent
# Run periodically via cron or manually

WEBUI_PORT=8400
TRACKERS_URL="https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1"
}

# Fetch latest trackers
log "Fetching trackers from $TRACKERS_URL"
TRACKERS=$(wget -qO- "$TRACKERS_URL" 2>/dev/null | grep -v '^$' | head -50)

if [ -z "$TRACKERS" ]; then
    log "ERROR: Failed to fetch trackers"
    exit 1
fi

# Add rutracker announce URLs
TRACKERS="$TRACKERS
http://bt.t-ru.org/ann
http://bt2.t-ru.org/ann"

# Count trackers
COUNT=$(echo "$TRACKERS" | wc -l)
log "Fetched $COUNT trackers"

# Encode for API (replace newlines with \n)
ENCODED=$(echo "$TRACKERS" | sed 's/$/\\n/' | tr -d '\n' | sed 's/\\n$//')

# Update qBittorrent preferences
RESULT=$(wget -qO- --post-data "json={\"add_trackers\":\"$ENCODED\",\"add_trackers_enabled\":true}" \
    "http://localhost:${WEBUI_PORT}/api/v2/app/setPreferences" 2>&1)

if [ $? -eq 0 ]; then
    log "SUCCESS: Updated trackers in qBittorrent"
else
    log "ERROR: Failed to update trackers: $RESULT"
    exit 1
fi

# Add trackers to existing torrents
log "Adding trackers to existing torrents..."
HASHES=$(wget -qO- "http://localhost:${WEBUI_PORT}/api/v2/torrents/info" 2>/dev/null | \
    grep -oE '"hash":"[^"]*"' | sed 's/"hash":"//g;s/"//g')

TORRENT_COUNT=0
for hash in $HASHES; do
    URL_ENCODED=$(echo "$TRACKERS" | head -20 | sed 's/ /%20/g' | tr '\n' '%' | sed 's/%/%0A/g' | sed 's/%0A$//')
    wget -qO- --post-data "hash=$hash&urls=$URL_ENCODED" \
        "http://localhost:${WEBUI_PORT}/api/v2/torrents/addTrackers" 2>/dev/null
    TORRENT_COUNT=$((TORRENT_COUNT + 1))
done

log "SUCCESS: Added trackers to $TORRENT_COUNT torrents"
