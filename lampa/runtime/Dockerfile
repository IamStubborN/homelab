FROM ghcr.io/lampac-nextgen/lampac:latest AS runtime-base

FROM python@sha256:504679006065cdab9a85e983e269140d3c5a279492395a6863b25b1ffb377f86 AS sqlite-build

WORKDIR /build
COPY --from=runtime-base /lampac/libe_sqlite3.so /build/original.so
RUN curl -fsSL https://www.sqlite.org/2026/sqlite-amalgamation-3530300.zip -o sqlite.zip \
    && echo '646421e12aac110282ef8cc68f1a62d4bb15fc7b8f09da0b53e29ee690500431  sqlite.zip' | sha256sum -c - \
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
        sqlite-amalgamation-3530300/sqlite3.c -o libe_sqlite3.so -lpthread -ldl -lm
COPY verify-sqlite-build.py /build/verify-sqlite-build.py
RUN python verify-sqlite-build.py original.so libe_sqlite3.so

FROM runtime-base

USER root

# Lampac selects qsvh264enc, which needs both the Intel VA driver and VPL runtime.
RUN sed -i 's/^Components: main$/Components: main non-free/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        intel-media-va-driver-non-free \
        libmfx-gen1.2 \
        libvpl2 \
        vainfo \
    && rm -rf /var/lib/apt/lists/*

ENV LIBVA_DRIVER_NAME=iHD

COPY --from=sqlite-build --chown=lampac:lampac /build/libe_sqlite3.so /lampac/libe_sqlite3.so

USER lampac
