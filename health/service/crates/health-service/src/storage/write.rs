use health_core::{
    FactStatus, MeasurementKind, Person, RequestCtx, event_dedup_hash, source_event_dedup_hash,
};
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseConnection, Statement, TransactionTrait, Value,
};
use time::{Date, OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

#[derive(Debug, PartialEq, Eq)]
pub enum WriteOutcome {
    Created { id: Uuid },
    Duplicate { existing_id: Uuid },
}

pub struct AddMeasurement {
    pub person: Person,
    pub kind: MeasurementKind,
    pub values: serde_json::Value,
    pub source: Option<String>,
    pub status: FactStatus,
    pub event_time: OffsetDateTime,
    pub source_event_id: Option<String>,
}

pub struct AddMeal {
    pub person: Person,
    pub description: String,
    pub items: Option<serde_json::Value>,
    pub calories: Option<i32>,
    pub status: FactStatus,
    pub event_time: OffsetDateTime,
    pub source_event_id: Option<String>,
}

pub struct AddSymptom {
    pub person: Person,
    pub description: String,
    pub severity: Option<i32>,
    pub status: FactStatus,
    pub event_time: OffsetDateTime,
    pub source_event_id: Option<String>,
}

pub struct AddSleepRecord {
    pub person: Person,
    pub start_time: OffsetDateTime,
    pub end_time: OffsetDateTime,
    pub quality: Option<i32>,
    pub notes: Option<String>,
    pub status: FactStatus,
    pub source_event_id: Option<String>,
}

pub struct AddMedication {
    pub person: Person,
    pub name: String,
    pub dose: Option<String>,
    pub schedule: Option<String>,
    pub started_at: OffsetDateTime,
    pub status: FactStatus,
}

pub struct StopMedication {
    pub person: Person,
    pub medication_id: Uuid,
    pub stopped_at: OffsetDateTime,
    pub reason: Option<String>,
}

pub struct AddCondition {
    pub person: Person,
    pub name: String,
    pub notes: Option<String>,
    pub diagnosed_at: Option<Date>,
    pub status: FactStatus,
}

pub struct AddAllergy {
    pub person: Person,
    pub allergen: String,
    pub reaction: Option<String>,
    pub severity: Option<String>,
    pub status: FactStatus,
}

pub struct AddLabResult {
    pub person: Person,
    pub test_date: Date,
    pub test_name: String,
    pub value: f64,
    pub unit: Option<String>,
    pub reference_min: Option<f64>,
    pub reference_max: Option<f64>,
    pub flag: Option<String>,
    pub laboratory: Option<String>,
    pub source_document: Option<String>,
    pub status: FactStatus,
}

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("database error: {0}")]
    Db(#[from] sea_orm::DbErr),
    #[error("not found")]
    NotFound,
    #[error("rejected: {0}")]
    Rejected(String),
}

struct EventInsert<'a> {
    table: &'a str,
    action: &'a str,
    person: Person,
    status: FactStatus,
    dedup: Option<[u8; 32]>,
    columns: Vec<(&'a str, Value)>,
    audit_new_value: serde_json::Value,
}

