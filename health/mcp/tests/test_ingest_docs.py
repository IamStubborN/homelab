from health_mcp.ingest.docs import parse_docs


ANDRII = """
ПРОФИЛЬ ЗДОРОВЬЯ: ANDRII

1. ОСНОВНЫЕ ДАННЫЕ
Имя: Andrii / Test Person
Дата рождения: 01.01.1990
- 12.07.2026: рост около 190 см, масса около 100 кг.
- 23.07.2026: рост 190 см, масса 101 кг.
- 30.07.2026 23:32:00: масса 99.1 кг.

2. АРТЕРИАЛЬНОЕ ДАВЛЕНИЕ
- 26.07.2026 22:22:27 — 120/80 мм рт. ст., пульс 70 уд/мин.
- 28.07.2026 22:47:57 — среднее двух последовательных замеров: 121/81 мм рт. ст., пульс 71 уд/мин.

3. СОН И ДЫХАНИЕ
- Обструктивное апноэ сна было подтверждено врачом несколько лет назад.
- Со слов пользователя от 24.07.2026: сон неспокойный и очень чуткий; Андрей очень громко храпит.
- Режим сна выраженно хаотичный: иногда сон длится только 2–3 часа за сутки.

6. СВОДНАЯ РАБОЧАЯ ОЦЕНКА
- Артериальная гипертензия.
- Предиабет; диабет 2 типа пока не подтвержден.
- Выраженная инсулинорезистентность.
- Метаболически ассоциированная жировая болезнь печени.
- Метаболический синдром.

8. ХРОНОЛОГИЯ
- 21.07.2026 10:11:06: smashed BP line must not become an event 148/106.

9. ЖУРНАЛ ОБНОВЛЕНИЙ
- 26.07.2026: сон примерно с 09:00–09:30 до 16:00.
"""

VAL = """
ПРОФИЛЬ ЗДОРОВЬЯ: VALENTYNA
1. ОСНОВНЫЕ ДАННЫЕ
Дата рождения: 02.02.1992
Рост: 170 см.

6. АЛЛЕРГИИ И НЕПЕРЕНОСИМОСТЬ
Подтвержденная клиническая пищевая аллергия со слов пользователя; реакции острые, особенно выражены на пшеницу.

7. ХРОНИЧЕСКИЕ СОСТОЯНИЯ, АНАМНЕЗ И ДОБАВКИ
- Хронический гастрит находится в длительной ремиссии.
- В анамнезе гепатит B; в настоящее время снята с учета.
- Дискинезия; тип и локализация не уточнены.
- Небольшие проблемы с суставами; точный диагноз не указан.
- Две межпозвоночные грыжи нижнего отдела позвоночника.
- Синдром поликистозных яичников.
- NOW Foods Hyaluronic Acid 100 mg с L-пролином — 1 таблетка в день.
- Youtheory Collagen — 6 таблеток в день.
- California Gold Nutrition Ubiquinol, 100 мг — 1 капсула в день.
- Магний глицинат 400 мг — 1 таблетка в день.
- Solgar Chelated Iron 25 mg — 1 таблетка в день.
- NOW Foods Vitamin D3 & K2 — 2 таблетки в день.
- California Gold Nutrition Omega-3 — 1 капсула в день.

7.1. НАЗНАЧЕНИЯ ВРАЧА ПО РЕЦЕПТУРНОМУ БЛАНКУ
- Panixen / Паниксен: старт не подтвержден.
- Panixen Focus / Паниксен Фокус: старт не подтвержден.
- Lactulose / лактулоза, сироп: 15 мл ежедневно.

10. ПИТАНИЕ И ЦЕЛЕВАЯ КАЛОРИЙНОСТЬ
- Любимый салат/завтрак: помидоры черри, половина небольшого авокадо.

9. ХРОНОЛОГИЯ
- 24.07.2026: давление 146/106 к Valentyna не относится.

11. ЖУРНАЛ ОБНОВЛЕНИЙ
- 23.07.2026: создан первоначальный профиль.- 25.07.2026: первый день менструации; В этот день съедены 4 мармеладки и половина яблока.
"""


def test_docs_profile_facts_skip_journal() -> None:
    parsed = parse_docs(ANDRII, VAL)
    bp_ids = {row.source_event_id for row in parsed.measurements if row.kind == "blood_pressure"}
    assert "docs:andrii:bp:2026-07-26T22:22:27" in bp_ids
    assert "docs:andrii:bp:2026-07-28T22:47:57" in bp_ids
    weights = [row for row in parsed.measurements if row.kind == "weight"]
    assert len(weights) == 1
    assert weights[0].values["value"] == 99.1
    assert "Obstructive sleep apnea" in {row.name for row in parsed.conditions}
    assert {row.allergen for row in parsed.allergies} == {"wheat"}
    assert any(row.name == "Lactulose syrup" for row in parsed.medications)
    assert not any("Panixen" in row.name for row in parsed.medications)
    meal_ids = {row.source_event_id for row in parsed.meals}
    assert meal_ids == {"docs:valentyna:meal:2026-07-24", "docs:valentyna:meal:2026-07-25"}
    skip_text = " ".join(skip.ident + skip.reason for skip in parsed.skips)
    assert "chronology" in skip_text
    assert "12.07.2026" in skip_text
    assert "23.07.2026" in skip_text
    assert not any(row.event_time and "10:11:06" in row.event_time for row in parsed.measurements)
