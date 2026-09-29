# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0-alpine@sha256:3cc3bbbbf93d82104892f42aa9106b6be4d120346dea0649643a97c801525256 AS build

RUN apk add --no-cache bash git
WORKDIR /src

# The upstream snapshot and local patch are the complete application input.
ADD --checksum=sha256:9a64999742de4a3ff3116f5635f917e1779f50fd0a3a565755a73eb7530f9f7d https://codeload.github.com/jacred-fdb/jacred/tar.gz/6c238d07df45ee84f1ae7baf5d491dbef2878fe7 /tmp/upstream.tar.gz
COPY crawl-recovery.patch /tmp/crawl-recovery.patch
RUN tar -xzf /tmp/upstream.tar.gz --strip-components=1 \
    && git apply --check /tmp/crawl-recovery.patch \
    && git apply /tmp/crawl-recovery.patch

ARG TARGETARCH
COPY packages.*.lock.json /locks/
RUN case "$TARGETARCH" in \
      amd64) rid=linux-musl-x64 ;; \
      arm64) rid=linux-musl-arm64 ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && cp "/locks/packages.$rid.lock.json" packages.lock.json \
    && dotnet publish JacRed.csproj \
      --runtime "$rid" --configuration Release --self-contained true \
      --output /publish --verbosity minimal \
      -p:PublishSingleFile=true -p:PublishTrimmed=false -p:DebugType=None \
      -p:EnableCompressionInSingleFile=false -p:RestoreLockedMode=true

# Keep the deployed web UI, defaults, entrypoint and runtime unchanged.
FROM ghcr.io/jacred-fdb/jacred@sha256:f2d56820ab5c45a5bc0a7f952ff97a71b99f86669c6c096ccb93f9f5b8704ac4
COPY --from=build --chown=jacred:jacred --chmod=550 /publish/JacRed /app/JacRed
LABEL com.centurylinklabs.watchtower.enable="false" \
      org.opencontainers.image.version="3.15.1-homelab-crawl-recovery-20260926" \
      org.opencontainers.image.source="https://github.com/jacred-fdb/jacred" \
      org.opencontainers.image.revision="6c238d07df45ee84f1ae7baf5d491dbef2878fe7+homelab-crawl-recovery"
