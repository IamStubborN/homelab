use std::str::FromStr;

use health_core::{FactStatus, MeasurementKind, Person, RequestCtx};
use sea_orm::{ConnectionTrait, DatabaseBackend, DatabaseConnection, Statement};
use serde::{Deserialize, Serialize};
use time::{Date, Duration, OffsetDateTime};
use uuid::Uuid;

use crate::{charts, storage};

const CONFIRMATION_REQUIRED: &str = "confirmation_required: ask the user to confirm with the ✅ card, then retry with confirmed=true";
pub const MAX_QUERY_LIMIT: u32 = 200;
pub const MAX_CHART_DAYS: u32 = 3650;
const MAX_SOURCE_EVENT_ID_BYTES: usize = 200;

#[derive(Debug, thiserror::Error)]
pub enum OpsError {
    #[error(transparent)]
    Storage(#[from] storage::StorageError),
    #[error(transparent)]
    Validation(#[from] health_core::ValidationError),
    #[error(transparent)]
    Chart(#[from] charts::ChartError),
    #[error("{CONFIRMATION_REQUIRED}")]
    ConfirmationRequired,
    #[error("invalid {field}: {value}")]
    InvalidParameter { field: &'static str, value: String },
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AddMeasurementParams {
    pub person: Option<Person>,
    pub kind: MeasurementKind,
    pub values: serde_json::Value,
    pub source: Option<String>,
    pub status: Option<FactStatus>,
    pub event_time: Option<OffsetDateTime>,
    pub source_event_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CorrectMeasurementParams {
    pub measurement_id: Uuid,
    pub new_values: serde_json::Value,
    pub reason: String,
    pub confirmed: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AddMealParams {
    pub person: Option<Person>,
    pub description: String,
    pub items: Option<serde_json::Value>,
    pub calories: Option<i32>,
    pub status: Option<FactStatus>,
    pub event_time: Option<OffsetDateTime>,
    pub source_event_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AddSymptomParams {
    pub person: Option<Person>,
    pub description: String,
    pub severity: Option<i32>,
    pub status: Option<FactStatus>,
    pub event_time: Option<OffsetDateTime>,
    pub source_event_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AddSleepRecordParams {
    pub person: Option<Person>,
    pub start_time: OffsetDateTime,
    pub end_time: OffsetDateTime,
    pub quality: Option<i32>,
    pub notes: Option<String>,
    pub status: Option<FactStatus>,
    pub source_event_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AddMedicationParams {
    pub person: Option<Person>,
    pub name: String,
    pub dose: Option<String>,
    pub schedule: Option<String>,
    pub started_at: Option<OffsetDateTime>,
    pub status: Option<FactStatus>,
    pub confirmed: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct StopMedicationParams {
    pub person: Option<Person>,
    pub medication_id: Uuid,
    pub stopped_at: Option<OffsetDateTime>,
    pub reason: Option<String>,
    pub confirmed: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AddConditionParams {
    pub person: Option<Person>,
    pub name: String,
    pub notes: Option<String>,
    pub diagnosed_at: Option<Date>,
    pub status: Option<FactStatus>,
    pub confirmed: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AddAllergyParams {
    pub person: Option<Person>,
    pub allergen: String,
    pub reaction: Option<String>,
    pub severity: Option<String>,
    pub status: Option<FactStatus>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AddLabResultParams {
    pub person: Option<Person>,
    pub test_date: Date,
    pub test_name: String,
    pub value: f64,
    pub unit: Option<String>,
    pub reference_min: Option<f64>,
    pub reference_max: Option<f64>,
    pub flag: Option<String>,
    pub laboratory: Option<String>,
    pub source_document: Option<String>,
    pub status: Option<FactStatus>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct QueryHealthDataParams {
    pub person: Option<Person>,
    pub section: String,
    pub limit: Option<u32>,
    pub from: Option<OffsetDateTime>,
    pub to: Option<OffsetDateTime>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct GenerateChartParams {
    pub person: Option<Person>,
    pub kind: MeasurementKind,
    pub days: Option<u32>,
    pub title: Option<String>,
}

pub async fn add_measurement(
    db: &DatabaseConnection,
    ctx: &RequestCtx,
    params: AddMeasurementParams,
) -> Result<storage::WriteOutcome, OpsError> {
    health_core::validate_measurement(params.kind, &params.values)?;
    Ok(storage::add_measurement(
        db,
        ctx,
        storage::AddMeasurement {
            person: person(ctx, params.person),
            kind: params.kind,
            values: params.values,
            source: params.source,
            status: status(params.status),
            event_time: params.event_time.unwrap_or_else(OffsetDateTime::now_utc),
            source_event_id: validate_source_event_id(params.source_event_id)?,
        },
    )
    .await?)
}

pub async fn correct_measurement(
    db: &DatabaseConnection,
    ctx: &RequestCtx,
    params: CorrectMeasurementParams,
) -> Result<(), OpsError> {
    require_confirmation(params.confirmed)?;
    if let Some(kind) = measurement_kind(db, params.measurement_id).await? {
        health_core::validate_measurement(kind, &params.new_values)?;
    }
    storage::correct_measurement(
        db,
        ctx,
        storage::CorrectMeasurement {
            measurement_id: params.measurement_id,
            new_values: params.new_values,
            reason: params.reason,
        },
    )
    .await?;
    Ok(())
}

pub async fn add_meal(
    db: &DatabaseConnection,
    ctx: &RequestCtx,
    params: AddMealParams,
) -> Result<storage::WriteOutcome, OpsError> {
    Ok(storage::add_meal(
        db,
        ctx,
        storage::AddMeal {
            person: person(ctx, params.person),
            description: params.description,
            items: params.items,
            calories: params.calories,
            status: status(params.status),
            event_time: params.event_time.unwrap_or_else(OffsetDateTime::now_utc),
            source_event_id: validate_source_event_id(params.source_event_id)?,
        },
    )
    .await?)
}

pub async fn add_symptom(
    db: &DatabaseConnection,
    ctx: &RequestCtx,
    params: AddSymptomParams,
) -> Result<storage::WriteOutcome, OpsError> {
    Ok(storage::add_symptom(
        db,
        ctx,
        storage::AddSymptom {
            person: person(ctx, params.person),
            description: params.description,
            severity: params.severity,
            status: status(params.status),
            event_time: params.event_time.unwrap_or_else(OffsetDateTime::now_utc),
            source_event_id: validate_source_event_id(params.source_event_id)?,
        },
    )
    .await?)
}

pub async fn add_sleep_record(
    db: &DatabaseConnection,
    ctx: &RequestCtx,
    params: AddSleepRecordParams,
) -> Result<storage::WriteOutcome, OpsError> {
    if params.end_time <= params.start_time {
        return Err(OpsError::InvalidParameter {
            field: "end_time",
            value: "must be after start_time".to_owned(),
        });
    }
    Ok(storage::add_sleep_record(
        db,
        ctx,
        storage::AddSleepRecord {
            person: person(ctx, params.person),
            start_time: params.start_time,
            end_time: params.end_time,
            quality: params.quality,
            notes: params.notes,
            status: status(params.status),
            source_event_id: validate_source_event_id(params.source_event_id)?,
        },
    )
    .await?)
}

pub async fn add_medication(
    db: &DatabaseConnection,
    ctx: &RequestCtx,
    params: AddMedicationParams,
) -> Result<storage::WriteOutcome, OpsError> {
    require_confirmation(params.confirmed)?;
    Ok(storage::add_medication(
        db,
        ctx,
        storage::AddMedication {
            person: person(ctx, params.person),
            name: params.name,
            dose: params.dose,
            schedule: params.schedule,
            started_at: params.started_at.unwrap_or_else(OffsetDateTime::now_utc),
            status: status(params.status),
        },
    )
    .await?)
}

pub async fn stop_medication(
    db: &DatabaseConnection,
    ctx: &RequestCtx,
    params: StopMedicationParams,
) -> Result<storage::WriteOutcome, OpsError> {
    require_confirmation(params.confirmed)?;
    Ok(storage::stop_medication(
        db,
        ctx,
        storage::StopMedication {
            person: person(ctx, params.person),
            medication_id: params.medication_id,
            stopped_at: params.stopped_at.unwrap_or_else(OffsetDateTime::now_utc),
            reason: params.reason,
        },
    )
    .await?)
}

pub async fn add_condition(
    db: &DatabaseConnection,
    ctx: &RequestCtx,
    params: AddConditionParams,
) -> Result<storage::WriteOutcome, OpsError> {
    require_confirmation(params.confirmed)?;
    Ok(storage::add_condition(
        db,
        ctx,
        storage::AddCondition {
            person: person(ctx, params.person),
            name: params.name,
            notes: params.notes,
            diagnosed_at: params.diagnosed_at,
            status: status(params.status),
        },
    )
    .await?)
}

pub async fn add_allergy(
    db: &DatabaseConnection,
    ctx: &RequestCtx,
    params: AddAllergyParams,
) -> Result<storage::WriteOutcome, OpsError> {
    Ok(storage::add_allergy(
        db,
        ctx,
        storage::AddAllergy {
            person: person(ctx, params.person),
            allergen: params.allergen,
            reaction: params.reaction,
            severity: params.severity,
            status: status(params.status),
        },
    )
    .await?)
}

pub async fn add_lab_result(
    db: &DatabaseConnection,
    ctx: &RequestCtx,
    params: AddLabResultParams,
) -> Result<storage::WriteOutcome, OpsError> {
    Ok(storage::add_lab_result(
        db,
        ctx,
        storage::AddLabResult {
            person: person(ctx, params.person),
            test_date: params.test_date,
            test_name: params.test_name,
            value: params.value,
            unit: params.unit,
            reference_min: params.reference_min,
            reference_max: params.reference_max,
            flag: params.flag,
            laboratory: params.laboratory,
            source_document: params.source_document,
            status: status(params.status),
        },
    )
    .await?)
}

pub async fn query_health_data(
    db: &DatabaseConnection,
    ctx: &RequestCtx,
    params: QueryHealthDataParams,
) -> Result<serde_json::Value, OpsError> {
    let person = person(ctx, params.person);
    let limit = params.limit.unwrap_or(20);
    if limit > MAX_QUERY_LIMIT {
        return Err(OpsError::InvalidParameter {
            field: "limit",
            value: format!("maximum is {MAX_QUERY_LIMIT}"),
        });
    }
    if params.section == "medications" {
        let rows = storage::current_medications_in_range(db, person, params.from, params.to, limit)
            .await?;
        return Ok(serde_json::Value::Array(
            rows.into_iter()
                .map(|row| {
                    serde_json::json!({
                        "id": row.id,
                        "name": row.name,
                        "dose": row.dose,
                        "schedule": row.schedule,
                        "started_at": row.started_at,
                    })
                })
                .collect(),
        ));
    }
    if let Ok(kind) = MeasurementKind::from_str(&params.section) {
        let to = params.to.unwrap_or_else(OffsetDateTime::now_utc);
        let from = params.from.unwrap_or(OffsetDateTime::UNIX_EPOCH);
        let rows = storage::latest_measurement_series(db, person, kind, from, to, limit).await?;
        return Ok(serde_json::Value::Array(
            rows.iter()
                .map(|row| serde_json::json!({"event_time": row.event_time, "values": row.values}))
                .collect(),
        ));
    }

    let rows = storage::recent_in_range(db, person, &params.section, limit, params.from, params.to)
        .await?;
    Ok(serde_json::Value::Array(
        rows.into_iter().map(|row| row.json).collect(),
    ))
}

pub async fn generate_chart(
    db: &DatabaseConnection,
    ctx: &RequestCtx,
    params: GenerateChartParams,
) -> Result<Vec<u8>, OpsError> {
    let person = person(ctx, params.person);
    let days = params.days.unwrap_or(30);
    if days > MAX_CHART_DAYS {
        return Err(OpsError::InvalidParameter {
            field: "days",
            value: format!("maximum is {MAX_CHART_DAYS}"),
        });
    }
    let to = OffsetDateTime::now_utc();
    let from = to
        .checked_sub(Duration::days(i64::from(days)))
        .ok_or_else(|| OpsError::InvalidParameter {
            field: "days",
            value: "range is out of bounds".to_owned(),
        })?;
    let points = storage::measurement_series(db, person, params.kind, from, to).await?;
    let title = params
        .title
        .unwrap_or_else(|| format!("{} — {}", person.as_str(), params.kind.as_str()));
    Ok(charts::render_measurement_chart(&charts::ChartRequest {
        title: &title,
        kind: params.kind,
        points: &points,
    })?)
}

fn person(ctx: &RequestCtx, person: Option<Person>) -> Person {
    person.unwrap_or(ctx.default_person)
}

fn status(status: Option<FactStatus>) -> FactStatus {
    status.unwrap_or(FactStatus::UserReported)
}

fn validate_source_event_id(value: Option<String>) -> Result<Option<String>, OpsError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_empty()
        || value.len() > MAX_SOURCE_EVENT_ID_BYTES
        || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
    {
        return Err(OpsError::InvalidParameter {
            field: "source_event_id",
            value: "must be 1-200 printable ASCII bytes without spaces".to_owned(),
        });
    }
    Ok(Some(value))
}

fn require_confirmation(confirmed: Option<bool>) -> Result<(), OpsError> {
    if confirmed == Some(true) {
        Ok(())
    } else {
        Err(OpsError::ConfirmationRequired)
    }
}

async fn measurement_kind(
    db: &DatabaseConnection,
    measurement_id: Uuid,
) -> Result<Option<MeasurementKind>, OpsError> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT kind FROM measurements WHERE id = $1 AND deleted_at IS NULL",
            [measurement_id.into()],
        ))
        .await
        .map_err(storage::StorageError::from)?;
    row.map(|row| {
        let value = row
            .try_get::<String>("", "kind")
            .map_err(storage::StorageError::from)?;
        MeasurementKind::from_str(&value).map_err(|_| OpsError::InvalidParameter {
            field: "kind",
            value,
        })
    })
    .transpose()
}

#[cfg(test)]
mod tests {
    use super::validate_source_event_id;

    #[test]
    fn source_event_id_is_bounded_and_transport_safe() {
        assert_eq!(
            validate_source_event_id(Some("telegram:42:100".to_owned())).unwrap(),
            Some("telegram:42:100".to_owned())
        );
        for invalid in ["".to_owned(), "contains space".to_owned(), "x".repeat(201)] {
            assert!(validate_source_event_id(Some(invalid)).is_err());
        }
    }
}
