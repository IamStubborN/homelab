<!--
  Example personal SCHEMA.md for ${WIKI_ROOT}/{andrii,valentyna}/.
  Live files are created on the host by T7. Do not commit vault contents.
-->

# SCHEMA

This directory is one person's llm-wiki (`WIKI_PATH=/wiki`). Family notes that
both spouses should see live under `shared/` (a bind-mount, not a copy).

## Medical facts

Medical facts go through MCP and `shared/health`. Do not store blood pressure,
labs, meals, medications, allergies, conditions, or sleep as personal journal
pages. Do not write jsonl. Do not edit `shared/health/data/` or
`shared/health/generated/`.

To record a measurement, meal, symptom, sleep interval, medication, condition,
allergy, or lab, use the health MCP tools. To read the current medical picture,
open `shared/health/generated/*.md` and `shared/health/SCHEMA.md` via llm-wiki,
not jsonl.

## What belongs here

- Personal notes, research, and non-medical journal pages for this person
- Links to `shared/health/people/<person>/` synthesis pages
- Index and log for this personal tree

## What does not belong here

- Spouse-private notes (those live in the other personal tree)
- Raw medical ledger rows (MCP jsonl under `shared/health/data/`)
- Generated medical snapshots (MCP-owned `shared/health/generated/`)

## Layout

```text
SCHEMA.md index.md log.md
raw/ entities/ concepts/
shared/          # bind of host ${WIKI_ROOT}/shared
  health/
```
