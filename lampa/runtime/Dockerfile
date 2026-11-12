FROM ghcr.io/lampac-nextgen/lampac:latest AS runtime-base

FROM python@sha256:504679006065cdab9a85e983e269140d3c5a279492395a6863b25b1ffb377f86 AS sqlite-build

WORKDIR /build
COPY --from=runtime-base /lampac/libe_sqlite3.so /build/original.so
RUN curl -fsSL https://www.sqlite.org/2026/sqlite-amalgamation-3540000.zip -o sqlite.zip \
    && echo '68e913b0fe8ec6b4e5f391c594a28872884e80d6cd042a1e50c957be46b5aa4d  sqlite.zip' | sha256sum -c - \
    && unzip -q sqlite.zip \
    && gcc -O2 -fPIC -shared -Wl,-Bsymbolic -Wl,-soname,libe_sqlite3.so \
        -DSQLITE_DQS=0 -DSQLITE_DEFAULT_AUTOVACUUM=1 \
        -DSQLITE_DEFAULT_FOREIGN_KEYS=1 -DSQLITE_DEFAULT_RECURSIVE_TRIGGERS=1 \
        -DSQLITE_ENABLE_COLUMN_METADATA -DSQLITE_ENABLE_FTS3 \
        -DSQLITE_ENABLE_FTS3_PARENTHESIS -DSQLITE_ENABLE_FTS4 -DSQLITE_ENABLE_FTS5 \
        -DSQLITE_ENABLE_GEOPOLY -DSQLITE_ENABLE_MATH_FUNCTIONS \
        -DSQLITE_ENABLE_PREUPDATE_HOOK -DSQLITE_ENABLE_RTREE \
        -DSQLITE_ENABLE_SESSION -DSQLITE_ENABLE_SNAPSHOT \
        -DSQLITE_LIKE_DOESNT_MATCH_BLOBS -DSQLITE_MALLOC_SOFT_LIMIT=1024 \
        -DSQLITE_MAX_VARIABLE_NUMBER=32766 -DSQLITE_THREADSAFE=1 -DSQLITE_TEMP_STORE=1 \
        sqlite-amalgamation-3540000/sqlite3.c -o libe_sqlite3.so -lpthread -ldl -lm
COPY verify-sqlite-build.py /build/verify-sqlite-build.py
RUN python verify-sqlite-build.py original.so libe_sqlite3.so

# matroskademux rejects blocks over 15 MiB (32 MiB since 1.28); some releases carry ~31 MiB
# attachment blocks. Rebuild only that plugin from the Debian source of the
# installed version with a higher limit (see download/torrserver/Dockerfile).
FROM runtime-base AS matroska

ARG MATROSKA_MAX_BLOCK_MIB=64
USER root

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
    && version="$(dpkg-query -W -f='${Version}' gstreamer1.0-plugins-good)" \
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

FROM runtime-base

USER root

COPY --from=matroska /out /tmp/matroska

# Lampac selects qsvh264enc, which needs both the Intel VA driver and VPL runtime.
RUN sed -i 's/^Components: main$/Components: main non-free/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        intel-media-va-driver-non-free \
        libmfx-gen1.2 \
        libvpl2 \
        vainfo \
    && rm -rf /var/lib/apt/lists/* \
    && test "$(dpkg-query -W -f='${Version}' gstreamer1.0-plugins-good)" = "$(cat /tmp/matroska/version)" \
    && install -m 0644 /tmp/matroska/libgstmatroska.so \
         "$(dpkg -L gstreamer1.0-plugins-good | grep '/libgstmatroska\.so$')" \
    && rm -rf /tmp/matroska \
    && gst-inspect-1.0 matroskademux >/dev/null

ENV LIBVA_DRIVER_NAME=iHD

COPY --from=sqlite-build --chown=lampac:lampac /build/libe_sqlite3.so /lampac/libe_sqlite3.so

USER lampac
