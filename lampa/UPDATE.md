# Controlled Intel runtime updates

`update-runtime.py` is an operator CLI. It only recreates the `lampa` service
in the root `homelab` Compose project. On its own it has no schedule, image
pruning or automatic rollback; `auto-update.sh` adds those around it (below).

## Automatic nightly update

`lampac-auto-update.timer` runs `auto-update.sh` as root on the Docker host at
04:40 `Europe/Sofia`, before Watchtower (05:45). It:

1. stops with a Telegram alert when the last operation is unfinished or Lampa
   still runs from a rollback's saved model (reconcile it as described under
   Failure recovery first);
2. pulls upstream `latest` and does nothing if its digest is the one deployed
   or one that already failed here;
   when a new one is due but the running container does not match the root
   Compose model (config-hash, Compose files or project directory, for example
   an edit pulled but not applied) or the model does not build, it alerts once
   with what to run and retries every night; this does not mark the upstream
   as failed;
3. waits until Lampa sent under 3 MiB in each of 5 consecutive minutes, then
   runs `stage` and `check`, waits for idle again and runs
   `apply --maintenance-window`. No build starts later than 04:55 and no
   apply later than 05:25;
4. requires Lampa to answer HTTP within 10 minutes (a new version's first
   start compiles every module, about 5 minutes; the healthcheck's 600s
   `start_period` keeps DeUnhealth from restarting it meanwhile) and then
   to become healthy within 5 minutes, otherwise runs
   `rollback --maintenance-window` (only when apply got as far as stopping
   Lampa);
5. after every outcome except a failed rollback keeps only the
   candidate/rollback tags of the images in `pending.json` (after success the
   running and previous ones, after a failure the failed candidate and the
   running one) and the 3 newest generation directories.

Every outcome other than "nothing new" or "busy tonight" is reported to the
disk-watchdog's Telegram bot and chat; three busy nights in a row are reported
too. Its own state is `<state>/auto`. The idle check sees browser (GST) and
proxied online playback, which flow through Lampa, but not a paused player.
`DRY_RUN=1 lampa/auto-update.sh` only reports whether an update is due.

Install as root on the Docker host:

```sh
install -m 0644 lampa/lampac-auto-update.service lampa/lampac-auto-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now lampac-auto-update.timer
```

## Prerequisites and scope

Run with Python 3.9+ as root **on the Linux Docker host**, against its local
Unix socket. Docker CLI/Compose v2 and GNU `cp` must already be available.
Use the deployment's actual root directory, root `.env`, and optional root
`compose.override.yml`; alternate Compose file sets are rejected. Do not copy
workstation private configuration over the deployment. Root access through the
container host's existing management route is sufficient; no daemon is installed.
Compose must support `config --hash lampa` (check `docker compose config --help`).
Its service hash must match the running container's
`com.docker.compose.config-hash` label. Missing/mismatched labels, unsupported
output or a Compose-version hash difference stop the operation; there is no
bypass. Reconcile unapplied service edits before staging so the rollback model
does not capture settings that were never deployed. This guard also runs during
check and before apply saves `before.json`; it does not replace exclusive
operator control over deployment edits.

Private state defaults to `/var/lib/lampac-update`, root-owned mode 0700, outside
every Git working tree. Use `--state-dir` consistently if changing this path.
State and the parents of Lampa's bind sources must share a filesystem: rollback
uses atomic renames. An apply refuses a different filesystem before stopping
Lampa. Provision space for the full cache, database, logs and configuration
snapshot, plus another restored copy and any retained failed generations.

The supported bind layout is deliberately fixed to `lampa/compose.yml`.
Unexpected mounts, nested symlinks, build options, startup overrides or hooks
require review of the CLI. Production secrets and resolved Compose values are
never printed. Backups, diagnostics and the saved service model are private;
do not attach or commit them.

## Commands

