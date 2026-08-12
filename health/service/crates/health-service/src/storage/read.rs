use health_core::{MeasurementKind, Person};
use sea_orm::{ConnectionTrait, DatabaseBackend, DatabaseConnection, Statement};
use time::OffsetDateTime;
use uuid::Uuid;

use super::StorageError;

#[derive(Debug, PartialEq)]
pub struct SeriesPoint {
    pub event_time: OffsetDateTime,
    pub values: serde_json::Value,
}

pub async fn measurement_series(
    db: &DatabaseConnection,
    person: Person,
    kind: MeasurementKind,
    from: OffsetDateTime,
    to: OffsetDateTime,
) -> Result<Vec<SeriesPoint>, StorageError> {
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT event_time, values_json
             FROM measurements
             WHERE person_id = $1::person AND kind = $2
               AND event_time >= $3 AND event_time <= $4
               AND deleted_at IS NULL
             ORDER BY event_time ASC, id ASC",
            [
                person.as_str().into(),
                kind.as_str().into(),
                from.into(),
                to.into(),
            ],
        ))
        .await?;

    rows.into_iter()
        .map(|row| {
            Ok(SeriesPoint {
                event_time: row.try_get("", "event_time")?,
                values: row.try_get("", "values_json")?,
            })
        })
        .collect()
}

pub async fn latest_measurement_series(
    db: &DatabaseConnection,
    person: Person,
    kind: MeasurementKind,
    from: OffsetDateTime,
    to: OffsetDateTime,
    limit: u32,
) -> Result<Vec<SeriesPoint>, StorageError> {
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT event_time, values_json
             FROM (
                 SELECT id, event_time, values_json
                 FROM measurements
                 WHERE person_id = $1::person AND kind = $2
                   AND event_time >= $3 AND event_time <= $4
                   AND deleted_at IS NULL
                 ORDER BY event_time DESC, id DESC
                 LIMIT $5
             ) AS latest
             ORDER BY event_time ASC, id ASC",
            [
                person.as_str().into(),
                kind.as_str().into(),
                from.into(),
                to.into(),
                i64::from(limit).into(),
            ],
        ))
        .await?;

    rows.into_iter()
        .map(|row| {
            Ok(SeriesPoint {
                event_time: row.try_get("", "event_time")?,
                values: row.try_get("", "values_json")?,
            })
        })
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
pub struct MedicationRow {
    pub id: Uuid,
    pub name: String,
    pub dose: Option<String>,
    pub schedule: Option<String>,
    pub started_at: OffsetDateTime,
}

pub async fn current_medications(
    db: &DatabaseConnection,
    person: Person,
) -> Result<Vec<MedicationRow>, StorageError> {
    current_medications_in_range(db, person, None, None, u32::MAX).await
}

/// Returns active medications whose `started_at` is within inclusive bounds.
pub async fn current_medications_in_range(
    db: &DatabaseConnection,
    person: Person,
    from: Option<OffsetDateTime>,
    to: Option<OffsetDateTime>,
    limit: u32,
) -> Result<Vec<MedicationRow>, StorageError> {
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT id, name, dose, schedule, started_at
             FROM medications
             WHERE person_id = $1::person
               AND stopped_at IS NULL AND deleted_at IS NULL
               AND ($2::timestamptz IS NULL OR started_at >= $2)
               AND ($3::timestamptz IS NULL OR started_at <= $3)
             ORDER BY started_at DESC, id DESC
             LIMIT $4",
            [
                person.as_str().into(),
                from.into(),
                to.into(),
                i64::from(limit).into(),
            ],
        ))
        .await?;

    rows.into_iter()
        .map(|row| {
            Ok(MedicationRow {
                id: row.try_get("", "id")?,
                name: row.try_get("", "name")?,
                dose: row.try_get("", "dose")?,
                schedule: row.try_get("", "schedule")?,
                started_at: row.try_get("", "started_at")?,
            })
        })
        .collect()
}

#[derive(Debug, PartialEq)]
pub struct SummaryRow {
    pub entity: String,
    pub json: serde_json::Value,
}

/// Returns recent active rows from an explicitly allowed health section.
pub async fn recent(
    db: &DatabaseConnection,
    person: Person,
    section: &str,
    limit: u32,
) -> Result<Vec<SummaryRow>, StorageError> {
    recent_in_range(db, person, section, limit, None, None).await
}

