# T8 — Ingest map (Scout)

Status: scout findings for T8 Worker  
Date: 2026-08-19  
Plan: `health/docs/plans/2026-08-19-family-health-wiki.md` §1.4 / §1.9 / T8  
This file does not ingest, does not write jsonl, and is not medical advice.

Laptop exports were present and used. Drive was listed read-only via rclone remote `healthdrive:`. Nothing was written to Drive or to `Здоровье/`.

---

## 0. Worker constraints (do not guess)

1. Call `health_mcp.store.WikiStore` methods (`add_measurement`, `add_sleep_record`, `add_medication`, `add_condition`, `add_allergy`, `add_lab_result`, `add_meal`, `add_symptom`). Do **not** format or append jsonl by hand. Do **not** invent a second schema.
2. Ingest identity: construct `Identity(actor="<person>", via="system", default_person="<person>")` and pass `person=` on every call. Bearer `TokenMap` never assigns `via=system`; HTTP MCP with a Hermes token would stamp `hermes_*`. A one-shot CLI that imports `WikiStore` is the intended path.
3. `add_medication` / `add_condition` require `confirmed=true` (operator confirmation for this one-shot).
4. `add_medication` sets `started_at=now` if omitted. Never omit `started_at`.
5. `source_event_id` is printable ASCII, no spaces, ≤200 bytes. Use the ids in this file. Labs/meds/conditions/allergies have no `source_event_id` argument on the writer today; rely on payload+time dedup for labs and do not double-call.
6. Measurement `values` reject extra keys and reject floats for integer fields. Cast sheet `148.0` → `148`.
7. `add_lab_result.value` is a required float. Qualitative / inequality / range results are **skip**, quoted below. Do not store `0` for “negative” or `3.1` for `<3.1`.
8. Timezone: every sheet/Doc clock time is naive local. Ramus PDF `CreationDate`/`ModDate` are `EEST`. Collection branch is Varna. Use `Europe/Sofia`. July–August 2026 is EEST = `+03:00`. Do **not** store naive times and do **not** silently use UTC.
9. Primary SoT by type is in §2. Do **not** parse Docs §8/§9 (Andrii) or §9/§11 (Valentyna) as facts.
10. Do not ingest `healthdrive:valentyna-teeth/Data.zip`.
11. Do not invent missing times as `00:00`. Skip those rows (listed).
12. Do not ingest model “рабочая интерпретация / рабочий вывод” blocks.
13. Do not copy ЛНЧ / UIN / address into jsonl. PDFs in `raw/` already contain them.

---

## 1. Source inventory

| Path | Kind | Used as | Notes |
| --- | --- | --- | --- |
| `/tmp/zdorovie-export/Andrii.txt` | Google Doc export (UTF-8 BOM, CRLF), last line “Последнее обновление: 12.08.2026” | Profile facts **except** §8 Хронология and §9 Журнал обновлений | 459 lines. Garbled from mid-§8. |
| `/tmp/zdorovie-export/Valentyna.txt` | Google Doc export, “Последнее обновление: 05.08.2026” | Profile facts **except** §9 Хронология and §11 Журнал обновлений | 295 lines. Garbled from mid-§9 / throughout §11. |
| `/tmp/zdorovie-export/Дневник показателей здоровья.csv` | Incomplete Sheet export | **Do not ingest.** Cross-check only | Andrii BP sheet only (52 data rows + blanks). No sleep, Valentyna BP, weight, or meds. |
| `/tmp/zdorovie-xlsx/Дневник показателей здоровья.xlsx` | Excel export of the same Sheet | **SoT for diary rows** | 5 sheets. See §3. |
| `healthdrive:Здоровье/` | Drive folder (do not modify) | Binaries + live Docs/Sheet archive | Listed 2026-08-19. See §8. |
| `healthdrive:valentyna-teeth/Data.zip` | 134 225 473 bytes, 2025-12-02 | **Excluded** | Locked out of this plan. |

Drive `Здоровье/` names (rclone `lsf`, 2026-08-19):

| Name | Size | Date | Role |
| --- | --- | --- | --- |
| `Andrii` (Google Doc; export `Andrii.txt`) | — | 2026-08-12 17:20 | Live archive; do not delete |
| `Valentyna` (Google Doc; export `Valentyna.txt`) | — | 2026-08-05 18:50 | Live archive |
| `Дневник показателей здоровья` (Google Sheet; csv/xlsx exports) | — | 2026-08-12 17:19 | Live archive |
| `Andrii_Ramus_2026-07-23_EN_full.pdf` | 61722 | 2026-08-04 22:15 | Andrii labs SoT (English names) |
| `Andrii_Ramus_2026-07-23_BG_full.pdf` | 68281 | 2026-08-04 22:15 | Same draw; better reference ranges |
| `Andrii_ramus_23_07_26.pdf` | 68212 | 2026-07-23 21:49 | **Partial** same order (23.07 print). Missing values: Lp(a), cortisol, homocysteine, B1. Do not ingest this file. |
| `Valentyna_Ramus_2026-08-05_EN.pdf` | 61380 | 2026-08-05 17:20 | Valentyna labs (English names) |
| `Valentyna_Ramus_2026-08-05_BG.pdf` | 68425 | 2026-08-05 17:20 | Same draw; refs + H. pylori line present |
| `Valentyna — назначение Panixen, Panixen Focus и лактулозы — 28.07.2026.jpeg` | 394505 | 2026-07-28 19:28 | Prescription photo. 1290×1720 JPEG |

Doc-embedded Drive URLs (already in the exports; Worker copies by rclone name, not by rewriting Drive):

- Andrii full protocol: `https://drive.google.com/file/d/1nAyv9qDQrTvH_ILNm4OFPzucgl7TzzF7/view`
- Panixen JPEG: `https://drive.google.com/file/d/1Kwp7z4MpCsM9tlnSz56mf7uJWivsG7pz/view?usp=drivesdk`

xlsx sheets (exact titles):

| Sheet | Header row | Data rows | Used for |
| --- | --- | --- | --- |
| `Andrii` | R4 | R5–R66 (52 nonempty; 10 empty spacers) | `measurements` blood_pressure |
| `Сон Andrii` | R4 | R5–R10 (6) | `sleep` |
| `Valentyna` | R4 | R5–R14 (10) | `measurements` blood_pressure |
| `Вес` | R4 | R5–R32 (24 nonempty; 4 empty spacers) | `measurements` weight — **split C/D, never ingest E/F** |
| `Приём препаратов Andrii` | R4 | R5–R11 (7) | `medications` |

There is no Valentyna meds sheet, no meals sheet, no labs sheet, no allergies sheet, no cycle sheet.

---

## 2. Which source wins per §1.4 type

