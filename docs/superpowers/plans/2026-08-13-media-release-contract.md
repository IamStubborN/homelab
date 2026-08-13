# Media Orchestrator Release Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce and consume a deterministic Media Orchestrator release bundle without implicit sibling-source discovery.

**Architecture:** The private application repository exports an immutable, hashed bundle. Homelab pins and validates that bundle, while the existing guarded deploy keeps its safety logic and receives both repository paths explicitly.

**Tech Stack:** POSIX shell, Python 3 standard library, JSON, Docker/OCI labels, Rust/Cargo tests, unittest.

## Global Constraints

- Do not expose private `media-orchestrator` source through the public Homelab repository.
- Do not infer repositories with `../homelab`, `../../media-orchestrator`, or another fixed sibling path.
- Require immutable `name@sha256:<64 lowercase hex>` image references.
- Do not invent production image digests or perform registry login, upload, release creation, or deployment.
- Preserve all existing guarded deploy, backup, migration, rollback, protected-container, and live MCP behavior.
- Use only Python standard library for new contract tooling.
- Keep the implementation minimal; no release platform, daemon, database, or new network service.

---

### Task 1: Private release-bundle producer

**Files:**
- Private repo, create: `scripts/export-release-contract.py`
- Private repo, create: `scripts/test-release-contract.py`
- Private repo, modify: `scripts/homelab.sh`
- Private repo, modify: `scripts/test-packaging.rb`
- Private repo, modify: `docs/RUNBOOK.md`

**Interfaces:**
- Consumes: `scripts/docker-build.sh --print-source-tree-digest`, `--print-source-version`, and `--print-runner-build-digest`; `config/media-capabilities.json`; `MCP_SCHEMA_SNAPSHOT` support in `crates/media-api/tests/mcp.rs`.
- Produces: `scripts/export-release-contract.py --service-image IMAGE --runner-image IMAGE --migration-version VERSION --cli PATH --cli-checksum PATH --output DIR` and the four-file schema-version-1 bundle defined by the design.

- [ ] Write failing Python tests using disposable repositories, files, and fake command executables. Cover deterministic output, mutable image rejection, dirty worktree rejection, CLI checksum mismatch, schema/capability drift, and destination preservation on failure.
- [ ] Run `python3 scripts/test-release-contract.py` and verify the failures describe the missing exporter.
- [ ] Implement the smallest standard-library exporter. Generate into a private sibling temporary directory, validate all fields and files, `fsync` files and directory, then atomically replace only an absent destination or a destination explicitly supplied with `--replace`.
- [ ] Run `python3 scripts/test-release-contract.py` and `ruby scripts/test-packaging.rb`.
- [ ] Remove sibling defaults from `scripts/homelab.sh`: `HOMELAB_ROOT` and `MEDIA_RELEASE_DIR` are required, while `HERMES_HOME_ROOT` derives only from the explicit Homelab root. Update static tests and runbook.
- [ ] Run `mise run format`, `mise run check`, `mise run lint`, and the focused packaging/contract tests.
- [ ] Commit the private-repository task.

### Task 2: Public Homelab bundle consumer

**Files:**
- Create: `media/release.example/release.json`
- Create: `media/release.example/MCP_SCHEMA.json`
- Create: `media/release.example/media-capabilities.json`
- Create: `media/release.example/media-linux-amd64.sha256`
- Create: `hermes/scripts/media_release_contract.py`
- Modify: `hermes/scripts/check-media-capabilities`
- Modify: `hermes/scripts/deploy-preflight`
- Modify: `hermes/tests/test_scaffold.py`
- Modify: `hermes/README.md`
- Modify: `media/README.md`
- Modify: `.env.example`

**Interfaces:**
- Consumes: the exact four-file schema-version-1 bundle from Task 1.
- Produces: `load_release_contract(path: pathlib.Path) -> dict`, fail-closed artifact validation, and `MEDIA_RELEASE_DIR` as the sole local media contract input for Hermes preflight.

- [ ] Write failing unittest cases for valid fixture loading, missing/malformed fields, mutable image references, checksum drift, capability/schema tool drift, duplicate tools, and absence of `MEDIA_ORCHESTRATOR_DIR`/fixed sibling paths.
- [ ] Run the focused unittest selection and verify it fails because the consumer is absent.
- [ ] Implement one focused standard-library parser/validator module. Make both checker and deploy preflight use it; remove Rust-source discovery and source-checkout attestation from Homelab.
- [ ] Build a sanitized example bundle with valid structural hashes and obviously non-production repository names; never place it at `media/release/`.
- [ ] Update docs to describe copying a real exported bundle to the ignored `media/release/`, the registry-login gap, and explicit paths used by the private guarded deploy.
- [ ] Run focused tests, full `hermes/scripts/check` against the example fixture, root Compose rendering, ShellCheck, and `git diff --check`.
- [ ] Commit the public-repository task.

### Task 3: Cross-repository contract proof

**Files:**
- Modify only files required to fix concrete integration findings from this task.

**Interfaces:**
- Consumes: Task 1 exporter and Task 2 consumer.
- Produces: a disposable exported bundle accepted byte-for-byte by Homelab without either tool discovering a sibling checkout.

- [ ] Export a bundle in a disposable clean media fixture with fake immutable image references and a real generated MCP schema.
- [ ] Copy it into a disposable Homelab fixture and run capability plus deploy preflight validation with both original repositories temporarily unavailable through environment/path isolation.
- [ ] Verify changed hashes, mutable images, stale schemas, and missing files all fail closed.
- [ ] Run both repositories' complete relevant checks and `git diff --check`.
- [ ] Commit only any concrete fixes required by the cross-repository proof.
