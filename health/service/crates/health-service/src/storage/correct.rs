use health_core::RequestCtx;
use sea_orm::{ConnectionTrait, DatabaseBackend, DatabaseConnection, Statement, TransactionTrait};
use uuid::Uuid;

use super::StorageError;

pub struct CorrectMeasurement {
    pub measurement_id: Uuid,
    pub new_values: serde_json::Value,
    pub reason: String,
}

pub async fn correct_measurement(
    db: &DatabaseConnection,
    ctx: &RequestCtx,
    args: CorrectMeasurement,
) -> Result<(), StorageError> {
    let txn = db.begin().await?;
    let measurement = txn
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT values_json, person_id::text AS person_id
             FROM measurements
             WHERE id = $1 AND deleted_at IS NULL
             FOR UPDATE",
            [args.measurement_id.into()],
        ))
        .await?
        .ok_or(StorageError::NotFound)?;
    let old_values = measurement.try_get::<serde_json::Value>("", "values_json")?;
    let target_person = measurement.try_get::<String>("", "person_id")?;

    txn.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "INSERT INTO corrections (
             id, entity_table, entity_id, old_value, new_value, reason, actor, via
         ) VALUES (
             $1, 'measurements', $2, $3, $4, $5, $6::person, $7::via_channel
         )",
        [
            Uuid::new_v4().into(),
            args.measurement_id.into(),
            old_values.clone().into(),
            args.new_values.clone().into(),
            args.reason.into(),
            ctx.actor.as_str().into(),
            ctx.via.as_str().into(),
        ],
    ))
    .await?;

    txn.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE measurements SET values_json = $2 WHERE id = $1",
        [args.measurement_id.into(), args.new_values.clone().into()],
    ))
    .await?;

    txn.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "INSERT INTO audit_log (
             actor, via, target_person, action, entity_table, entity_id,
             result, old_value, new_value
         ) VALUES (
             $1::person, $2::via_channel, $3::person, 'correct_measurement',
             'measurements', $4, 'success', $5, $6
         )",
        [
            ctx.actor.as_str().into(),
            ctx.via.as_str().into(),
            target_person.into(),
            args.measurement_id.into(),
            old_values.into(),
            args.new_values.into(),
        ],
    ))
    .await?;

    txn.commit().await?;
    Ok(())
}
