# Lampa

This module hosts the Lampa web client and Lampac NextGen online backend. The
TorrServer module inside Lampac is deliberately disabled: torrent streaming
uses the existing `torrserver` service from `download/compose.yml`.

## Runtime setup

Create the ignored root-password file on the Docker host before starting the
root Compose project:

```bash
umask 077
openssl rand -hex 32 > lampa/config/passwd
```

The AI adapter reads the TMDB API key from a Docker secret. Create the ignored
secret file before starting the stack:

```bash
install -m 0600 /dev/null hermes/secrets/tmdb_api_key
# Put the TMDB API key on the single line in this file.
```

The service is published at:

```text
https://lampa.${DOCKER_DOMAIN}/
```

On first load the client is configured to use same-origin paths:

- `/torrserver` → the existing TorrServer;
- `/prowlarr` → the existing Prowlarr;
- `/online.js` → Lampac online and anime providers.

The server-side bootstrap also enables Lampac's built-in Dorama section.

The Prowlarr API key is injected into the live server-side bootstrap from the
existing Prowlarr configuration. It is not stored in this repository or
entered on the TV. The bootstrap also sets the parser mode and both local
service URLs on every Lampa start.

## Verification

```bash
curl -fsS "https://lampa.${DOCKER_DOMAIN}/version?type=hash"
curl -fsS "https://lampa.${DOCKER_DOMAIN}/torrserver/echo"
curl -fsS "https://lampa.${DOCKER_DOMAIN}/online.js" | head
```
