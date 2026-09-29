FROM ghcr.io/unseensnick/solverr@sha256:4235afe91686bfaf1bc0bd52f825a05a3a885735fe5f907329bd0595e1f8b4c5
COPY --chmod=644 src/config.py src/dtos.py src/flaresolverr.py src/flaresolverr_service.py /app/
COPY --chmod=644 src/engines/stealth_engine.py /app/engines/stealth_engine.py
ENV BROWSER_SERIAL_MODE=true
LABEL com.centurylinklabs.watchtower.enable="false" \
      org.opencontainers.image.version="1.8.0-homelab-crawl-admission-20260926"
