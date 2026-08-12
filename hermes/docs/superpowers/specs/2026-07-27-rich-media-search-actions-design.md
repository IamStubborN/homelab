# Rich Media Search Actions Design

## Goal

Make source-choice search responses useful without an LLM round trip:

- show every Rezka translation returned for each visible result;
- show useful Prowlarr release details;
- attach inline actions that start the explicitly selected download;
- keep pagination actionable;
- preserve the existing structured job-card action model.

## User Flow

1. A future-episode card offers `All`, `Rezka`, and `Prowlarr`.
2. The selected provider searches run directly through `hermes-media`.
3. The response lists at most five results per provider.
4. Every Rezka result lists all returned translations. Each translation has a
   download button.
5. Every Prowlarr result has a download button.
6. Pressing a download button immediately creates the episode job. No extra
   confirmation is requested because the button is the explicit source and
   release or translation selection.
7. A continuation is rendered as an inline `Show more` action.

## Callback Model

Telegram callback data is limited to 64 bytes, so it must not contain the full
search session, result ID, and translation metadata.

The Telegram plugin stores bounded action records in the Hermes profile volume.
Each record has:

- a random opaque token used as `md:<token>`;
- action kind (`download` or `continue`);
- search session and result identifiers;
- optional translation ID;
- season and episode;
- display title and translation;
- expiry matching the search session;
- consumed state for successful download actions.

The store is atomically replaced, rejects expired records, and retains at most
500 actions. A download action is durably claimed before the CLI call and
becomes single-use on success. A normal CLI failure releases the claim for
retry. If Hermes exits while the result is unknown, the claim remains until
the search session expires; the user must search again instead of risking a
duplicate job.

## Rendering

Rezka cards include:

- title, year, and available episode range;
- all translation names and relevant source flags;
- one inline button per translation;
- continuation action when present.

Prowlarr cards include:

- release title;
- size and seed count when available;
- indexer and release group when returned;
- quality, codec, and language remain visible in the release title because the
  current media-service search DTO does not expose them as separate fields;
- one inline download button per result;
- continuation action when present.

`All` keeps provider sections separate. Search results are packed into bounded
messages with at most 20 actions so Telegram's text and keyboard limits cannot
drop the whole response. A provider failure does not hide a successful
provider response. Technical IDs and raw service errors remain hidden.

## Existing Card Audit

The structured job-card matrix remains authoritative:

- active work: `Cancel`, `Details`;
- failed: `Retry`, `Choose another source`, `Details`;
- partial with missing artifacts: `Retry missing`, `Choose another source`,
  `Details`;
- blocked storage: `Continue`, `Details`;
- completed, cancelled, or informational partial: `Details`;
- future episode: `All`, `Rezka`, `Prowlarr`.

Tests must cover every matrix row and every generated callback.

## Verification

- Python unit tests validate parsing, all translation rendering, callback
  limits, persistence, expiry, single-use downloads, pagination, and provider
  failure isolation.
- Existing notifier and skill suites remain green.
- A deployed Web Telegram test presses `All`, then a concrete translation
  button. The created test job is cancelled before it starts downloading.
