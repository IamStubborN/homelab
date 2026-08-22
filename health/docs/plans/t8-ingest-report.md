# T8 ingest report (counts only)

One-shot Здоровье ingest via `health_mcp.store.WikiStore` (`via=system`).
No medical payloads. Google Docs/Sheet archive was not modified.
`valentyna-teeth/Data.zip` was not copied. G3 host vault was not used.

This laptop run wrote a temp vault at `/tmp/t8-wiki-gJcx` (not in git).
Detailed skip quotes and generated-page text live in the session private report, not here.

## Created
- allergy:valentyna: 1
- condition:andrii: 6
- condition:valentyna: 5
- lab:andrii: 62
- lab:valentyna: 52
- meal:valentyna: 2
- measurement:andrii:blood_pressure: 56
- measurement:andrii:weight: 23
- measurement:valentyna:blood_pressure: 10
- measurement:valentyna:weight: 3
- medication:andrii: 6
- medication:valentyna: 8
- sleep:andrii: 6
- symptom:andrii: 2
- symptom:valentyna: 5

## Expected vs parsed
- parsed buckets matched map §6 / §4 sheet counts

## G4 sample identifiers (no payloads)

Present in the temp vault jsonl / `generated/`:

- `xlsx:andrii:r5` (Andrii photo BP)
- `xlsx:valentyna:r5` (Valentyna photo BP)
- `xlsx:weight:r5:andrii` and `xlsx:weight:r5:valentyna` (same timestamp split)
- `xlsx:andrii-sleep:r5`
- six current Andrii medications; Mounjaro absent
- Valentyna wheat allergy; Panixen/Panixen Focus absent from current meds; lactulose present
- Andrii HbA1c and Valentyna Total bilirubin present in `labs.jsonl` / `*_RECENT_LABS.md`

Skipped as required: `xlsx andrii!r66`, `xlsx weight!r32:andrii`, H. pylori, Lipoprotein (a) inequality, garbled chronology.

## Map count notes
- Valentyna conditions: ingest §6.5 (5). Map §4.1 said 6; joints row is a skip.
- Symptoms: ingest §6.4 (2) + §6.9 (5) = 7. Map §4.1 said 8.

