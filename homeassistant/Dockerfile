FROM ghcr.io/home-assistant/home-assistant:stable

# Home Assistant 2026.6.1 pins greeclimate 2.1.1, which crashes on Gree
# result packets that contain "p" instead of "val". Patch the integration
# requirement too; otherwise HA downgrades the package back during startup.
RUN python -c 'from pathlib import Path; p = Path("/usr/src/homeassistant/homeassistant/components/gree/manifest.json"); p.write_text(p.read_text().replace("greeclimate==2.1.1", "greeclimate==2.1.4"))'
RUN pip install --no-cache-dir --upgrade greeclimate==2.1.4