async fn insert_event(
    db: &DatabaseConnection,
    ctx: &RequestCtx,
    ins: EventInsert<'_>,
) -> Result<WriteOutcome, StorageError> {
    let txn = db.begin().await?;
    let id = Uuid::new_v4();
    let mut column_names = vec!["id", "person_id"];
    let mut placeholders = vec!["$1".to_owned(), "$2::person".to_owned()];
    let mut values = vec![id.into(), ins.person.as_str().into()];

    for (column, value) in ins.columns {
        column_names.push(column);
        values.push(value);
        placeholders.push(format!("${}", values.len()));
    }

    column_names.push("status");
    values.push(ins.status.as_str().into());
    placeholders.push(format!("${}::fact_status", values.len()));
    column_names.push("actor");
    values.push(ctx.actor.as_str().into());
    placeholders.push(format!("${}::person", values.len()));
    column_names.push("via");
    values.push(ctx.via.as_str().into());
    placeholders.push(format!("${}::via_channel", values.len()));

    if let Some(dedup) = ins.dedup {
        column_names.push("dedup_hash");
        values.push(dedup.to_vec().into());
        placeholders.push(format!("${}", values.len()));
    }

    let conflict = if ins.dedup.is_some() {
        " ON CONFLICT (dedup_hash) WHERE deleted_at IS NULL DO NOTHING"
    } else {
        ""
    };
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({}){} RETURNING id",
        ins.table,
        column_names.join(", "),
        placeholders.join(", "),
        conflict,
    );
    let inserted = txn
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            values,
        ))
        .await?;

    let (outcome, entity_id, result, new_value) = if let Some(row) = inserted {
        let id = row.try_get::<Uuid>("", "id")?;
        (
            WriteOutcome::Created { id },
            id,
            "success",
            Some(ins.audit_new_value),
        )
    } else {
        let dedup = ins.dedup.ok_or(StorageError::NotFound)?;
        let sql = format!(
            "SELECT id FROM {} WHERE dedup_hash = $1 AND deleted_at IS NULL",
            ins.table
        );
        let existing_id = txn
            .query_one_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                sql,
                [dedup.to_vec().into()],
            ))
            .await?
            .ok_or(StorageError::NotFound)?
            .try_get::<Uuid>("", "id")?;
        (
            WriteOutcome::Duplicate { existing_id },
            existing_id,
            "duplicate",
            None,
        )
    };

    txn.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "INSERT INTO audit_log (
             actor, via, target_person, action, entity_table, entity_id, result, new_value
         ) VALUES (
             $1::person, $2::via_channel, $3::person, $4, $5, $6, $7, $8
         )",
        [
            ctx.actor.as_str().into(),
            ctx.via.as_str().into(),
            ins.person.as_str().into(),
            ins.action.into(),
            ins.table.into(),
            entity_id.into(),
            result.into(),
            new_value.into(),
        ],
    ))
    .await?;
    txn.commit().await?;

    Ok(outcome)
}

fn routine_event_dedup(
    person: Person,
    event_type: &str,
    event_time: OffsetDateTime,
    normalized_values: &serde_json::Value,
    source_event_id: Option<&str>,
) -> [u8; 32] {
    match source_event_id {
        Some(source_event_id) => source_event_dedup_hash(person, event_type, source_event_id),
        None => event_dedup_hash(person, event_type, event_time, normalized_values, None),
    }
}

pub async fn add_measurement(
    db: &DatabaseConnection,
    ctx: &RequestCtx,
    args: AddMeasurement,
) -> Result<WriteOutcome, StorageError> {
    let dedup = routine_event_dedup(
        args.person,
        args.kind.as_str(),
        args.event_time,
        &args.values,
        args.source_event_id.as_deref(),
    );
    let new_value = args.values.clone();

    insert_event(
        db,
        ctx,
        EventInsert {
            table: "measurements",
            action: "add_measurement",
            person: args.person,
            status: args.status,
            dedup: Some(dedup),
            columns: vec![
                ("kind", args.kind.as_str().into()),
                ("values_json", args.values.into()),
                ("source", args.source.into()),
                ("event_time", args.event_time.into()),
            ],
            audit_new_value: new_value,
        },
    )
    .await
}

pub async fn add_meal(
    db: &DatabaseConnection,
    ctx: &RequestCtx,
    args: AddMeal,
) -> Result<WriteOutcome, StorageError> {
    let normalized = serde_json::json!({
        "description": args.description,
        "calories": args.calories,
    });
    let dedup = routine_event_dedup(
        args.person,
        "meal",
        args.event_time,
        &normalized,
        args.source_event_id.as_deref(),
    );
    let new_value = serde_json::json!({
        "description": args.description,
        "items": args.items,
        "calories": args.calories,
    });

    insert_event(
        db,
        ctx,
        EventInsert {
            table: "meals",
            action: "add_meal",
            person: args.person,
            status: args.status,
            dedup: Some(dedup),
            columns: vec![
                ("description", args.description.into()),
                ("items_json", args.items.into()),
                ("calories", args.calories.into()),
                ("event_time", args.event_time.into()),
            ],
            audit_new_value: new_value,
        },
    )
    .await
}