| jsonl type | Primary | Secondary (profile sections only) | Never |
| --- | --- | --- | --- |
| measurements BP | xlsx `Andrii` / `Valentyna` | Docs §2 / §5.1 extras listed in §5.1 | Chronology/journal; CSV |
| measurements weight | xlsx `Вес` columns C/D | Docs §1 extras listed in §5.2 | Derived delta columns; “около”; undated |
| measurements pulse / temp / spo2 / glucose | none in sources | — | Do not split BP pulse into `kind=pulse`. Lab glucose is `labs`, not `glucose` measurement |
| sleep | xlsx `Сон Andrii` | — | Docs §9 garbled 26.07 approximate sleep |
| medications | xlsx `Приём препаратов Andrii` | Valentyna Docs §7 + §7.1 | Mounjaro; Panixen/Panixen Focus (start unconfirmed); deleted enalapril |
| conditions | Docs profile sections quoted in §6 | — | Model hypotheses presented as diagnosis; J06.0 (unattributed) |
| allergies | Valentyna Docs §6 clinical wheat only | — | Class-0 IgE; retinol/SPF as “allergy”; Andrii (none stated) |
| labs | Ramus **full** PDFs (EN names + BG refs) | — | Docs lab prose; early Andrii PDF; empty/pending rows; qualitative |
| meals | Valentyna Docs §10 two food descriptions only | — | 1700 kcal target; daily habits replayed as meals |
| symptoms | Docs profile sections quoted in §6.4 | — | Chronology restatements |

Demographics (name, DOB, height, sex) are **not** a cashier type. After ingest they belong on `people/{andrii,valentyna}/*.md` synthesis, not jsonl.

---

## 3. Column maps

### 3.1 Common time parse

Sheet cells mix `datetime.datetime` / `datetime.time` and strings `dd.MM.yyyy` / `HH:mm[:ss]`.

```
event_local = date(A) + time(B)
event_time  = event_local.isoformat() + "+03:00"
```

Examples that must parse the same:

- `datetime(2026,7,21)` + `time(10,11,6)` → `2026-07-21T10:11:06+03:00`
- `'26.07.2026'` + `'03:39:01'` → `2026-07-26T03:39:01+03:00`
- `'25.07.2026'` + `time(14,59)` → `2026-07-25T14:59:00+03:00` (sheet has no seconds; Docs §2 says `14:59:52` — **use the sheet**)

Skip if `A` missing or `B` missing (do not invent midnight).

`source` field (measurements): `Источник` verbatim; if `Комментарий` nonempty append ` | {Комментарий}`.

`status`:

| Источник contains | status |
| --- | --- |
| `Фото` | `confirmed_by_document` |
| `Со слов` | `user_reported` |

### 3.2 `Andrii` / `Valentyna` → `add_measurement`

| Col | Header | Writer field |
| --- | --- | --- |
| A | Дата | date part of `event_time` |
| B | Время | time part of `event_time` |
| C | Систолическое, мм рт. ст. | `values.systolic` int |
| D | Диастолическое, мм рт. ст. | `values.diastolic` int |
| E | Пульс, уд/мин | `values.pulse` int (optional only if blank; no blank pulse on accepted rows) |
| F | Пульсовое давление | **drop** (derived) |
| G | Среднее АД (расчётное) | **drop** (derived) |
| H | Тип измерения | must be `Артериальное давление` or skip |
| I | Источник | see status/source |
| J | Комментарий | append to `source` |
| K | Дата внесения | **not** `event_time` (entry date ≠ measurement date) |

```
kind = "blood_pressure"
values = {"systolic": int(C), "diastolic": int(D), "pulse": int(E)}
source_event_id = "xlsx:andrii:r{N}" or "xlsx:valentyna:r{N}"
```

Do **not** emit a second `kind=pulse` event.

Averaged rows already store the user-rounded mean (comment describes the raw pair). Ingest C/D/E as stored. Do not re-average and do not also ingest the raw pair from the comment.

Empty spacer rows (Andrii R21, R28, R30, R37, R39, R51, R54, R56, R60, R63): skip, no event.

### 3.3 `Сон Andrii` → `add_sleep_record`

| Col | Header | Writer field |
| --- | --- | --- |
| A | Дата | calendar date for both ends (all 6 rows are same-day) |
| B | Начало сна | `start_time` |
| C | Пробуждение | `end_time` |
| D | Длительность, ч | **drop** (derived) |
| E | Длительность | **drop** (derived) |
| F | Комментарий | `notes` |
| G | Источник | all six are `Со слов пользователя` → `user_reported` |
| H | Дата внесения | drop |

```
source_event_id = "xlsx:andrii-sleep:r{N}"
start_time/end_time = date(A) + time(B/C) + "+03:00"
```

All six have `end > start` on the same date. There is no overnight row.

### 3.4 `Вес` → `add_measurement` (broken layout)

Header R4 is intact in this xlsx. The trap is **two people plus two derived deltas on one row**. Reading by position without the header, or treating E/F as kg, invents weights.

| Col | Header | Rule |
| --- | --- | --- |
| A | Дата | date |
| B | Время | time; R32 is `None` → skip that person-event |
| C | Valentyna, кг | Valentyna `values.value` **only if numeric** |
| D | Andrii, кг | Andrii `values.value` **only if numeric** |
| E | Изменение Valentyna, кг | **never ingest** (delta) |
| F | Изменение Andrii, кг | **never ingest** (delta) |
| G | Источник | status/source for **each** emitted event |
| H | Дата внесения | drop |

Empty vs garbage in C/D: `None` and `''` mean “no measurement for that person on this row”. Do not write 0.

One row may emit **zero, one, or two** events:

```
if C is number and B present:
    add_measurement(person="valentyna", kind="weight",
                    values={"value": float(C), "unit": "kg"},
                    source_event_id="xlsx:weight:r{N}:valentyna")
if D is number and B present:
    add_measurement(person="andrii", kind="weight",
                    values={"value": float(D), "unit": "kg"},
                    source_event_id="xlsx:weight:r{N}:andrii")
```

R5 and R11 have **both** C and D numeric (same clock time for both people). Split. Do not drop one.

R11 comment: `вес Valentyna исправлен с 76,25 кг на 75,9 кг`. Ingest **75.9** only. Do not also write 76.25.

Row order is not chronological (R25 `09.08 12:05` sits above R26 `09.08 09:00`). Use A+B, not row index, for `event_time`.

### 3.5 `Приём препаратов Andrii` → `add_medication`

| Col | Header | Writer field |
| --- | --- | --- |
| A | Препарат | `name` |
| B | Статус | `Принимается` → ingest; `Не начат` → **skip** |
| C | Дата начала | `started_at` = that date `T00:00:00+03:00` (date only in source) |
| D | Доза | `dose` |
| E | Частота | start of `schedule` |
| F | Относительно еды | append to `schedule` |
| G | Когда принимать | append to `schedule` |
| H | Курс | append to `schedule` as `course: …` |
| I | Пропуски | do not invent `stopped_at` |
| J | Примечание | append to `schedule` |

