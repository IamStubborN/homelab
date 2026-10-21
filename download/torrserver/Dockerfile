# matroskademux in GStreamer 1.22 rejects blocks over 15 MiB (some releases carry
# ~31 MiB attachment blocks). Rebuild only that plugin from the same Debian source
# version that the runtime stage installs, with a higher limit.
FROM debian:bookworm-slim AS matroska

ARG MATROSKA_MAX_BLOCK_MIB=64

RUN sed -i 's/^Types: deb$/Types: deb deb-src/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install --no-install-recommends --yes \
      dpkg-dev \
      gcc \
      libbz2-dev \
      libgstreamer-plugins-base1.0-dev \
      libgstreamer1.0-dev \
      meson \
      ninja-build \
      pkg-config \
      zlib1g-dev \
    && version="$(apt-cache policy gstreamer1.0-plugins-good | sed -n 's/^ *Candidate: //p')" \
    && mkdir /src && cd /src \
    && apt-get source --only-source "gst-plugins-good1.0=${version}" \
    && cd gst-plugins-good1.0-*/ \
    && sed -i "s/^#define MAX_BLOCK_SIZE ([0-9]* \* 1024 \* 1024)$/#define MAX_BLOCK_SIZE (${MATROSKA_MAX_BLOCK_MIB} * 1024 * 1024)/" gst/matroska/*.[ch] \
    && grep -qF "#define MAX_BLOCK_SIZE (${MATROSKA_MAX_BLOCK_MIB} * 1024 * 1024)" gst/matroska/matroska-demux.c \
    && CFLAGS="$(dpkg-buildflags --get CFLAGS)" LDFLAGS="$(dpkg-buildflags --get LDFLAGS)" \
       meson setup build --buildtype=plain \
         -Dauto_features=disabled -Dmatroska=enabled -Dbz2=enabled \
    && ninja -C build gst/matroska/libgstmatroska.so \
    && mkdir /out \
    && strip --strip-unneeded -o /out/libgstmatroska.so build/gst/matroska/libgstmatroska.so \
    && echo "${version}" > /out/version

FROM debian:bookworm-slim

ARG TORRSERVER_VERSION=MatriX.145
ARG TARGETARCH=amd64

COPY --from=matroska /out /tmp/matroska

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
    && test "$(dpkg-query -W -f='${Version}' gstreamer1.0-plugins-good)" = "$(cat /tmp/matroska/version)" \
    && install -m 0644 /tmp/matroska/libgstmatroska.so \
         "$(dpkg -L gstreamer1.0-plugins-good | grep '/libgstmatroska\.so$')" \
    && rm -rf /tmp/matroska \
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
    && gst-inspect-1.0 matroskademux >/dev/null \
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