pub async fn add_symptom(
    db: &DatabaseConnection,
    ctx: &RequestCtx,
    args: AddSymptom,
) -> Result<WriteOutcome, StorageError> {
    let normalized = serde_json::json!({
        "description": args.description,
        "severity": args.severity,
    });
    let dedup = routine_event_dedup(
        args.person,
        "symptom",
        args.event_time,
        &normalized,
        args.source_event_id.as_deref(),
    );
    let new_value = normalized.clone();

    insert_event(
        db,
        ctx,
        EventInsert {
            table: "symptoms",
            action: "add_symptom",
            person: args.person,
            status: args.status,
            dedup: Some(dedup),
            columns: vec![
                ("description", args.description.into()),
                ("severity", args.severity.into()),
                ("event_time", args.event_time.into()),
            ],
            audit_new_value: new_value,
        },
    )
    .await
}

pub async fn add_sleep_record(
    db: &DatabaseConnection,
    ctx: &RequestCtx,
    args: AddSleepRecord,
) -> Result<WriteOutcome, StorageError> {
    let normalized = serde_json::json!({
        "start": args.start_time.to_utc().format(&Rfc3339).expect("valid RFC 3339 time"),
        "end": args.end_time.to_utc().format(&Rfc3339).expect("valid RFC 3339 time"),
    });
    let dedup = routine_event_dedup(
        args.person,
        "sleep_record",
        args.start_time,
        &normalized,
        args.source_event_id.as_deref(),
    );
    let new_value = serde_json::json!({
        "start_time": args.start_time,
        "end_time": args.end_time,
        "quality": args.quality,
        "notes": args.notes,
    });

    insert_event(
        db,
        ctx,
        EventInsert {
            table: "sleep_records",
            action: "add_sleep_record",
            person: args.person,
            status: args.status,
            dedup: Some(dedup),
            columns: vec![
                ("start_time", args.start_time.into()),
                ("end_time", args.end_time.into()),
                ("quality", args.quality.into()),
                ("notes", args.notes.into()),
                ("event_time", args.start_time.into()),
            ],
            audit_new_value: new_value,
        },
    )
    .await
}

pub async fn add_medication(
    db: &DatabaseConnection,
    ctx: &RequestCtx,
    args: AddMedication,
) -> Result<WriteOutcome, StorageError> {
    let new_value = serde_json::json!({
        "name": args.name,
        "dose": args.dose,
        "schedule": args.schedule,
        "started_at": args.started_at,
    });

    insert_event(
        db,
        ctx,
        EventInsert {
            table: "medications",
            action: "add_medication",
            person: args.person,
            status: args.status,
            dedup: None,
            columns: vec![
                ("name", args.name.into()),
                ("dose", args.dose.into()),
                ("schedule", args.schedule.into()),
                ("started_at", args.started_at.into()),
            ],
            audit_new_value: new_value,
        },
    )
    .await
}