```
schedule = "{E}; {F}; {G}; course: {H}; {J}"
status = "user_reported"   # start dates are user-stated
# Липантил / Vigantol / Ademta also appear as doctor-prescribed in Docs §2.1
# → status "confirmed_by_doctor" for those three only (see §6.2)
```

Sheet banner: last update **28.07.2026**. Do not auto-stop Ademta (1-month course from 28.07 would end ~28.08, after this scout date). No reported misses.

### 3.6 Labs → `add_lab_result`

From the **full** Ramus PDFs only.

```
person          = andrii | valentyna
test_date       = sample collection date on the PDF (not print date)
test_name       = English test name in §7 (stable, ASCII)
value           = float as printed
unit            = unit as printed (umol/l, G/l, T/l, uIU/ml, ug/dl, ng/ml, …)
reference_min / reference_max = only when the printed range is a single bound pair (rules below)
flag            = "H" or "L" when the PDF marks H/L; else omit
laboratory      = "SMDL Ramus"
source_document = vault-relative path after copy, e.g. "raw/andrii/Andrii_Ramus_2026-07-23_EN_full.pdf"
status          = "confirmed_by_document"
```

Reference parse (do not invent the other bound):

| Printed | Store |
| --- | --- |
| `3.9 - 10.2` / `3.9-10.2` | min=3.9, max=10.2 |
| `<15` / `<=5.00` | max only |
| `>=1.55` | min only |
| `>30; >150 toxic` | **omit both** (two thresholds) |
| `< 3.60; препоръчани стойности < 3.0` | **omit both** |
| `<15 m; <20 f` | Valentyna is female on the PDF → max=20 only |
| `<45 m; <34 f` | Valentyna → max=34 |
| `3.2-7.4 m; 2.5-6.7 f` | Valentyna → min=2.5, max=6.7 |
| missing on EN, present on BG | use BG numbers |

Prefer EN `test_name` + BG numeric refs when EN omitted the range (Valentyna lipids/electrolytes). One event per test. Do **not** ingest both language PDFs.

`test_date`:

- Andrii: `2026-07-23` (collection). Registration `23.07.2026 8:15:26`. Print of the **full** file: `04.08.2026 22:08:33` BG / `22:12:35` EN. Do not use print day as `test_date`.
- Valentyna: `2026-08-05`. Registration `05.08.2026 8:33:22`.

Glucose is labelled `Glucose random or fasting` / `Glucose random nonpregnant`. Valentyna Docs §12 says the user stated fasting + one glass of water 40–50 min prior. Store the PDF name and value `5.4`; do not rename to “fasting glucose”. Andrii glucose `7.4` stays as printed; Docs already note fasting status is unclear.

### 3.7 Conditions / allergies / meals / symptoms

No sheet. Use the verbatim lists in §6. `diagnosed_at` omitted when the source has no date. `started_at` for Valentyna supplements: first-mentioned date in the **profile** section (not journal), documented per row.

---

## 4. Counts

### 4.1 Accepted vs skip (Worker must match these)

| Bucket | Candidates looked at | Accept | Skip | Skip reasons |
| --- | --- | --- | --- | --- |
| Andrii BP (xlsx `Andrii`) | 52 nonempty + 10 empty | **51** | 11 | 10 empty spacers; R66 no time |
| Valentyna BP (xlsx `Valentyna`) | 10 | **10** | 0 | |
| Andrii sleep (xlsx) | 6 | **6** | 0 | |
| Andrii sleep (Docs journal 26.07 approx.) | 1 | **0** | 1 | garbled / approximate; see §5.4 |
| Andrii weight (xlsx D) | 23 numeric D | **22** | 1 | R32 no time (`117.3`) |
| Valentyna weight (xlsx C) | 3 numeric C | **3** | 0 | |
| Weight empty C/D / deltas | 24 rows × unused cells | 0 | all | empty string/None; columns E/F |
| Andrii meds (xlsx) | 7 | **6** | 1 | Mounjaro `Не начат` |
| Valentyna meds (Docs §7/§7.1) | 11 named | **8** | 3 | Panixen + Panixen Focus start unconfirmed; barley powder not daily (optional skip) |
| Andrii labs (full PDF numeric) | see §7.1 | **62** | rest of panel | qualitative, `<3.1`, sediment ranges, early PDF |
| Valentyna labs (full PDF numeric) | see §7.2 | **52** | pending + qualitative | lipase/cortisol/B1/B6/Hcy empty; H. pylori not a float |
| Andrii conditions | 7 named | **6** | 1 | do not store “diabetes T2” (explicitly not confirmed) |
| Valentyna conditions | 7 named + J06.0 | **6** | 1+ | J06.0 unattributed; joints too vague → listed skip |
| Allergies | IgE table + clinical + retinol/SPF | **1** | rest | only clinical wheat; IgE without source PDF and no `test_date`; class 0 not allergies |
| Meals | 3 food notes + habits | **2** | habits / kcal target | |
| Symptoms | see §6.4 | **8** | chronology dupes | |

### 4.2 Docs-only extras (not on the sheet)

Ingest from **profile** sections only, with `source_event_id` below. Do not also invent them from the journal.

Andrii BP in Docs §2 but **absent** from xlsx `Andrii`:

| Local time | Stored values | source_event_id | status |
| --- | --- | --- | --- |
| 26.07.2026 22:22:27 | 123/93, pulse 94 | `docs:andrii:bp:2026-07-26T22:22:27` | `user_reported` (photo mentioned in §8 journal only — ignore journal; §2 does not say “фото” on this line) |
| 28.07.2026 22:47:57 | 131/89, pulse 84 (mean of 129/88 p80 and 133/89 p88) | `docs:andrii:bp:2026-07-28T22:47:57` | `user_reported` |
| 30.07.2026 23:32:00 | 122/78, pulse 94 (mean of 121/76 p90 and 122/80 p98) | `docs:andrii:bp:2026-07-30T23:32:00` | `user_reported` |
| 01.08.2026 10:31:22 | 134/92, pulse 69 | `docs:andrii:bp:2026-08-01T10:31:22` | `user_reported` |
| 04.08.2026 09:39:00 | 141/89, pulse 76 | `docs:andrii:bp:2026-08-04T09:39:00` | `user_reported` |

Andrii weight in Docs §1 but **absent** from xlsx `Вес`:

| Local time | kg | source_event_id | Rule |
| --- | --- | --- | --- |
| 30.07.2026 23:32:00 | 119.1 | `docs:andrii:weight:2026-07-30T23:32:00` | accept, `user_reported` |
| 12.07.2026 (no time) | “около 120” | — | **skip** (approximate + no time) |
| 23.07.2026 (no time) | 123 | — | **skip** (no time) |