Examples use `/srv/homelab`; replace it with the actual deployment root. Use the
same `--root` and `--state-dir` for all actions. Run commands separately and
review each outcome before continuing.

```bash
# Local plan only: no Docker calls, network access, or filesystem writes.
python3 lampa/update-runtime.py stage --dry-run
python3 lampa/update-runtime.py check --dry-run
python3 lampa/update-runtime.py apply --dry-run
python3 lampa/update-runtime.py rollback --dry-run

# On the Docker host, after backup/diagnostics finish and load will not disturb playback:
sudo python3 /srv/homelab/lampa/update-runtime.py stage --root /srv/homelab
sudo python3 /srv/homelab/lampa/update-runtime.py check --root /srv/homelab

# Only after viewers and backup are idle, with new starts prevented:
sudo python3 /srv/homelab/lampa/update-runtime.py apply --root /srv/homelab --maintenance-window

# If application behavior or configuration compatibility regresses:
sudo python3 /srv/homelab/lampa/update-runtime.py rollback --root /srv/homelab --maintenance-window
```

`--maintenance-window` acknowledges that both playback and backup are idle;
it does not detect sessions or backup jobs. Confirm all clients and backup jobs
are idle and prevent new starts through the operation. Do not run stage, check,
apply, rollback or the GPU probe during a host backup or CPU baseline collection.
There is no verified complete playback-session API here; the version endpoint and
CPU usage cannot establish that restarting is safe. Coordinate other deploys,
image-retention jobs and manual config edits throughout this window. The file
lock only serializes invocations of this CLI using the same state directory.

## Action behavior

- **stage** validates ownership, the deployed Compose config-hash, the baseline
  image/runtime startup contract and mounts, then tags the running image for rollback,
  pulls upstream `latest`, resolves its registry digest, and builds a uniquely
  tagged Intel candidate using a private Dockerfile with that pinned base.
  The repository Dockerfile, production image tag and running container stay
  unchanged. Package repositories remain a source of build-time variation.
- **check** requires the candidate's Entrypoint, Cmd, User and WorkingDir to match
  the validated baseline image and running container before creating a canary.
  Only the known direct dotnet/Core.dll entrypoint with no additional Cmd is
  supported. Compose command/entrypoint overrides are rejected even when empty
  (`[]` or `""`); absent/null values inherit the image. Image Cmd null and []
  are treated as equivalent. A changed entrypoint script or command requires
  manual review rather than being hidden by the canary's direct launch.
  After those checks it starts a disposable
  canary with `--network none`, `--cpus 1`, 2 GiB memory, 256 PIDs, no GPU, no
  published ports and no production mounts. It uses empty cache/database/logs,
  a synthetic minimal config and a random disposable password. Image-bundled
  `/lampac/data` stays visible in the disposable container layer: Lampac needs
  its bundled Cloudflare IP lists when network access is disabled. Masking that
  directory with an empty bind causes startup to fail; production data is never
  copied into the canary. It starts
  `/usr/share/dotnet/dotnet Core.dll` directly, bypassing upstream entrypoint
  scripts; no Compose dependencies or external watcher service are launched.
  Chromium and GST are disabled in the synthetic config. Only the bundled
  `LampaWeb` module is selected explicitly; upstream's default all-modules list
  otherwise compiles and initializes online providers during this offline probe.
  The version endpoint
  must return a successful nonempty response. The canary is removed after the
  check, including on ordinary failures. Its small private scratch directory
  and logs remain for diagnosis. A killed process/host outage may leave the
  isolated canary behind; it has no restart policy. Remove that exact
  `lampac-check-<generation>` container before repeating check.
- **apply** rejects changed Compose/config/plugin inputs or a replaced baseline
  container. It stops only Lampa, copies every supported bind with ownership
  and permissions intact, and flushes the snapshot before changing the live
  tag. It then uses root Compose with `--no-deps --no-build --pull never` to
  recreate only Lampa and probes HTTP. This is the only step that updates the
  production tag to the candidate. A failed apply leaves a journal and exits;
  it does not silently restart again or discard rollback data.
