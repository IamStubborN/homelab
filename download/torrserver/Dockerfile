FROM debian:bookworm-slim

ARG TORRSERVER_VERSION=MatriX.145
ARG TARGETARCH=amd64

RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
      ca-certificates \
      gstreamer1.0-tools \
      gstreamer1.0-libav \
      gstreamer1.0-plugins-base \
      gstreamer1.0-plugins-base-apps \
      gstreamer1.0-plugins-good \
      gstreamer1.0-plugins-bad \
      gstreamer1.0-plugins-ugly \
      gstreamer1.0-vaapi \
      intel-media-va-driver \
      vainfo \
      ocl-icd-libopencl1 \
      wget \
    && rm -rf /var/lib/apt/lists/* \
    && case "${TARGETARCH}" in \
         amd64) asset="TorrServer-gst-linux-amd64" ;; \
         arm64) asset="TorrServer-gst-linux-arm64" ;; \
         *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
       esac \
    && wget --quiet --output-document=/usr/bin/torrserver \
         "https://github.com/YouROK/TorrServer/releases/download/${TORRSERVER_VERSION}/${asset}" \
    && chmod 0755 /usr/bin/torrserver \
    && /usr/bin/torrserver --version \
    && gst-inspect-1.0 avdec_ac3 >/dev/null \
    && gst-inspect-1.0 avenc_aac >/dev/null \
    && gst-inspect-1.0 x264enc >/dev/null \
    && gst-discoverer-1.0 --help >/dev/null \
    && mkdir -p /opt/ts/config /opt/ts/log /opt/ts/torrents

ENV TS_CONF_PATH=/opt/ts/config \
    TS_LOG_PATH=/opt/ts/log \
    TS_TORR_DIR=/opt/ts/torrents \
    TS_PORT=8090 \
    GODEBUG=madvdontneed=1

WORKDIR /
EXPOSE 8090
ENTRYPOINT ["/usr/bin/torrserver"]