Valentyna weight: sheet has the only three dated points (78.3 / 75.9 / 76.9). “Обычный диапазон 78–80 кг” is **not** a measurement.

**Accept totals if Worker includes Docs-only extras:** Andrii BP 51+5=56, Andrii weight 22+1=23.

### 4.3 Must-skip rows (quote, do not fix)

Andrii xlsx R66 (no time):

```
12.08.2026 | (empty) | 150 | 102 | 85 | 48 | 118.0 | Артериальное давление | Со слов пользователя | Время измерения не указано пользователем. | 12.08.2026
```

Вес R32 (no time):

```
12.08.2026 | (empty) | (empty) | 117.3 | (empty) | -0.2 | Со слов пользователя; время не указано. | 12.08.2026
```

Mounjaro xlsx R11:

```
Mounjaro | Не начат | — | 2,5 мг/доза | Назначено 1 раз в неделю | Не зависит от еды | Не применяется | 4 дозы на 30 дней | Не применимо | Не куплен; решение отложено до отдельного обсуждения
```

Do not call `add_medication` (writer would force a `started_at`).

---

## 5. Garbled chronology — do not parse as facts

### 5.1 Andrii.txt

Clean enough to read: title through §7 (inclusive), and §2.1 meds / §5 labs as **cross-check only**.

Do **not** ingest from:

- **§8 Хронология** starting around the smashed BP lines
- **§9 Журнал обновлений** (header sits in the middle of §8; later lines are concatenated)

Quoted collisions (leave as text; do not “repair” into events):

```
- 21.07.2026 10:11:06: домашнее измерение по фото тонометра — 148/106 мм рт. ст., пульс 69 уд/мин.
- 24.07.2026 14:29:11: домашнее изме- 24.07.2026 23:11:10: домашнее измерение по фото тонометра — 118/86 мм рт. ст., пульс 83 уд/мин.
рение по фото тонометра — 132/86 мм рт. ст., пу- 24.07.2026: добавлено домашнее измерение давления 118/86 мм рт. ст., пульс 83 уд/мин.
льс 60 уд/мин.
```

```
- 25.07.2026: добавлено домашнее измерение давления 136/97- 25.07.2026 15:13:13: масса 120,5 кг; изм- 25.07.2026: обновлена текущая масса Andrii до 120,5 кг; добавлена новая точка в Google Sheets, изменение относительно 24.07.2026 — −1,8 кг.
енение относительно предыдущего замера — минус 1,8 кг.
 мм рт. ст., пульс 91 уд/мин.
```

```
- 28.07.2026: уточнено, что у Andrii ранее не было выраженных - 28.07.2026: подтвержден фактический старт Vigantol, Ademta 400 мг и Omega-3; схема приема отмечена как текущая, пропусков не сообщалось.
проблем с ЖКТ; пользователь опасается начала Mounjaro …
```

```
- 26.07.2026: со слов пользователя, сон примерно с 09:00–09:30 до 16:00; продолж
- 28.07.2026: со слов пользователя подтвержден фактический старт Vigantol, Ademta 400 мг и California Gold Nutrition Omega-3 Premium Fish Oil. …
ительность около 6 ч 30 мин–7 ч. Время начала указано приблизительно.
- 26.07.2026: в журнал добавлен приблизительный период дневного сна Andrii 09:00–09:30 — 16:00.
```

The 26.07 sleep is approximate (`примерно`, `09:00–09:30`) and only lives in this smashed journal. **Skip.**

Also in §9, do not treat as a medication fact:

```
- 23.07.2026: по просьбе пользователя удалены все сведения об эналаприле и его дозировках.
```

### 5.2 Valentyna.txt

Clean enough: §1–§8 and §10 (nutrition) and §12 (labs prose as cross-check only) and §7.1 (prescription).

Do **not** ingest from **§9 Хронология** or **§11 Журнал обновлений**.

Quoted collisions:

```
- 24.07.2026: со слов пользователя давление у Valenty
- 24.07.2026 23:10:36: домашнее измерение давления — 119/76 мм рт. ст., пульс 67 уд/мин.na в норме; эпизод 146/106 к ней не относится.
```

```
- 24.0
- 24.07.2026: добавлено домашнее измерение давления Valentyna по фотографии тонометра — 119/76 мм рт. ст., пульс 67 уд/мин.7.2026: обновлен раздел артериального давления — зафиксировано, что давление у Valentyna в норме и значение 146/106 к ней не относится.
```

```
- 24.07.2026: добавлены утренний режим питания/напитков и жалобы на проблемы со стулом, усиливающиеся в конце лютеиновой фа
- 24.07.2026: уточнено, что хронический гастрит находится в длительной ремиссии; …
- 24.07.2026: уточнено, что текущие эпизоды замедления работы кишечника связаны преимущественно с предменструальной/лютеиновой фазой, а не с активным гастритом.зы.
```

```
- 23.07.2026: создан первоначальный профиль.- 25.07.2026: первый день менструации; …
```

**146/106 is Andrii** (xlsx `Andrii` R5 is 148/106 on 21.07; recalled 146/106 is explicitly “к Valentyna не относится”). Never write it on Valentyna.

**J06.0** (Docs §5.2): “Неясно, относится ли диагноз к Valentyna.” Do not add a condition.

Cycle: “25.07.2026: первый день менструации” appears only inside the garbled journal/profile smash. There is **no** cycle cashier type. Leave `VALENTYNA_CYCLE_CONTEXT.md` as the T4 stub. Quote that sentence in the ingest report; do not invent a jsonl row.

---

## 6. Facts the generated profiles must list after ingest

`generate.py` prints current (unstopped) meds, all conditions, all allergies, latest measurements, recent labs. After a correct ingest the pages should contain at least the following **source facts** (wording will follow the generator templates, not this prose).

### 6.1 Andrii — conditions

| `name` | `status` | `diagnosed_at` | `notes` (store verbatim enough to not invent) |
| --- | --- | --- | --- |
| Obstructive sleep apnea | `confirmed_by_doctor` | omit | Confirmed by a doctor several years ago; date/severity/study not in project; CPAP recommended, device not obtained; not used now |
| Arterial hypertension | `suspected` | omit | Formal diagnosis/stage not recorded; repeating home BP |
| Prediabetes | `suspected` | omit | HbA1c 6.2% is the lab; diagnosis not confirmed by a doctor in these sources |
| Insulin resistance | `suspected` | omit | HOMA-IR 8.5 on Ramus 23.07.2026; not a standalone confirmed diagnosis |
| Metabolic dysfunction-associated steatotic liver disease | `suspected` | omit | Docs label this a working hypothesis, not a confirmed diagnosis |
| Metabolic syndrome | `suspected` | omit | Docs: formal diagnosis not confirmed by a doctor |

