# Bounded Watchtower image retention

Watchtower keeps `--cleanup=false`, its existing image references, and the
04:00 `Europe/Sofia` schedule. The separate Python 3 standard-library CLI records
image IDs actually used by explicitly enrolled, Watchtower-enabled Compose
services. It retains the current and one previous distinct observed ID per
service/replica. Histories are independent even when services share repositories;
image protection is the union across all histories sharing an ID.

Only older recorded IDs with **no tags**, no references from **any** container
(including stopped/created containers), and no digest in an untracked repository
can be removed, and only through repository digest references recorded while the
image was current for an enrolled service. Images without a proven digest remain
protected; the tool never falls back to deleting by image ID. All tags, including
`latest` and arbitrary manual rollback tags,
are protected. Unknown existing orphan images are never adopted by repository
name, creation time, or digest. Therefore bootstrap frees no space and an actual
previous image cannot be reconstructed from an unproven existing orphan.

Missing, stopped, disabled, or changed-reference services freeze their entire
history. New services are reported but not automatically enrolled. A new reviewed
state file can enroll changed services; keep the old state as a backup. Images
known only to that old state then become protected unknowns. These safety
exceptions can retain more than two images. This bounds eligible future update
history, not total Docker disk use or image sizes.

## Review and initialize

Run on the Docker host. The tool explicitly uses the local Unix socket; it does
not inherit Docker context selection. Choose a private state path outside Git.
No command pulls images, tags images, restarts containers, or changes volumes.

```sh
python3 image-retention.py discover --project PROJECT --state /private/path/state.json
python3 image-retention.py init --project PROJECT --state /private/path/state.json
python3 image-retention.py plan --state /private/path/state.json
```

`discover` and `plan` are read-only. `init` captures current IDs only and refuses
to overwrite existing history. `observe` records current IDs; `run` records IDs
and prints a dry-run plan. State writes are atomic, mode 0600, and writers use a
file lock. Plans contain image metadata and service identities, so store them
outside Git too. Logical image sizes are not reclaimed bytes: shared layers mean
actual reclaimable space is unknown unless the candidate set is empty (0 bytes).

## Deployment after review

Before copying anything into deployment paths, back up any existing script,
unit, timer, state, and Watchtower Compose file outside Git. Do not recreate
Watchtower. Substitute `@SCRIPT@` and `@STATE@` in the service template with
absolute paths, validate with `systemd-analyze verify`, and install as a system
unit with Docker socket access. Keep the timer disabled during review. The
template is dry-run even if started; no destructive mode is enabled by default.
Shared executable directories such as `/usr/local/libexec` must remain mode
0755; restricting them to 0700 can break Docker CLI plugin discovery. Install
the script as 0755, and restrict only the private state directory to 0700
and its state file to 0600.

The two daily observations bracket the normal update: 03:55 captures the old ID
before 04:00; 05:00 records the replacement. Initialize before the first update.
If an update finishes later, the next observation captures it. Missed observations
or extra manual updates can leave unknown intermediates; those remain untouched.
The timer is not a substitute for Watchtower scheduling and does not trigger an
update. `Persistent=false` avoids an unexpected catch-up cleanup at boot.

Only **after the parent/operator reviews the dry-run and this policy**, add
`--apply` to the service's `run` command and activate the timer. Each deletion
refreshes all containers and images twice, updates history, and rechecks the
candidate before each digest removal, resolving that exact digest back to its
recorded full image ID. It invokes only
`docker image rm --no-prune REPOSITORY@sha256:DIGEST`, without force. Multiple
recorded digests are removed one at a time, with full protection checks between
them. A Docker conflict or changing protection stops the run. No parent-image,
global-image, build-cache, or volume pruning is performed.

Docker's classic image store removes the named digest reference, then retains
the image if other references remain. A tag added between our check and that
reference removal is preserved, unlike deletion by image ID. This follows the
installed Engine revision's [ImageDelete implementation](https://github.com/moby/moby/blob/464cd50/daemon/images/image_delete.go).
Successful digest removal can leave an image present (for example, a new tag or
container now protects it); the tool reports reference removal separately from
image deletion. It never retries by ID. The lock serializes this tool only;
Docker's operations are not a transaction with other clients. Shared layers are
left to Docker's reference accounting, and sizes count each shared ID only once.

For rollback of this mechanism, disable/stop the timer and restore its backed-up
files. Keep the state: resetting it discards provenance. Application rollback is
still available by retained full image ID (`plan` lists each service's history)
or an existing manual rollback tag. Disabling retention cannot restore images
already deleted in a subsequently approved apply run.