/// Returns active rows within inclusive section-specific temporal bounds.
pub async fn recent_in_range(
    db: &DatabaseConnection,
    person: Person,
    section: &str,
    limit: u32,
    from: Option<OffsetDateTime>,
    to: Option<OffsetDateTime>,
) -> Result<Vec<SummaryRow>, StorageError> {
    let sql = match section {
        "measurements" => {
            "SELECT to_jsonb(row_data) - 'deleted_at' - 'dedup_hash' AS json
             FROM measurements AS row_data
             WHERE person_id = $1::person AND deleted_at IS NULL
               AND ($3::timestamptz IS NULL OR event_time >= $3)
               AND ($4::timestamptz IS NULL OR event_time <= $4)
             ORDER BY event_time DESC, id DESC LIMIT $2"
        }
        "meals" => {
            "SELECT to_jsonb(row_data) - 'deleted_at' - 'dedup_hash' AS json
             FROM meals AS row_data
             WHERE person_id = $1::person AND deleted_at IS NULL
               AND ($3::timestamptz IS NULL OR event_time >= $3)
               AND ($4::timestamptz IS NULL OR event_time <= $4)
             ORDER BY event_time DESC, id DESC LIMIT $2"
        }
        "symptoms" => {
            "SELECT to_jsonb(row_data) - 'deleted_at' - 'dedup_hash' AS json
             FROM symptoms AS row_data
             WHERE person_id = $1::person AND deleted_at IS NULL
               AND ($3::timestamptz IS NULL OR event_time >= $3)
               AND ($4::timestamptz IS NULL OR event_time <= $4)
             ORDER BY event_time DESC, id DESC LIMIT $2"
        }
        "sleep" => {
            "SELECT to_jsonb(row_data) - 'deleted_at' - 'dedup_hash' AS json
             FROM sleep_records AS row_data
             WHERE person_id = $1::person AND deleted_at IS NULL
               AND ($3::timestamptz IS NULL OR event_time >= $3)
               AND ($4::timestamptz IS NULL OR event_time <= $4)
             ORDER BY event_time DESC, id DESC LIMIT $2"
        }
        "medications" => {
            "SELECT to_jsonb(row_data) - 'deleted_at' AS json
             FROM medications AS row_data
             WHERE person_id = $1::person AND deleted_at IS NULL
               AND ($3::timestamptz IS NULL OR started_at >= $3)
               AND ($4::timestamptz IS NULL OR started_at <= $4)
             ORDER BY started_at DESC, id DESC LIMIT $2"
        }
        "conditions" => {
            "SELECT to_jsonb(row_data) - 'deleted_at' AS json
             FROM conditions AS row_data
             WHERE person_id = $1::person AND deleted_at IS NULL
               AND ($3::timestamptz IS NULL OR COALESCE(diagnosed_at, (created_at AT TIME ZONE 'UTC')::date) >= ($3 AT TIME ZONE 'UTC')::date)
               AND ($4::timestamptz IS NULL OR COALESCE(diagnosed_at, (created_at AT TIME ZONE 'UTC')::date) <= ($4 AT TIME ZONE 'UTC')::date)
             ORDER BY COALESCE(diagnosed_at, (created_at AT TIME ZONE 'UTC')::date) DESC, created_at DESC, id DESC LIMIT $2"
        }
        "allergies" => {
            "SELECT to_jsonb(row_data) - 'deleted_at' AS json
             FROM allergies AS row_data
             WHERE person_id = $1::person AND deleted_at IS NULL
               AND ($3::timestamptz IS NULL OR created_at >= $3)
               AND ($4::timestamptz IS NULL OR created_at <= $4)
             ORDER BY created_at DESC, id DESC LIMIT $2"
        }
        "labs" => {
            "SELECT to_jsonb(row_data) - 'deleted_at' - 'dedup_hash' AS json
             FROM labs AS row_data
             WHERE person_id = $1::person AND deleted_at IS NULL
               AND ($3::timestamptz IS NULL OR test_date >= ($3 AT TIME ZONE 'UTC')::date)
               AND ($4::timestamptz IS NULL OR test_date <= ($4 AT TIME ZONE 'UTC')::date)
             ORDER BY test_date DESC, created_at DESC, id DESC LIMIT $2"
        }
        _ => {
            return Err(StorageError::Rejected(format!(
                "unknown section: {section}"
            )));
        }
    };

    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            [
                person.as_str().into(),
                i64::from(limit).into(),
                from.into(),
                to.into(),
            ],
        ))
        .await?;

    rows.into_iter()
        .map(|row| {
            Ok(SummaryRow {
                entity: section.to_owned(),
                json: row.try_get("", "json")?,
            })
        })
        .collect()
}