Do **not** add type 2 diabetes. Docs: “Диабет 2 типа требует подтверждения или исключения”.

Do **not** add “obesity I” as a condition (BMI is derived in Docs §1, not a recorded diagnosis).

### 6.2 Andrii — current medications (xlsx R5–R10)

| `name` | `dose` | `schedule` (compose as §3.5) | `started_at` | `status` |
| --- | --- | --- | --- | --- |
| Рамихексал | 5 мг, 1 таблетка | 1 раз в день; Можно независимо от еды; Ежедневно примерно в одно и то же время; course: Не указан; Контроль давления, креатинина и калия | 2026-07-23T00:00:00+03:00 | `user_reported` |
| Oxibio Antioxidant | 1 таблетка | 1 раз в день; Во время или после еды; С основным приёмом пищи; course: Не указан; Пищевая добавка | 2026-07-23T00:00:00+03:00 | `user_reported` |
| Липантил 200М | 200 мг, 1 капсула | 1 раз в день; Во время еды; С полноценным основным приёмом пищи; course: 3 месяца; Фенофибрат; капсулу глотать целиком | 2026-07-27T00:00:00+03:00 | `confirmed_by_doctor` |
| Vigantol | 5 капель | 1 раз в день; С едой; С основным приёмом пищи; course: 3 месяца; Витамин D3 | 2026-07-28T00:00:00+03:00 | `confirmed_by_doctor` |
| Ademta | 400 мг, 1 таблетка | 2 раза в день; Между приёмами пищи, не вместе с едой; 1-я после пробуждения; 2-я между приёмами пищи, не перед сном; course: 1 месяц; Таблетку глотать целиком | 2026-07-28T00:00:00+03:00 | `confirmed_by_doctor` |
| California Gold Nutrition Omega-3 Premium Fish Oil | 2 капсулы = EPA 360 мг + DHA 240 мг | 1 раз в день; С едой; С основным приёмом пищи; можно разделить 1+1; course: Не указан; Доза производителя; врачебная лечебная доза отдельно не подтверждена | 2026-07-28T00:00:00+03:00 | `user_reported` |

Mounjaro: prescribed 27.07.2026, **not purchased, not started**. Must **not** appear on `ANDRII_CURRENT_MEDICATIONS.md`. Mention only in the ingest report / people page.

### 6.3 Andrii — latest measurements the profile will show

Generator keeps the latest 10 measurements across kinds (sorted by `event_time`). After ingest the newest dated sheet points are:

- 2026-08-12T09:38:00+03:00 weight 117.5 kg
- 2026-08-12T09:38:00+03:00 BP 140/90 pulse 75
- 2026-08-11T09:38:00+03:00 weight 118.25
- 2026-08-11T09:26:00+03:00 BP 138/88 pulse 72
- 2026-08-10T12:42:00+03:00 BP 143/92 pulse 75
- 2026-08-10T09:38:00+03:00 weight 118.3 and BP 127/90 pulse 73

Skipped undated 12.08 150/102 and 117.3 kg will **not** appear unless the user later supplies a time (G4).

### 6.4 Andrii — symptoms (optional but sourced)

| description | event_time | status |
| --- | --- | --- |
| Restless, very light sleep; very loud snoring | 2026-07-24T00:00:00+03:00 | `user_reported` |
| Chaotic sleep schedule; sometimes 2–3 h / 24 h, sometimes almost all day; night work often while lying in bed | 2026-07-24T00:00:00+03:00 | `user_reported` |

No Andrii allergy is stated.

### 6.5 Valentyna — conditions

| `name` | `status` | `diagnosed_at` | `notes` |
| --- | --- | --- | --- |
| Chronic gastritis | `user_reported` | omit | Long remission; active in childhood and university >10 years ago; rare pain now |
| Hepatitis B (history) | `resolved` | omit | “в настоящее время снята с учета” |
| Dyskinesia | `historical_uncertain` | omit | Type and location not specified |
| Two intervertebral hernias of the lower spine | `user_reported` | omit | |
| Polycystic ovary syndrome | `user_reported` | omit | |

**Skip** as conditions:

- “Небольшие проблемы с суставами; точный диагноз не указан.”
- J06.0 / acute laryngopharyngitis (unattributed)
- Dental implants 46–47 (procedure + unconfirmed healing note, not a cashier condition)
- Skin dryness / pigmentation interest (not diagnoses)

### 6.6 Valentyna — allergies (generated `VALENTYNA_ALLERGIES.md` + profile)

One row only:

```
allergen = "wheat"
reaction = "Acute clinical food reactions, especially to wheat. Formal allergist conclusion not in this corpus."
severity = "acute"
status   = "user_reported"
```

Do **not** create allergy rows for IgE class 0 (oat, quinoa, buckwheat, barley, lupin, rice, millet, corn) or for BIOTRADE Retinol 0.2% / unnamed SPF (Docs: mechanism not confirmed; “не должен автоматически считаться аллергией”).

IgE table from Docs §6 (image, **no PDF in `Здоровье/`**, **no draw date**):

```
Пшеница, Gliadin: 1,91 kUA/L — класс 2
Пшеница спельта: 1,22 kUA/L — класс 2
Ржаная мука: 0,97 kUA/L — класс 1
Пшеница: 0,66 kUA/L — класс 1
Овес: 0,18 kUA/L — класс 0
Киноа: 0,17 kUA/L — класс 0
Гречка, ячмень, люпин, рис, просо и кукуруза: ≤0,10 kUA/L — класс 0
```

**Skip as `labs`** (no `test_date`, no source document, inequalities). Quote in the ingest report. Do not invent `test_date=2026-07-24` (that is the day the image was discussed).

### 6.7 Valentyna — current medications

From Docs §7 (first mentioned 24.07.2026 unless noted). `started_at=2026-07-24T00:00:00+03:00` is “first documented”, **not** a claimed start of therapy. `status=user_reported`.

| `name` | `dose` | `schedule` |
| --- | --- | --- |
| NOW Foods Hyaluronic Acid 100 mg with L-proline, alpha-lipoic acid and grape seed extract | 1 tablet | 1 per day |
| Youtheory Collagen | 6 tablets | immediately after waking, fasting (clarified 28.07.2026) |
| California Gold Nutrition Ubiquinol 100 mg | 1 capsule | after breakfast |
| Magnesium glycinate 400 mg | 1 tablet | 1 per day; source does not say whether 400 mg is elemental Mg or the salt |
| Solgar Chelated Iron 25 mg | 1 tablet | immediately after waking, fasting |
| NOW Foods Vitamin D3 & K2 | 2 tablets | after breakfast; per-tablet D3/K2 amounts not stated |
| California Gold Nutrition Omega-3 | 1 capsule | after breakfast; EPA/DHA not stated |
| Lactulose syrup | 15 ml | daily; doctor-prescribed (JPEG + Docs §7.1). First mentioned 28.07.2026 → `started_at=2026-07-28T00:00:00+03:00`, `status=confirmed_by_doctor` |

