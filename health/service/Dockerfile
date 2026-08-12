# syntax=docker/dockerfile:1.18@sha256:dabfc0969b935b2080555ace70ee69a5261af8a8f1b4df97b9e7fbcf6722eddf

ARG RUST_IMAGE=rust:1.97.0-bookworm@sha256:7d0723df719e7f213b69dc7c8c595985c3f4b060cfbee4f7bc0e347a86fe3b6a
ARG RUNTIME_IMAGE=debian:bookworm-slim@sha256:60eac759739651111db372c07be67863818726f754804b8707c90979bda511df

FROM ${RUST_IMAGE} AS chef
RUN cargo install cargo-chef --version 0.1.77 --locked
WORKDIR /app

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
ARG TARGETARCH
COPY --from=planner /app/recipe.json recipe.json
RUN --mount=type=cache,id=health-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=health-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=health-target-${TARGETARCH},target=/app/target,sharing=locked \
    cargo chef cook --release --locked --package health-service
COPY . .
RUN --mount=type=cache,id=health-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=health-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=health-target-${TARGETARCH},target=/app/target,sharing=locked \
    cargo build --release --locked --package health-service && \
    install -D -m 0755 target/release/health-service /out/health-service && \
    strip /out/health-service

FROM ${RUNTIME_IMAGE} AS runtime
RUN groupadd --gid 10001 health && \
    useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin health
COPY --from=builder --chown=10001:10001 /out/health-service /usr/local/bin/health-service
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/health-service"]
