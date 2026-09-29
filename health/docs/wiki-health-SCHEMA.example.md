<!--
  Example shared/health/SCHEMA.md. Live files are created on the host by T7.
  Do not commit vault contents.
-->

# SCHEMA

Family health wiki. Append-only medical facts are jsonl written only by the
health MCP cashier. Hermes reads generated markdown via llm-wiki and may write
synthesis pages. Humans browse the same tree in Obsidian.

## Hard rules

- `person` on every page (`primary` or `secondary`). Family-level pages use
  `person: family` and must not mix spouses' clinical facts on that page.
- No mixing Primary and Secondary on one synthesis page.
- Never edit `data/` or `generated/`. Those paths are MCP-owned and
  overwrite-safe for the cashier.
- Do not use the terminal, files, or SQL to mutate health facts.
- Medical facts go through MCP. Wiki pages are synthesis, not the ledger.

## Layout

```text
SCHEMA.md index.md log.md
data/{primary,secondary}/*.jsonl      # MCP only
generated/*.md                       # MCP only; read these, never edit
people/{primary,secondary}/*.md       # synthesis; one person per page
family/                              # household notes, no mixed clinical facts
raw/{primary,secondary,family}/       # source documents; do not treat as facts
```

## Reading current state

Use `generated/` (for example `PRIMARY_CURRENT_PROFILE.md`,
`SECONDARY_CURRENT_MEDICATIONS.md`, `PRIMARY_RECENT_MEASUREMENTS.md`,
`SECONDARY_ALLERGIES.md`). Do not read jsonl to answer a chat question.

## Writes

Hermes: MCP tools for facts; llm-wiki for synthesis under `people/` and
`family/` only. Corrections are new MCP events, not edits of old jsonl lines.