**Skip (prescribed, start not confirmed)** — JPEG + Docs §7.1:

```
Panixen / Паниксен: «2 таб. сдъвкани, веднъж, 2 мес.» (Docs reading of handwriting)
Panixen Focus / Паниксен Фокус: 1 capsule 2 times daily, morning and evening, 2 months
Назначивший врач по штампу: д-р Анастасия Бордеева
Факт начала приема Panixen и Panixen Focus не подтвержден
```

JPEG (high level, not a new transcription): Bulgarian Rx blank, stamp `Д-р АНАСТАСИЯ БОРДЕЕВА / УИН 0400005396`, handwritten Panixen / Panixen Focus / Lactulose, patient line `Приходько`, watermark `НЕ ЗАМЕНЯЙ`. Docs already say the dose reading is uncertain and should be confirmed with the original. Worker copies the file; does not invent a clearer dose.

**Skip as a standing med:** barley-sprout powder — “обычно принимается утром натощак, но может пропускаться”.

Lemon-water-and-honey morning drink is a habit, not a medication.

### 6.8 Valentyna — meals (so diet generated pages are not empty)

Only these two have a dated food description. Do not replay them daily.

1. `2026-07-24T00:00:00+03:00` `user_reported`  
   `description` = `Favourite salad/breakfast: cherry tomatoes, half a small avocado, coppa, mixed salad leaves with rocket, baby mozzarella or a smaller portion of bryndza, sesame or pumpkin-seed oil, a little lemon juice, black pepper.`  
   Do **not** set `calories=1700` (that number is a daily planning target, not this plate).

2. `2026-07-25T00:00:00+03:00` `user_reported`  
   `description` = `4 gummies and half an apple.`  
   (Sentence sits in the smashed journal; food content is unambiguous. Still list it on the ingest report as journal-adjacent.)

Skip: coffee/tea without sugar (habit); 1700 kcal/day target; lemon water + honey + barley drink as recurring meals.

### 6.9 Valentyna — symptoms

| description | event_time | status |
| --- | --- | --- |
| After evening BIOTRADE Retinol 0.2%: face red and slightly swollen, more on the right; next morning redness and mild edema remained. Formal allergy not established | 2026-07-14T00:00:00+03:00 | `user_reported` |
| After unnamed SPF “№1”: face very red and burning in strong sun | omit clock; 2026-07-05T00:00:00+03:00 is the discussion window, **historical_uncertain** if used | do not invent product identity (Docs: numbers not mapped) |
| Implants at lower right 46 and 47; discomfort; white raised/sharp area on gum. No dentist conclusion in corpus | 2026-06-22T00:00:00+03:00 | `user_reported` |
| Stool problems, especially at the end of the luteal phase | 2026-07-24T00:00:00+03:00 | `user_reported` |
| Heartburn more frequent lately, still mild; cause not established | 2026-08-05T00:00:00+03:00 | `user_reported` |

### 6.10 Valentyna — measurements the profile will show

Sheet newest:

- 2026-08-04T23:08:00+03:00 BP 121/76 pulse 67
- 2026-08-04T15:05:00+03:00 BP 117/76 pulse 79
- 2026-08-01T22:43:00+03:00 BP 118/72 pulse 89
- 2026-07-30T23:30:00+03:00 weight 76.9 and BP 124/77 pulse 62
- 2026-07-30T13:54:00+03:00 weight 75.9 and BP 108/66 pulse 78
- 2026-07-24T23:39:22+03:00 weight 78.3

No Valentyna sleep rows exist.

---

## 7. Lab panels (ingest these numbers; skip the rest)

`test_name` values below are the English strings to store. One row = one `add_lab_result`.

### 7.1 Andrii — collection 2026-07-23, ID 23152012, physician ANASTASIYA BORDEEVA

Use `Andrii_Ramus_2026-07-23_EN_full.pdf` + BG refs where noted. **62 accept.**

| test_name | value | unit | ref min | ref max | flag |
| --- | --- | --- | --- | --- | --- |
| ESR | 17 | mm/h | | 15 | H |
| WBC abs count | 10.9 | G/l | 3.9 | 10.2 | H |
| NEU % | 50 | % | 42 | 77 | |
| NEU abs count | 5.5 | G/l | 1.5 | 7.7 | |
| EOS % | 2.6 | % | 0.5 | 5.5 | |
| EOS abs count | 0.28 | G/l | 0.02 | 0.5 | |
| LYM % | 38 | % | 20 | 44 | |
| LYM abs count | 4.1 | G/l | 1.1 | 4.5 | |
| MON % | 8.7 | % | 2 | 9.5 | |
| MON abs count | 0.94 | G/l | 0.10 | 0.90 | H |
| BAS % | 0.73 | % | 0 | 1.75 | |
| BAS abs count | 0.08 | G/l | 0 | 0.20 | |
| RBC abs count | 5.45 | T/l | 4.30 | 5.75 | |
| Hb | 171 | g/l | 135 | 172 | |
| Hct | 0.508 | l/l | 0.395 | 0.505 | H |
| MCV | 93 | fl | 80 | 99 | |
| MCH | 31.4 | pg | 27 | 33.5 | |
| MCHC | 336 | g/l | 315 | 360 | |
| RDW-CV | 12.5 | % | 11.5 | 15 | |
| PLT abs count | 293 | G/l | 150 | 370 | |
| MPV | 11.3 | fl | 8.5 | 11.5 | |
| PDW | 12.6 | fl | 9 | 17 | |
| pH (spot urine) | 5.5 | | | | |
| Specific gravity (spot urine) | 1.025 | | 1.010 | 1.030 | |
| HbA1c | 6.2 | % | | 5.7 | H |
| Glucose random or fasting | 7.4 | mmol/l | 3.5 | 5.6 | H |
| Creatinine | 99.9 | umol/l | 53 | 106.1 | |
| Uric acid | 488 | umol/l | 220 | 450 | H |
| Total protein | 73 | g/l | 64 | 83 | |
| Albumin | 42 | g/l | 35 | 52 | |
| Total cholesterol | 5.76 | mmol/l | | 5.18 | H |
| Triglycerides | 4.91 | mmol/l | | 1.70 | H |
| HDL-cholesterol | 0.85 | mmol/l | 1.55 | | L |
| LDL-cholesterol | 2.70 | mmol/l | omit | omit | |
| Urea | 6.3 | mmol/l | 3.2 | 7.4 | |
| Total bilirubin | 7.4 | umol/l | 5.1 | 20.5 | |
| Direct bilirubin | 3.8 | umol/l | 0 | 8.6 | |
| ALP | 86 | U/l | 50 | 116 | |
| AST | 24 | U/l | 11 | 34 | |
| ALT | 70 | U/l | | 45 | H |
| GGT | 114 | U/l | | 55 | H |
| Potassium | 4.4 | mmol/l | 3.5 | 5.6 | |
| Sodium | 141 | mmol/l | 136 | 145 | |
| Calcium | 2.3 | mmol/l | 2.28 | 2.60 | |
| Inorganic phosphorus | 1.33 | mmol/l | 0.81 | 1.45 | |
| Magnesium | 0.97 | mmol/l | 0.66 | 1.07 | |
| Iron | 18.7 | umol/l | 11.6 | 31.3 | |
| fT4 | 0.88 | ng/dl | 0.70 | 1.48 | |
| TSH | 2.54 | uIU/ml | 0.35 | 4.94 | |
| fT3 | 3.05 | pg/ml | 1.58 | 3.91 | |
| Anti-Tg IgG | 1.51 | IU/ml | | 4.11 | |
| Anti-TPO Ab | 0.48 | IU/ml | | 5.61 | |
| Insulin (fasting) | 25.7 | uU/ml | 3.0 | 25.0 | H |
| HOMA-IR | 8.5 | Index | | 2.7 | H |
| Cortisol | 13.8 | ug/dl | 3.70 | 19.40 | |
| Folic acid | 4.7 | ng/ml | 3.1 | 20.5 | |
| Total L-homocysteine | 20.93 | umol/l | 5.46 | 16.20 | H |
| Ferritin | 240.99 | ng/ml | 21.81 | 274.66 | |
| 25(OH)-Vitamin D | 23.9 | ng/ml | omit | omit | L |
| Vitamin B12 | 356 | pg/ml | 187 | 883 | |
| Vitamin B1 | 54.5 | ug/l | 28 | 85 | |
| CRP | 5.8 | mg/l | | 5.00 | H |