pub async fn stop_medication(
    db: &DatabaseConnection,
    ctx: &RequestCtx,
    args: StopMedication,
) -> Result<WriteOutcome, StorageError> {
    let txn = db.begin().await?;
    let medication = txn
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT started_at, stopped_at
             FROM medications
             WHERE id = $1 AND person_id = $2::person AND deleted_at IS NULL
             FOR UPDATE",
            [args.medication_id.into(), args.person.as_str().into()],
        ))
        .await?;

    let rejection = match medication.as_ref() {
        None => Some(StorageError::NotFound),
        Some(row)
            if row
                .try_get::<Option<OffsetDateTime>>("", "stopped_at")?
                .is_some() =>
        {
            Some(StorageError::NotFound)
        }
        Some(row) if args.stopped_at < row.try_get::<OffsetDateTime>("", "started_at")? => Some(
            StorageError::Rejected("stopped_at must not be before started_at".to_owned()),
        ),
        Some(_) => None,
    };

    if rejection.is_none() {
        txn.execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "UPDATE medications SET stopped_at = $1, stop_reason = $2 WHERE id = $3",
            [
                args.stopped_at.into(),
                args.reason.clone().into(),
                args.medication_id.into(),
            ],
        ))
        .await?;
    }
    let new_value = rejection.is_none().then(|| {
        serde_json::json!({
            "stopped_at": args.stopped_at,
            "reason": args.reason,
        })
    });

    txn.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "INSERT INTO audit_log (
             actor, via, target_person, action, entity_table, entity_id, result, new_value
         ) VALUES (
             $1::person, $2::via_channel, $3::person,
             'stop_medication', 'medications', $4, $5, $6
         )",
        [
            ctx.actor.as_str().into(),
            ctx.via.as_str().into(),
            args.person.as_str().into(),
            args.medication_id.into(),
            if rejection.is_none() {
                "success"
            } else {
                "rejected"
            }
            .into(),
            new_value.into(),
        ],
    ))
    .await?;
    txn.commit().await?;

    match rejection {
        None => Ok(WriteOutcome::Created {
            id: args.medication_id,
        }),
        Some(error) => Err(error),
    }
}

pub async fn add_condition(
    db: &DatabaseConnection,
    ctx: &RequestCtx,
    args: AddCondition,
) -> Result<WriteOutcome, StorageError> {
    let new_value = serde_json::json!({
        "name": args.name,
        "notes": args.notes,
        "diagnosed_at": args.diagnosed_at,
    });
    insert_event(
        db,
        ctx,
        EventInsert {
            table: "conditions",
            action: "add_condition",
            person: args.person,
            status: args.status,
            dedup: None,
            columns: vec![
                ("name", args.name.into()),
                ("notes", args.notes.into()),
                ("diagnosed_at", args.diagnosed_at.into()),
            ],
            audit_new_value: new_value,
        },
    )
    .await
}

pub async fn add_allergy(
    db: &DatabaseConnection,
    ctx: &RequestCtx,
    args: AddAllergy,
) -> Result<WriteOutcome, StorageError> {
    let new_value = serde_json::json!({
        "allergen": args.allergen,
        "reaction": args.reaction,
        "severity": args.severity,
    });

    insert_event(
        db,
        ctx,
        EventInsert {
            table: "allergies",
            action: "add_allergy",
            person: args.person,
            status: args.status,
            dedup: None,
            columns: vec![
                ("allergen", args.allergen.into()),
                ("reaction", args.reaction.into()),
                ("severity", args.severity.into()),
            ],
            audit_new_value: new_value,
        },
    )
    .await
}

pub async fn add_lab_result(
    db: &DatabaseConnection,
    ctx: &RequestCtx,
    args: AddLabResult,
) -> Result<WriteOutcome, StorageError> {
    let event_time = args.test_date.midnight().assume_utc();
    let normalized = serde_json::json!({
        "test_name": args.test_name,
        "test_date": args.test_date,
        "value": args.value,
    });
    let dedup = event_dedup_hash(args.person, "lab_result", event_time, &normalized, None);
    let new_value = serde_json::json!({
        "test_date": args.test_date,
        "test_name": args.test_name,
        "value": args.value,
        "unit": args.unit,
        "reference_min": args.reference_min,
        "reference_max": args.reference_max,
        "flag": args.flag,
        "laboratory": args.laboratory,
        "source_document": args.source_document,
    });

    insert_event(
        db,
        ctx,
        EventInsert {
            table: "labs",
            action: "add_lab_result",
            person: args.person,
            status: args.status,
            dedup: Some(dedup),
            columns: vec![
                ("test_date", args.test_date.into()),
                ("test_name", args.test_name.into()),
                ("value", args.value.into()),
                ("unit", args.unit.into()),
                ("reference_min", args.reference_min.into()),
                ("reference_max", args.reference_max.into()),
                ("flag", args.flag.into()),
                ("laboratory", args.laboratory.into()),
                ("source_document", args.source_document.into()),
            ],
            audit_new_value: new_value,
        },
    )
    .await
}