## Skips (identifiers only)
- `xlsx andrii!r21`: empty spacer
- `xlsx andrii!r28`: empty spacer
- `xlsx andrii!r30`: empty spacer
- `xlsx andrii!r37`: empty spacer
- `xlsx andrii!r39`: empty spacer
- `xlsx andrii!r51`: empty spacer
- `xlsx andrii!r54`: empty spacer
- `xlsx andrii!r56`: empty spacer
- `xlsx andrii!r60`: empty spacer
- `xlsx andrii!r63`: empty spacer
- `xlsx andrii!r66`: missing time
- `xlsx weight!r13`: empty spacer
- `xlsx weight!r17`: empty spacer
- `xlsx weight!r24`: empty spacer
- `xlsx weight!r31`: empty spacer
- `xlsx weight!r32:andrii`: missing time
- `xlsx andrii-meds!r11`: status Не начат (not Принимается)
- `docs andrii §1 12.07.2026`: approximate weight and no time
- `docs andrii §1 23.07.2026`: weight with no time
- `docs valentyna §6 IgE table`: IgE table has no test_date and no source PDF; class 0 is not an allergy
- `docs valentyna §6 retinol/SPF`: mechanism not confirmed; must not be stored as allergy
- `docs valentyna §5.2 J06.0`: unattributed; not a Valentyna condition
- `docs valentyna §7 joints`: too vague; exact diagnosis not stated
- `docs valentyna §7.1 Panixen Focus`: prescribed; start not confirmed
- `docs valentyna §7.1 Panixen`: prescribed; start not confirmed
- `docs valentyna §7 barley powder`: optional, may be skipped; not a standing med
- `docs andrii §8/§9`: chronology/journal not ingested as facts (garbled)
- `docs valentyna §9/§11`: chronology/journal not ingested as facts (garbled)
- `docs andrii §9 26.07 sleep`: approximate sleep (примерно 09:00–09:30); journal only
- `docs andrii §9 enalapril`: deleted on user request; not a medication fact
- `docs valentyna 25.07 cycle`: первый день менструации is journal-only; no cycle cashier type
- `csv Дневник показателей здоровья.csv`: incomplete Sheet export; cross-check only, not ingested
- `pdf Andrii_ramus_23_07_26.pdf`: partial early print; copied to raw/, not parsed
- `healthdrive:valentyna-teeth/Data.zip`: excluded from this ingest
- `docs valentyna 1700 kcal`: daily planning target, not a meal
- `pdf:andrii:Protein (spot urine)`: qualitative or inequality result
- `pdf:andrii:Glucose (spot urine)`: qualitative or inequality result
- `pdf:andrii:Ketone (spot urine)`: qualitative or inequality result
- `pdf:andrii:Bilirubin (spot urine)`: qualitative or inequality result
- `pdf:andrii:Blood (spot urine)`: qualitative or inequality result
- `pdf:andrii:Leucocytes (spot urine)`: qualitative or inequality result
- `pdf:andrii:Nitrite (spot urine)`: qualitative or inequality result
- `pdf:andrii:Urobilinogen (spot urine)`: qualitative or inequality result
- `pdf:andrii:RBC`: urine sediment
- `pdf:andrii:WBC`: urine sediment
- `pdf:andrii:Squamous epithelial cells`: urine sediment
- `pdf:andrii:Non-squamous epithelial cells`: urine sediment
- `pdf:andrii:Hyaline casts`: urine sediment
- `pdf:andrii:Granular casts`: urine sediment
- `pdf:andrii:Calcium oxalate crystals`: urine sediment
- `pdf:andrii:Bacteria`: urine sediment
- `pdf:andrii:Yeasts`: urine sediment
- `pdf:andrii:Lipoprotein (a)`: inequality result, not a float
- `pdf:valentyna:Protein (spot urine)`: qualitative or inequality result
- `pdf:valentyna:Glucose (spot urine)`: qualitative or inequality result
- `pdf:valentyna:Ketone (spot urine)`: qualitative or inequality result
- `pdf:valentyna:Bilirubin (spot urine)`: qualitative or inequality result
- `pdf:valentyna:Blood (spot urine)`: qualitative or inequality result
- `pdf:valentyna:Leucocytes (spot urine)`: qualitative or inequality result
- `pdf:valentyna:Nitrite (spot urine)`: qualitative or inequality result
- `pdf:valentyna:Urobilinogen (spot urine)`: qualitative or inequality result
- `pdf:valentyna:RBC`: urine sediment
- `pdf:valentyna:WBC`: urine sediment
- `pdf:valentyna:Squamous epithelial cells`: urine sediment
- `pdf:valentyna:Non-squamous epithelial cells`: urine sediment
- `pdf:valentyna:Hyaline casts`: urine sediment
- `pdf:valentyna:Granular casts`: urine sediment
- `pdf:valentyna:Calcium oxalate crystals`: urine sediment
- `pdf:valentyna:Bacteria`: urine sediment
- `pdf:valentyna:Yeasts`: urine sediment
- `pdf:valentyna:Pancreatic lipase`: empty result column
- `pdf:valentyna:Cortisol`: empty result column
- `pdf:valentyna:Total L-homocysteine`: empty result column
- `pdf:valentyna:Vitamin B6`: empty result column
- `pdf:valentyna:Vitamin B1`: empty result column
- `pdf:valentyna:Helicobacter pylori IgA`: H. pylori not a float; EN empty / BG (-) negative is ambiguous
- `pdf:valentyna:Helicobacter pylori IgG`: H. pylori not a float; EN empty / BG (-) negative is ambiguous

## Raw copies
- 11 files copied into vault `raw/`

## Re-run against $WIKI_ROOT (after G3)

Do not run this against `/mnt/internal/wiki` until G3. After G3:

```bash
wiki/bootstrap-vault.sh "$WIKI_ROOT"
cd health/mcp
python3 -m health_mcp.ingest \
  --wiki-root "$WIKI_ROOT/shared/health" \
  --export-dir /tmp/zdorovie-export \
  --xlsx "/tmp/zdorovie-xlsx/Дневник показателей здоровья.xlsx" \
  --raw-src /tmp/t8-zdorovie-raw
```

Meds/conditions/allergies have no `source_event_id`; do not re-run without `--force` on an empty tree.
G4 still applies: do not delete Google Docs/Sheet.