Insulin range and cortisol morning range `3.70-19.40 7:00-10:00h` are on the **BG** full PDF (EN omits insulin range and cortisol range). Cortisol was taken with registration 08:15, inside the morning window — store the morning bounds only.

**Skip Andrii (quote):**

```
Lipoprotein (a)  Serum  < 3.1 mg/dl  <=30
```

```
Protein/Glucose/Ketone/Bilirubin/Blood/Leucocytes/Nitrite (spot urine)  (-) negative
Urobilinogen (spot urine)  Normal
Sediment RBC / squamous / non-squamous / casts / crystals / bacteria / yeasts  "– HPF"
Sediment WBC  1-2 HPF
```

Early file `Andrii_ramus_23_07_26.pdf` empty result cells for Lp(a), cortisol, homocysteine, B1 — copy to `raw/` as historical print, do not parse.

### 7.2 Valentyna — collection 2026-08-05, ID 23298021

Use EN names + BG refs. **52 accept.**

| test_name | value | unit | ref min | ref max | flag |
| --- | --- | --- | --- | --- | --- |
| ESR | 28 | mm/h | | 20 | H |
| WBC abs count | 6 | G/l | 3.9 | 10.2 | |
| NEU % | 50 | % | 42 | 77 | |
| NEU abs count | 3 | G/l | 1.5 | 7.7 | |
| EOS % | 3 | % | 0.5 | 5.5 | |
| EOS abs count | 0.18 | G/l | 0.02 | 0.5 | |
| LYM % | 36 | % | 20 | 44 | |
| LYM abs count | 2.2 | G/l | 1.1 | 4.5 | |
| MON % | 9.3 | % | 2 | 9.5 | |
| MON abs count | 0.56 | G/l | 0.10 | 0.90 | |
| BAS % | 1.27 | % | 0 | 1.75 | |
| BAS abs count | 0.08 | G/l | 0 | 0.20 | |
| RBC abs count | 4.54 | T/l | 3.90 | 5.15 | |
| Hb | 136 | g/l | 120 | 154 | |
| Hct | 0.414 | l/l | 0.355 | 0.450 | |
| MCV | 91 | fl | 80 | 99 | |
| MCH | 29.9 | pg | 27 | 33.5 | |
| MCHC | 328 | g/l | 315 | 360 | |
| RDW-CV | 13 | % | 11.5 | 15 | |
| PLT abs count | 219 | G/l | 150 | 370 | |
| MPV | 11.9 | fl | 8.5 | 11.5 | H |
| PDW | 13.5 | fl | 9 | 17 | |
| pH (spot urine) | 6.0 | | 5.0 | 7.5 | |
| Specific gravity (spot urine) | 1.010 | | | | |
| Glucose random or fasting | 5.4 | mmol/l | 3.5 | 5.6 | |
| Creatinine | 61.7 | umol/l | 44.2 | 88.4 | |
| Uric acid | 304 | umol/l | 150 | 370 | |
| Total protein | 75 | g/l | 64 | 83 | |
| Albumin | 48 | g/l | 35 | 52 | |
| Total cholesterol | 4.27 | mmol/l | | 5.18 | |
| Triglycerides | 0.7 | mmol/l | | 1.70 | |
| HDL-cholesterol | 1.85 | mmol/l | 1.55 | | |
| LDL-cholesterol | 1.99 | mmol/l | omit | omit | |
| Urea | 4.4 | mmol/l | 2.5 | 6.7 | |
| Total bilirubin | 25 | umol/l | 3.4 | 20.5 | H |
| Direct bilirubin | 11.3 | umol/l | 0 | 8.6 | H |
| ALP | 31 | U/l | 30 | 150 | |
| Amylase | 51 | U/l | 28 | 100 | |
| AST | 14 | U/l | 11 | 34 | |
| ALT | 11 | U/l | | 34 | |
| GGT | 14 | U/l | 5 | 38 | |
| Potassium | 4.1 | mmol/l | 3.5 | 5.6 | |
| Sodium | 135 | mmol/l | 136 | 145 | L |
| Calcium | 2.41 | mmol/l | 2.10 | 2.55 | |
| Inorganic phosphorus | 1.2 | mmol/l | 0.81 | 1.45 | |
| Magnesium | 1 | mmol/l | 0.66 | 1.07 | |
| Iron | 15.9 | umol/l | 9 | 30.4 | |
| TSH | 2.27 | uIU/ml | 0.35 | 4.94 | |
| Vitamin B12 | 484 | pg/ml | 187 | 883 | |
| Ferritin | 31.32 | ng/ml | 4.63 | 204 | |
| 25(OH)-Vitamin D | 45.1 | ng/ml | omit | omit | |
| CRP | 4.2 | mg/l | | 5.00 | |