- **rollback** restores the prior immutable image ID and **all** pre-apply bind
  contents, including `init.conf`, password, bootstrap, plugins, mods, database,
  cache and logs. It stops Lampa first, preserves displaced candidate-era data
  outside Git, then restores copies by atomic rename. It recreates only Lampa
  under the same `homelab` project using the saved prior service model. This
  avoids running an old binary against migrated data or a changed config.
  Writes made after apply are absent from the restored application, but remain
  in the private displaced copies. Do not merge databases across versions.

The input fingerprint covers the resolved Lampa service and its referenced
network definitions, plus the baseline container/image, runtime Dockerfile,
`.dockerignore`, SQLite build verifier and
read-only bind contents/permissions. Unrelated service edits do not invalidate
a checked candidate. Changes to Lampa or a shared network it uses still do.
Generations staged with the earlier whole-project fingerprint must be staged
and checked again; do not rewrite an existing record to bypass the guard.

Only one pending generation is selected by `pending.json`. A new stage after
successful apply replaces that selection and makes the currently running image
the next rollback baseline. Previous directories and image tags are retained;
the CLI does not offer a history selector or garbage collection. Confirm the
current version before staging another one, and exempt candidate/rollback tags
from external image pruning until recovery is no longer needed. Do not use
`docker image prune -a` during the rollback retention period.

## Failure recovery and Compose reconciliation

Run explicit rollback for any failed/interrupted apply. Before a complete
snapshot was recorded, rollback simply starts the unchanged original container.
After that checkpoint, it restores image and bind snapshots. Repeating an
interrupted rollback resumes its deterministic restore paths. Failed restore
copies are retained, and the service remains stopped until recovery succeeds.
If the old image or backup is missing, stop and recover it from host backups;
the CLI does not guess or pull a replacement `latest`.

Rollback deliberately uses the saved service model rather than changed root
Compose definitions. It does not overwrite shared Compose files or `.env`.
Before the next ordinary root deployment, privately reconcile the current
`lampa` service with `<state>/<generation>/before.json`, retaining the restored
bind paths and prior image. Do not print that file or a resolved Compose model.
In an idle maintenance window, validate and recreate only Lampa through the
normal root files to restore its normal Compose file labels:

```bash
cd /srv/homelab
sudo docker compose config --quiet
sudo docker compose up -d --no-deps --no-build --pull never --force-recreate lampa
```

The next stage refuses saved-model deployment labels until this reconciliation
is complete. It also requires the production tag to match the running image.

## Verification limits

Dry-run verifies CLI parsing and describes intent; it does not claim a host
preflight, build, successful migration, or rollback rehearsal. The isolated
startup check intentionally does not validate production config, private plugins,
network providers, database migrations, GPU encoding or playback. Those need
operator checks in the agreed window after apply, with rollback retained.

For a separate, short GPU check in that window, use the recorded candidate ID
and the deployment's render device permissions. This command starts no Lampac
application, has no network or host data mounts, and encodes only 60 test frames:

```bash
CANDIDATE=sha256:REPLACE_WITH_RECORDED_CANDIDATE_ID
sudo docker run --rm --network none --cpus 1 --memory 1g --pids-limit 128 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --device /dev/dri/renderD128:/dev/dri/renderD128 \
  --env LIBVA_DRIVER_NAME=iHD --entrypoint gst-launch-1.0 "$CANDIDATE" \
  -q videotestsrc num-buffers=60 '!' video/x-raw,width=320,height=240,framerate=30/1 \
  '!' videoconvert '!' video/x-raw,format=NV12 '!' qsvh264enc '!' fakesink
```

That checks the explicit QSV encoder, not Lampac's end-to-end GST session path.
Do not run it during active playback or while diagnosing host saturation.
