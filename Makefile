SHELL := /bin/bash

VIDEO_DIR ?= /mnt/internal/torrents/tv

.PHONY: ip-test speedtest dns-leak-test update-containers prune check-codecs

ip-test:
	docker run --rm --network=container:gluetun alpine:3.20 sh -c "apk add wget && wget -qO- https://ipinfo.io"

speedtest:
	docker run --rm --network=container:gluetun ubuntu:22.04 sh -c "apt-get update && apt-get install curl -y && curl -s https://packagecloud.io/install/repositories/ookla/speedtest-cli/script.deb.sh | bash && apt-get update && apt-get install speedtest && speedtest --accept-gdpr --accept-license"

dns-leak-test:
	docker run --rm --network=container:gluetun ubuntu:22.04 sh -c "apt-get update && apt-get install curl inetutils-ping -y && curl https://raw.githubusercontent.com/macvk/dnsleaktest/master/dnsleaktest.sh -o dnsleaktest.sh && chmod +x dnsleaktest.sh && ./dnsleaktest.sh"

update-containers:
	docker compose config --quiet
	docker compose pull
	docker compose up -d --remove-orphans

prune:
	docker system prune -a -f

check-codecs:
	@find "$(VIDEO_DIR)" -type f \( -iname "*.mp4" -o -iname "*.mkv" -o -iname "*.avi" \) \
		-exec sh -c 'echo -n "{}: "; ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "{}"' \;