**Skip Valentyna — empty result column (still pending on the PDF):**

```
Pancreatic lipase          Serum    (empty) U/l     0 - 63
Cortisol                   Serum    (empty) ug/dl   3.70-19.40 7:00-10:00h
Vitamin B1                 Blood    (empty) ug/l    28 - 85
Vitamin B6                 Blood    (empty) ug/l    8.6 - 27.2
Total L-homocysteine       Serum    (empty) umol/l  4.44 - 13.56
```

Docs §8/§12 agree these five were still awaited on 05.08.2026. Do not fill them from anywhere else.

**Skip Valentyna — not a float:**

```
Urine strip protein/glucose/ketone/bilirubin/blood/leucocytes/nitrite  (-) negative
Urobilinogen  Normal
Sediment WBC 2-3 HPF; squamous epithelial cells 2-3 HPF; others "– HPF"
```

**H. pylori — ambiguous, skip:**

EN PDF: result column empty for both IgA and IgG.

BG PDF line (spaces collapsed):

```
Helicobacter pylori IgA (Euroline-WB)  Serum  (-) negative
Helicobacter pylori IgG (Euroline-WB)  Serum  (-) negative
```

`(-) negative` sits where other rows put the **reference** (urine protein has result **and** reference both `(-) negative`). Docs §12 say “Helicobacter pylori IgA и IgG — отрицательные.” Worker must **not** store a float and must **not** upgrade this to `confirmed_by_document` without a clear result cell. Quote all three and leave for G4.

Do not ingest Docs §12 “Рабочая интерпретация модели”.

---

## 8. Binaries to copy into the vault

Copy with rclone **from** `healthdrive:Здоровье/` **to** the host wiki. Do not upload, rename on Drive, or touch `Здоровье/` contents.

| Source name | Destination |
| --- | --- |
| `Andrii_Ramus_2026-07-23_EN_full.pdf` | `${WIKI_ROOT}/shared/health/raw/andrii/Andrii_Ramus_2026-07-23_EN_full.pdf` |
| `Andrii_Ramus_2026-07-23_BG_full.pdf` | `${WIKI_ROOT}/shared/health/raw/andrii/Andrii_Ramus_2026-07-23_BG_full.pdf` |
| `Andrii_ramus_23_07_26.pdf` | `${WIKI_ROOT}/shared/health/raw/andrii/Andrii_ramus_23_07_26.pdf` |
| `Valentyna_Ramus_2026-08-05_EN.pdf` | `${WIKI_ROOT}/shared/health/raw/valentyna/Valentyna_Ramus_2026-08-05_EN.pdf` |
| `Valentyna_Ramus_2026-08-05_BG.pdf` | `${WIKI_ROOT}/shared/health/raw/valentyna/Valentyna_Ramus_2026-08-05_BG.pdf` |
| `Valentyna — назначение Panixen, Panixen Focus и лактулозы — 28.07.2026.jpeg` | `${WIKI_ROOT}/shared/health/raw/valentyna/Valentyna — назначение Panixen, Panixen Focus и лактулозы — 28.07.2026.jpeg` |

Optional provenance copies (not clinical SoT; keep names):

| Local export | Destination |
| --- | --- |
| `/tmp/zdorovie-export/Andrii.txt` | `raw/andrii/Andrii.txt` |
| `/tmp/zdorovie-export/Valentyna.txt` | `raw/valentyna/Valentyna.txt` |
| `/tmp/zdorovie-xlsx/Дневник показателей здоровья.xlsx` | `raw/family/Дневник показателей здоровья.xlsx` |
| `/tmp/zdorovie-export/Дневник показателей здоровья.csv` | `raw/family/Дневник показателей здоровья.csv` (mark incomplete) |

`raw/family/` is the right place for the two-person weight workbook.

Do **not** copy `valentyna-teeth/Data.zip`.

Tonometer / scale photos mentioned in comments are **not** in `Здоровье/` (only the six PDFs + one JPEG). There is nothing else to copy.

---

## 9. People-page synthesis (not jsonl)

After cashier writes, Worker (or a later synthesis pass) may put on `people/` from **non-garbled** profile sections only:

**Andrii:** Andrii / Андрей Приходько; DOB 18.07.1991; height 192 cm (23.07); meat preference 27.07; coffee/tea without sugar; Mounjaro prescribed-not-started; CPAP recommended-not-obtained; 1700 kcal is Valentyna’s target, not his.

**Valentyna:** Valentyna / Валентина Ожегова Приходко (PDF spelling VALENTINA OZHEGOVA PRIHODKO); DOB 12.04.1994; height 173 cm; coffee/tea without sugar; 1700 kcal/day planning target; skincare product list (Docs §3) as personal care, not meds; implants 46–47 discussion without a dentist letter.

Do not copy model advice (“использовать курицу…”, “разумны повторный билирубин…”) onto people pages as facts.

---

## 10. Dedup / id recipe

```
xlsx:andrii:r5
xlsx:andrii:r6
…
xlsx:valentyna:r5
xlsx:andrii-sleep:r5
xlsx:weight:r5:andrii
xlsx:weight:r5:valentyna
docs:andrii:bp:2026-07-26T22:22:27
docs:andrii:weight:2026-07-30T23:32:00
```

R8 and R9 share `2026-07-25T10:52:12+03:00` but different payloads (140/96/78 vs 136/95/76). Separate `source_event_id`s. Payload dedup will not collapse them.

If ingest is re-run, same `source_event_id` on measurements/sleep/meals/symptoms must return `duplicate`. Meds/conditions/allergies have no server `source_event_id` — run once.

---

## 11. G4 sample the user should see before anyone deletes Docs

Minimum sample for the human gate:

- One Andrii photo-BP (R5 148/106/69 @ 2026-07-21T10:11:06+03:00)
- One Valentyna photo-BP (R5 119/76/67 @ 2026-07-24T23:10:36+03:00)
- Weight split from `Вес` R5 (78.3 valentyna + 122.3 andrii, same timestamp)
- Andrii sleep R5 10:00–14:07 on 2026-07-24
- Six current Andrii meds; Mounjaro absent
- Valentyna wheat allergy; Panixen absent from current meds; lactulose present
- Andrii HbA1c 6.2 and Valentyna total bilirubin 25 from PDFs
- Skipped R66 / R32 / H. pylori / Lp(a) `<3.1` / garbled chronology listed in the Worker ingest report

Google Docs/Sheet stay in place until that sample is accepted.

---

## 12. What this scout did not do

- No jsonl writes, no MCP calls, no `docker compose up`, no cashier run.
- No OCR beyond reading the JPEG as an image and quoting Docs §7.1.
- No download of `valentyna-teeth/Data.zip`.
- No changes under `Здоровье/`.
