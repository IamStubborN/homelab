#![cfg(feature = "integration-tests")]

use health_migration::MigratorTrait;
use health_service::{auth::TokenMap, config::Config, mcp, ops, storage};
use tower::ServiceExt;

pub async fn fresh_db() -> sea_orm::DatabaseConnection {
    let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
    let mut options = sea_orm::ConnectOptions::new(url);
    options.max_connections(1);
    let db = sea_orm::Database::connect(options).await.expect("connect");
    use sea_orm::ConnectionTrait;
    db.execute_unprepared("SELECT pg_advisory_lock(721_005)")
        .await
        .expect("lock integration database");
    health_migration::Migrator::fresh(&db)
        .await
        .expect("migrate fresh");
    db
}

#[tokio::test]
async fn migration_applies_and_seeds_people() {
    let db = fresh_db().await;
    use sea_orm::ConnectionTrait;
    let rows = db
        .query_all_raw(sea_orm::Statement::from_string(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT id::text FROM people ORDER BY id".to_owned(),
        ))
        .await
        .unwrap();
    assert_eq!(rows.len(), 2);
}

#[tokio::test]
async fn forward_migration_adds_named_sleep_time_order_constraint() {
    let db = fresh_db().await;
    health_migration::Migrator::down(&db, Some(1))
        .await
        .expect("return to the previously deployed initial schema");

    use sea_orm::ConnectionTrait;
    let invalid_insert = "INSERT INTO sleep_records (
            id, person_id, start_time, end_time, status, actor, via, event_time, dedup_hash
        ) VALUES (
            '00000000-0000-0000-0000-000000000901', 'andrii',
            '2026-08-13T08:00:00Z', '2026-08-13T07:00:00Z',
            'user_reported', 'andrii', 'hermes_andrii',
            '2026-08-13T08:00:00Z', decode('01', 'hex')
        )";
    db.execute_unprepared(invalid_insert)
        .await
        .expect("the old initial schema did not have the constraint");
    db.execute_unprepared("DELETE FROM sleep_records")
        .await
        .unwrap();

    health_migration::Migrator::up(&db, None)
        .await
        .expect("apply forward migration");
    let constraint = db
        .query_one_raw(sea_orm::Statement::from_string(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT conname FROM pg_constraint WHERE conname = 'sleep_records_end_after_start'"
                .to_owned(),
        ))
        .await
        .unwrap();
    assert!(constraint.is_some());
    assert!(db.execute_unprepared(invalid_insert).await.is_err());
}

fn ctx_valentyna() -> health_core::RequestCtx {
    health_core::RequestCtx {
        actor: health_core::Person::Valentyna,
        via: health_core::Via::HermesValentyna,
        default_person: health_core::Person::Valentyna,
    }
}

#[tokio::test]
async fn ops_defaults_person_status_and_event_time() {
    let db = fresh_db().await;
    let before = time::OffsetDateTime::now_utc();
    ops::add_measurement(
        &db,
        &ctx_valentyna(),
        ops::AddMeasurementParams {
            person: None,
            kind: health_core::MeasurementKind::Weight,
            values: serde_json::json!({"value": 78.2}),
            source: None,
            status: None,
            event_time: None,
            source_event_id: None,
        },
    )
    .await
    .unwrap();
    let after = time::OffsetDateTime::now_utc();

    use sea_orm::ConnectionTrait;
    let row = db
        .query_one_raw(sea_orm::Statement::from_string(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT person_id::text AS person, status::text AS status, event_time FROM measurements"
                .to_owned(),
        ))
        .await
        .unwrap()
        .expect("measurement row");
    assert_eq!(row.try_get::<String>("", "person").unwrap(), "valentyna");
    assert_eq!(
        row.try_get::<String>("", "status").unwrap(),
        "user_reported"
    );
    let event_time = row
        .try_get::<time::OffsetDateTime>("", "event_time")
        .unwrap();
    assert!(event_time <= after);
    assert!(event_time >= before);
}

#[tokio::test]
async fn ops_explicit_person_status_and_event_time_override_defaults() {
    let db = fresh_db().await;
    let event_time = time::macros::datetime!(2026-08-01 07:30 UTC);
    ops::add_measurement(
        &db,
        &ctx_valentyna(),
        ops::AddMeasurementParams {
            person: Some(health_core::Person::Andrii),
            kind: health_core::MeasurementKind::Pulse,
            values: serde_json::json!({"value": 72}),
            source: None,
            status: Some(health_core::FactStatus::ConfirmedByDoctor),
            event_time: Some(event_time),
            source_event_id: None,
        },
    )
    .await
    .unwrap();

    use sea_orm::ConnectionTrait;
    let row = db
        .query_one_raw(sea_orm::Statement::from_string(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT person_id::text AS person, status::text AS status, event_time FROM measurements"
                .to_owned(),
        ))
        .await
        .unwrap()
        .expect("measurement row");
    assert_eq!(row.try_get::<String>("", "person").unwrap(), "andrii");
    assert_eq!(
        row.try_get::<String>("", "status").unwrap(),
        "confirmed_by_doctor"
    );
    assert_eq!(
        row.try_get::<time::OffsetDateTime>("", "event_time")
            .unwrap(),
        event_time
    );
}

#[tokio::test]
async fn ops_rejects_invalid_measurement_values_before_writing() {
    let db = fresh_db().await;
    let err = ops::add_measurement(
        &db,
        &ctx_valentyna(),
        ops::AddMeasurementParams {
            person: None,
            kind: health_core::MeasurementKind::BloodPressure,
            values: serde_json::json!({"systolic": 136}),
            source: None,
            status: None,
            event_time: None,
            source_event_id: None,
        },
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("diastolic"));

    use sea_orm::ConnectionTrait;
    let row = db
        .query_one_raw(sea_orm::Statement::from_string(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT count(*)::bigint AS count FROM measurements".to_owned(),
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<i64>("", "count").unwrap(), 0);
}

#[tokio::test]
async fn ops_medication_requires_explicit_true_confirmation() {
    for confirmed in [None, Some(false)] {
        let db = fresh_db().await;
        let err = ops::add_medication(
            &db,
            &ctx_valentyna(),
            ops::AddMedicationParams {
                person: None,
                name: "Panixen".into(),
                dose: None,
                schedule: None,
                started_at: None,
                status: None,
                confirmed,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(
            err.to_string(),
            "confirmation_required: ask the user to confirm with the ✅ card, then retry with confirmed=true"
        );
    }
}

#[tokio::test]
async fn ops_stop_and_correction_require_confirmation_before_storage() {
    let db = fresh_db().await;
    let missing_id = uuid::Uuid::new_v4();
    let stop_err = ops::stop_medication(
        &db,
        &ctx_valentyna(),
        ops::StopMedicationParams {
            person: None,
            medication_id: missing_id,
            stopped_at: None,
            reason: None,
            confirmed: None,
        },
    )
    .await
    .unwrap_err();
    let correction_err = ops::correct_measurement(
        &db,
        &ctx_valentyna(),
        ops::CorrectMeasurementParams {
            measurement_id: missing_id,
            new_values: serde_json::json!({"value": 80}),
            reason: "device reread".into(),
            confirmed: Some(false),
        },
    )
    .await
    .unwrap_err();

    assert!(stop_err.to_string().starts_with("confirmation_required"));
    assert!(
        correction_err
            .to_string()
            .starts_with("confirmation_required")
    );
}

#[tokio::test]
async fn ops_condition_requires_confirmation_before_storage() {
    for confirmed in [None, Some(false)] {
        let db = fresh_db().await;
        let error = ops::add_condition(
            &db,
            &ctx_valentyna(),
            ops::AddConditionParams {
                person: None,
                name: "Hypertension".into(),
                notes: None,
                diagnosed_at: None,
                status: None,
                confirmed,
            },
        )
        .await
        .unwrap_err();
        assert!(error.to_string().starts_with("confirmation_required"));

        use sea_orm::ConnectionTrait;
        let row = db
            .query_one_raw(sea_orm::Statement::from_string(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT count(*)::bigint AS count FROM conditions".to_owned(),
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.try_get::<i64>("", "count").unwrap(), 0);
    }
}

#[tokio::test]
async fn ops_rejects_non_positive_sleep_interval_before_storage() {
    for end_time in [
        time::macros::datetime!(2026-08-05 23:00 +03:00),
        time::macros::datetime!(2026-08-05 22:59 +03:00),
    ] {
        let db = fresh_db().await;
        let error = ops::add_sleep_record(
            &db,
            &ctx_valentyna(),
            ops::AddSleepRecordParams {
                person: None,
                start_time: time::macros::datetime!(2026-08-05 23:00 +03:00),
                end_time,
                quality: None,
                notes: None,
                status: None,
                source_event_id: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "invalid end_time: must be after start_time"
        );
    }
}

#[tokio::test]
async fn database_rejects_non_positive_sleep_interval() {
    let db = fresh_db().await;
    use sea_orm::ConnectionTrait;
    let result = db
        .execute_unprepared(
            "INSERT INTO sleep_records (
                id, person_id, start_time, end_time, status, actor, via, event_time, dedup_hash
             ) VALUES (
                gen_random_uuid(), 'andrii', '2026-08-05 20:00:00Z',
                '2026-08-05 20:00:00Z', 'user_reported', 'andrii',
                'hermes_andrii', '2026-08-05 20:00:00Z', decode(repeat('00', 32), 'hex')
             )",
        )
        .await;

    assert!(result.is_err());
}

#[tokio::test]
async fn ops_medications_query_returns_only_current_rows() {
    let db = fresh_db().await;
    let storage::WriteOutcome::Created { id } = ops::add_medication(
        &db,
        &ctx_valentyna(),
        ops::AddMedicationParams {
            person: None,
            name: "Short course".into(),
            dose: None,
            schedule: None,
            started_at: Some(time::macros::datetime!(2026-08-01 08:00 UTC)),
            status: None,
            confirmed: Some(true),
        },
    )
    .await
    .unwrap() else {
        panic!("expected Created")
    };
    ops::stop_medication(
        &db,
        &ctx_valentyna(),
        ops::StopMedicationParams {
            person: None,
            medication_id: id,
            stopped_at: Some(time::macros::datetime!(2026-08-02 08:00 UTC)),
            reason: None,
            confirmed: Some(true),
        },
    )
    .await
    .unwrap();

    let rows = ops::query_health_data(
        &db,
        &ctx_valentyna(),
        ops::QueryHealthDataParams {
            person: None,
            section: "medications".into(),
            limit: None,
            from: None,
            to: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(rows, serde_json::json!([]));
}

#[tokio::test]
async fn ops_query_applies_inclusive_time_bounds_to_every_temporal_section() {
    let db = fresh_db().await;
    let ctx = ctx_valentyna();
    let inside_time = time::macros::datetime!(2026-08-10 00:00 UTC);
    let outside_time = time::macros::datetime!(2026-08-09 23:59:59 UTC);
    let inside_date = time::macros::date!(2026 - 08 - 10);
    let outside_date = time::macros::date!(2026 - 08 - 09);

    for (value, event_time) in [(70, inside_time), (71, outside_time)] {
        storage::add_measurement(
            &db,
            &ctx,
            storage::AddMeasurement {
                person: health_core::Person::Valentyna,
                kind: health_core::MeasurementKind::Pulse,
                values: serde_json::json!({"value": value}),
                source: None,
                status: health_core::FactStatus::UserReported,
                event_time,
                source_event_id: None,
            },
        )
        .await
        .unwrap();
    }
    for (description, event_time) in [("inside meal", inside_time), ("outside meal", outside_time)]
    {
        storage::add_meal(
            &db,
            &ctx,
            storage::AddMeal {
                person: health_core::Person::Valentyna,
                description: description.into(),
                items: None,
                calories: None,
                status: health_core::FactStatus::UserReported,
                event_time,
                source_event_id: None,
            },
        )
        .await
        .unwrap();
    }
    for (description, event_time) in [
        ("inside symptom", inside_time),
        ("outside symptom", outside_time),
    ] {
        storage::add_symptom(
            &db,
            &ctx,
            storage::AddSymptom {
                person: health_core::Person::Valentyna,
                description: description.into(),
                severity: None,
                status: health_core::FactStatus::UserReported,
                event_time,
                source_event_id: None,
            },
        )
        .await
        .unwrap();
    }
    for start_time in [inside_time, outside_time] {
        storage::add_sleep_record(
            &db,
            &ctx,
            storage::AddSleepRecord {
                person: health_core::Person::Valentyna,
                start_time,
                end_time: start_time + time::Duration::hours(1),
                quality: None,
                notes: None,
                status: health_core::FactStatus::UserReported,
                source_event_id: None,
            },
        )
        .await
        .unwrap();
    }
    for (name, started_at) in [
        ("inside medication", inside_time),
        ("outside medication", outside_time),
    ] {
        storage::add_medication(
            &db,
            &ctx,
            storage::AddMedication {
                person: health_core::Person::Valentyna,
                name: name.into(),
                dose: None,
                schedule: None,
                started_at,
                status: health_core::FactStatus::UserReported,
            },
        )
        .await
        .unwrap();
    }
    for (name, diagnosed_at) in [
        ("inside condition", inside_date),
        ("outside condition", outside_date),
    ] {
        storage::add_condition(
            &db,
            &ctx,
            storage::AddCondition {
                person: health_core::Person::Valentyna,
                name: name.into(),
                notes: None,
                diagnosed_at: Some(diagnosed_at),
                status: health_core::FactStatus::UserReported,
            },
        )
        .await
        .unwrap();
    }
    let mut allergy_ids = Vec::new();
    for allergen in ["inside allergy", "outside allergy"] {
        let storage::WriteOutcome::Created { id } = storage::add_allergy(
            &db,
            &ctx,
            storage::AddAllergy {
                person: health_core::Person::Valentyna,
                allergen: allergen.into(),
                reaction: None,
                severity: None,
                status: health_core::FactStatus::UserReported,
            },
        )
        .await
        .unwrap() else {
            panic!("expected Created")
        };
        allergy_ids.push(id);
    }
    use sea_orm::ConnectionTrait;
    for (id, created_at) in allergy_ids.into_iter().zip([inside_time, outside_time]) {
        db.execute_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "UPDATE allergies SET created_at = $2 WHERE id = $1",
            [id.into(), created_at.into()],
        ))
        .await
        .unwrap();
    }
    for (test_name, test_date) in [("inside lab", inside_date), ("outside lab", outside_date)] {
        storage::add_lab_result(
            &db,
            &ctx,
            storage::AddLabResult {
                person: health_core::Person::Valentyna,
                test_date,
                test_name: test_name.into(),
                value: 1.0,
                unit: None,
                reference_min: None,
                reference_max: None,
                flag: None,
                laboratory: None,
                source_document: None,
                status: health_core::FactStatus::UserReported,
            },
        )
        .await
        .unwrap();
    }

    for section in [
        "measurements",
        "pulse",
        "meals",
        "symptoms",
        "sleep",
        "medications",
        "conditions",
        "allergies",
        "labs",
    ] {
        let rows = ops::query_health_data(
            &db,
            &ctx,
            ops::QueryHealthDataParams {
                person: None,
                section: section.into(),
                limit: None,
                from: Some(inside_time),
                to: Some(time::macros::datetime!(2026-08-10 23:59:59 UTC)),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            rows.as_array().unwrap().len(),
            1,
            "section {section}: {rows}"
        );
    }
}

#[tokio::test]
async fn condition_created_at_fallback_uses_utc_date_independent_of_session_timezone() {
    let db = fresh_db().await;
    use sea_orm::ConnectionTrait;
    db.execute_unprepared("SET TIME ZONE 'America/Los_Angeles'")
        .await
        .unwrap();
    let storage::WriteOutcome::Created { id } = storage::add_condition(
        &db,
        &ctx_valentyna(),
        storage::AddCondition {
            person: health_core::Person::Valentyna,
            name: "UTC boundary condition".into(),
            notes: None,
            diagnosed_at: None,
            status: health_core::FactStatus::UserReported,
        },
    )
    .await
    .unwrap() else {
        panic!("expected Created")
    };
    db.execute_raw(sea_orm::Statement::from_sql_and_values(
        sea_orm::DatabaseBackend::Postgres,
        "UPDATE conditions SET created_at = $2 WHERE id = $1",
        [
            id.into(),
            time::macros::datetime!(2026-08-10 00:30 UTC).into(),
        ],
    ))
    .await
    .unwrap();

    let rows = ops::query_health_data(
        &db,
        &ctx_valentyna(),
        ops::QueryHealthDataParams {
            person: None,
            section: "conditions".into(),
            limit: None,
            from: Some(time::macros::datetime!(2026-08-10 00:00 UTC)),
            to: Some(time::macros::datetime!(2026-08-10 23:59:59 UTC)),
        },
    )
    .await
    .unwrap();

    assert_eq!(rows.as_array().unwrap().len(), 1, "{rows}");
    assert_eq!(rows[0]["name"], "UTC boundary condition");
}

#[tokio::test]
async fn latest_measurement_series_applies_limit_in_sql_and_returns_chronological_rows() {
    let db = fresh_db().await;
    for (value, event_time) in [
        (10, time::macros::datetime!(2026-08-01 08:00 UTC)),
        (20, time::macros::datetime!(2026-08-02 08:00 UTC)),
        (30, time::macros::datetime!(2026-08-03 08:00 UTC)),
    ] {
        storage::add_measurement(
            &db,
            &ctx_valentyna(),
            storage::AddMeasurement {
                person: health_core::Person::Valentyna,
                kind: health_core::MeasurementKind::Pulse,
                values: serde_json::json!({"value": value}),
                source: None,
                status: health_core::FactStatus::UserReported,
                event_time,
                source_event_id: None,
            },
        )
        .await
        .unwrap();
    }

    let empty = storage::latest_measurement_series(
        &db,
        health_core::Person::Valentyna,
        health_core::MeasurementKind::Pulse,
        time::macros::datetime!(2026-08-01 00:00 UTC),
        time::macros::datetime!(2026-08-04 00:00 UTC),
        0,
    )
    .await
    .unwrap();
    let latest = storage::latest_measurement_series(
        &db,
        health_core::Person::Valentyna,
        health_core::MeasurementKind::Pulse,
        time::macros::datetime!(2026-08-01 00:00 UTC),
        time::macros::datetime!(2026-08-04 00:00 UTC),
        2,
    )
    .await
    .unwrap();

    assert!(empty.is_empty());
    assert_eq!(
        latest
            .iter()
            .map(|row| row.values["value"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![20, 30]
    );

    let queried = ops::query_health_data(
        &db,
        &ctx_valentyna(),
        ops::QueryHealthDataParams {
            person: None,
            section: "pulse".into(),
            limit: Some(2),
            from: Some(time::macros::datetime!(2026-08-01 00:00 UTC)),
            to: Some(time::macros::datetime!(2026-08-04 00:00 UTC)),
        },
    )
    .await
    .unwrap();
    assert_eq!(queried[0]["values"]["value"], 20);
    assert_eq!(queried[1]["values"]["value"], 30);
}

#[tokio::test]
async fn chart_measurement_series_is_bounded_in_sql_to_latest_rows() {
    let db = fresh_db().await;
    use sea_orm::ConnectionTrait;
    db.execute_unprepared(&format!(
        "INSERT INTO measurements (
            id, person_id, kind, values_json, status, actor, via, event_time, dedup_hash
         )
         SELECT gen_random_uuid(), 'andrii', 'pulse', jsonb_build_object('value', value),
                'user_reported', 'andrii', 'hermes_andrii',
                '2026-01-01 00:00:00Z'::timestamptz + value * interval '1 second',
                decode(md5(value::text) || md5(('x' || value)::text), 'hex')
         FROM generate_series(0, {}) AS value",
        storage::MAX_CHART_POINTS
    ))
    .await
    .unwrap();

    let rows = storage::measurement_series(
        &db,
        health_core::Person::Andrii,
        health_core::MeasurementKind::Pulse,
        time::macros::datetime!(2026-01-01 00:00 UTC),
        time::macros::datetime!(2026-01-02 00:00 UTC),
    )
    .await
    .unwrap();

    assert_eq!(rows.len(), storage::MAX_CHART_POINTS as usize);
    assert_eq!(rows.first().unwrap().values["value"], 1);
    assert_eq!(
        rows.last().unwrap().values["value"],
        storage::MAX_CHART_POINTS
    );
}

#[tokio::test]
async fn ops_rejects_excessive_query_limit_and_chart_days_before_database_access() {
    let db = sea_orm::DatabaseConnection::default();
    let query_error = ops::query_health_data(
        &db,
        &ctx_valentyna(),
        ops::QueryHealthDataParams {
            person: None,
            section: "meals".into(),
            limit: Some(201),
            from: None,
            to: None,
        },
    )
    .await
    .unwrap_err();
    let chart_error = ops::generate_chart(
        &db,
        &ctx_valentyna(),
        ops::GenerateChartParams {
            person: None,
            kind: health_core::MeasurementKind::Weight,
            days: Some(u32::MAX),
            title: None,
        },
    )
    .await
    .unwrap_err();

    assert_eq!(query_error.to_string(), "invalid limit: maximum is 200");
    assert_eq!(chart_error.to_string(), "invalid days: maximum is 3650");
}

#[tokio::test]
async fn mcp_stop_medication_returns_updated_outcome() {
    let db = fresh_db().await;
    let storage::WriteOutcome::Created { id } = storage::add_medication(
        &db,
        &ctx_valentyna(),
        storage::AddMedication {
            person: health_core::Person::Andrii,
            name: "Short course".into(),
            dose: None,
            schedule: None,
            started_at: time::macros::datetime!(2026-08-01 08:00 UTC),
            status: health_core::FactStatus::UserReported,
        },
    )
    .await
    .unwrap() else {
        panic!("expected Created")
    };
    let response = mcp_json(
        mcp_app(db)
            .oneshot(mcp_call(
                "andrii-secret",
                9,
                "stop_medication",
                serde_json::json!({"medication_id": id, "confirmed": true}),
            ))
            .await
            .unwrap(),
    )
    .await;

    assert_eq!(
        response["result"]["structuredContent"],
        serde_json::json!({"outcome": "updated", "id": id})
    );
}

async fn assert_success_audit(
    db: &sea_orm::DatabaseConnection,
    id: uuid::Uuid,
    table: &str,
    action: &str,
) {
    use sea_orm::ConnectionTrait;
    let audit = db
        .query_one_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT actor::text AS actor, via::text AS via, target_person::text AS target, result \
             FROM audit_log \
             WHERE entity_id = $1 AND entity_table = $2 AND action = $3",
            [id.into(), table.into(), action.into()],
        ))
        .await
        .unwrap()
        .expect("success audit row");
    assert_eq!(audit.try_get::<String>("", "actor").unwrap(), "valentyna");
    assert_eq!(
        audit.try_get::<String>("", "via").unwrap(),
        "hermes_valentyna"
    );
    assert_eq!(audit.try_get::<String>("", "target").unwrap(), "andrii");
    assert_eq!(audit.try_get::<String>("", "result").unwrap(), "success");
}

fn created_and_duplicate_ids(
    out_a: Result<storage::WriteOutcome, storage::StorageError>,
    out_b: Result<storage::WriteOutcome, storage::StorageError>,
) -> (uuid::Uuid, uuid::Uuid) {
    match (out_a.unwrap(), out_b.unwrap()) {
        (
            storage::WriteOutcome::Created { id },
            storage::WriteOutcome::Duplicate { existing_id },
        )
        | (
            storage::WriteOutcome::Duplicate { existing_id },
            storage::WriteOutcome::Created { id },
        ) => (id, existing_id),
        outcomes => panic!("expected one Created and one Duplicate, got {outcomes:?}"),
    }
}

async fn assert_dedup_audits(db: &sea_orm::DatabaseConnection, action: &str, id: uuid::Uuid) {
    use sea_orm::ConnectionTrait;
    let audit = db
        .query_one_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT
                 count(*) FILTER (WHERE result = 'success')::bigint AS successes,
                 count(*) FILTER (WHERE result = 'duplicate')::bigint AS duplicates
             FROM audit_log
             WHERE action = $1 AND entity_id = $2",
            [action.into(), id.into()],
        ))
        .await
        .unwrap()
        .expect("dedup audit counts");
    assert_eq!(audit.try_get::<i64>("", "successes").unwrap(), 1);
    assert_eq!(audit.try_get::<i64>("", "duplicates").unwrap(), 1);
}

fn mcp_app(db: sea_orm::DatabaseConnection) -> axum::Router {
    let dir = tempfile::tempdir().unwrap();
    let andrii = dir.path().join("andrii-token");
    let valentyna = dir.path().join("valentyna-token");
    std::fs::write(&andrii, "andrii-secret").unwrap();
    std::fs::write(&valentyna, "valentyna-secret").unwrap();
    let tokens = TokenMap::load(&Config {
        database_url: "postgres://unused/health".to_owned(),
        listen_addr: "127.0.0.1:8080".parse().unwrap(),
        andrii_token_file: andrii,
        valentyna_token_file: valentyna,
    })
    .unwrap();
    mcp::router(db, tokens, "127.0.0.1:8080".parse().unwrap())
}

fn mcp_call(
    token: &str,
    id: u32,
    name: &str,
    arguments: serde_json::Value,
) -> axum::http::Request<axum::body::Body> {
    axum::http::Request::post("/internal/mcp")
        .header("authorization", format!("Bearer {token}"))
        .header("host", "localhost:8080")
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .body(axum::body::Body::from(
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            })
            .to_string(),
        ))
        .unwrap()
}

async fn mcp_json(response: axum::response::Response) -> serde_json::Value {
    assert_eq!(response.status(), 200);
    serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn concurrent_mcp_requests_keep_authenticated_profiles_isolated() {
    let db = fresh_db().await;
    let app = mcp_app(db.clone());
    let arguments = |value| {
        serde_json::json!({
            "kind": "weight",
            "values": {"value": value},
            "event_time": "2026-08-12T10:00:00Z"
        })
    };
    let (andrii, valentyna) = tokio::join!(
        app.clone().oneshot(mcp_call(
            "andrii-secret",
            1,
            "add_measurement",
            arguments(81.4),
        )),
        app.oneshot(mcp_call(
            "valentyna-secret",
            2,
            "add_measurement",
            arguments(78.2),
        )),
    );
    let andrii = mcp_json(andrii.unwrap()).await;
    let valentyna = mcp_json(valentyna.unwrap()).await;
    assert_eq!(andrii["result"]["structuredContent"]["outcome"], "created");
    assert_eq!(
        valentyna["result"]["structuredContent"]["outcome"],
        "created"
    );

    use sea_orm::ConnectionTrait;
    let rows = db
        .query_all_raw(sea_orm::Statement::from_string(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT person_id::text AS person, values_json FROM measurements ORDER BY person_id"
                .to_owned(),
        ))
        .await
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].try_get::<String>("", "person").unwrap(), "andrii");
    assert_eq!(
        rows[0]
            .try_get::<serde_json::Value>("", "values_json")
            .unwrap(),
        serde_json::json!({"value": 81.4})
    );
    assert_eq!(
        rows[1].try_get::<String>("", "person").unwrap(),
        "valentyna"
    );
    assert_eq!(
        rows[1]
            .try_get::<serde_json::Value>("", "values_json")
            .unwrap(),
        serde_json::json!({"value": 78.2})
    );
}

#[tokio::test]
async fn valentyna_mcp_rejects_mistaken_person_id_without_writing() {
    let db = fresh_db().await;
    let response = mcp_json(
        mcp_app(db.clone())
            .oneshot(mcp_call(
                "valentyna-secret",
                3,
                "add_measurement",
                serde_json::json!({
                    "person_id": "andrii",
                    "kind": "weight",
                    "values": {"value": 78.2},
                    "event_time": "2026-08-12T10:00:00Z"
                }),
            ))
            .await
            .unwrap(),
    )
    .await;

    assert_eq!(response["result"]["isError"], true, "{response}");
    assert!(
        response["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("unknown field `person_id`")
    );
    use sea_orm::ConnectionTrait;
    let row = db
        .query_one_raw(sea_orm::Statement::from_string(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT count(*)::bigint AS count FROM measurements".to_owned(),
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<i64>("", "count").unwrap(), 0);
}

#[tokio::test]
async fn stable_source_event_id_deduplicates_across_boundaries_and_keeps_original_payload() {
    let db = fresh_db().await;
    let first_time = time::macros::datetime!(2026-08-13 10:05:29 UTC);
    let retry_time = time::macros::datetime!(2026-08-13 10:05:31 UTC);
    let first = storage::add_measurement(
        &db,
        &ctx_valentyna(),
        storage::AddMeasurement {
            person: health_core::Person::Valentyna,
            kind: health_core::MeasurementKind::Weight,
            values: serde_json::json!({"value": 78.2}),
            source: None,
            status: health_core::FactStatus::UserReported,
            event_time: first_time,
            source_event_id: Some("telegram:42:100".to_owned()),
        },
    )
    .await
    .unwrap();
    let repeated = storage::add_measurement(
        &db,
        &ctx_valentyna(),
        storage::AddMeasurement {
            person: health_core::Person::Valentyna,
            kind: health_core::MeasurementKind::Weight,
            values: serde_json::json!({"value": 99.9}),
            source: None,
            status: health_core::FactStatus::UserReported,
            event_time: retry_time,
            source_event_id: Some("telegram:42:100".to_owned()),
        },
    )
    .await
    .unwrap();

    let storage::WriteOutcome::Created { id } = first else {
        panic!("first write must create")
    };
    assert_eq!(
        repeated,
        storage::WriteOutcome::Duplicate { existing_id: id }
    );

    use sea_orm::ConnectionTrait;
    let row = db
        .query_one_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT event_time, values_json FROM measurements WHERE id = $1",
            [id.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        row.try_get::<time::OffsetDateTime>("", "event_time")
            .unwrap(),
        first_time
    );
    assert_eq!(
        row.try_get::<serde_json::Value>("", "values_json").unwrap(),
        serde_json::json!({"value": 78.2})
    );
}

#[tokio::test]
async fn source_identity_avoids_old_bucket_false_positives() {
    let db = fresh_db().await;
    let add = |event_time, source_event_id: Option<&str>| storage::AddMeasurement {
        person: health_core::Person::Valentyna,
        kind: health_core::MeasurementKind::Weight,
        values: serde_json::json!({"value": 78.2}),
        source: None,
        status: health_core::FactStatus::UserReported,
        event_time,
        source_event_id: source_event_id.map(str::to_owned),
    };

    let first = storage::add_measurement(
        &db,
        &ctx_valentyna(),
        add(
            time::macros::datetime!(2026-08-13 10:00:31 UTC),
            Some("telegram:42:200"),
        ),
    )
    .await
    .unwrap();
    let independent = storage::add_measurement(
        &db,
        &ctx_valentyna(),
        add(
            time::macros::datetime!(2026-08-13 10:05:29 UTC),
            Some("telegram:42:201"),
        ),
    )
    .await
    .unwrap();
    assert!(matches!(first, storage::WriteOutcome::Created { .. }));
    assert!(matches!(independent, storage::WriteOutcome::Created { .. }));

    let same_time = time::macros::datetime!(2026-08-13 10:30:00 UTC);
    for source_event_id in ["telegram:42:202", "telegram:42:203"] {
        assert!(matches!(
            storage::add_measurement(&db, &ctx_valentyna(), add(same_time, Some(source_event_id)),)
                .await
                .unwrap(),
            storage::WriteOutcome::Created { .. }
        ));
    }

    let no_source_a = storage::add_measurement(
        &db,
        &ctx_valentyna(),
        add(time::macros::datetime!(2026-08-13 11:00:31 UTC), None),
    )
    .await
    .unwrap();
    let no_source_b = storage::add_measurement(
        &db,
        &ctx_valentyna(),
        add(time::macros::datetime!(2026-08-13 11:05:29 UTC), None),
    )
    .await
    .unwrap();
    assert!(matches!(no_source_a, storage::WriteOutcome::Created { .. }));
    assert!(matches!(no_source_b, storage::WriteOutcome::Created { .. }));

    let exact = time::macros::datetime!(2026-08-13 11:10:00 UTC);
    let same_second_a = storage::add_measurement(&db, &ctx_valentyna(), add(exact, None))
        .await
        .unwrap();
    let same_second_b = storage::add_measurement(
        &db,
        &ctx_valentyna(),
        add(exact + time::Duration::nanoseconds(1), None),
    )
    .await
    .unwrap();
    assert!(matches!(
        same_second_a,
        storage::WriteOutcome::Created { .. }
    ));
    assert!(matches!(
        same_second_b,
        storage::WriteOutcome::Created { .. }
    ));
}

#[tokio::test]
async fn mcp_duplicate_is_normal_json_and_chart_is_png_image_content() {
    let db = fresh_db().await;
    let app = mcp_app(db);
    let arguments = serde_json::json!({
        "kind": "weight",
        "values": {"value": 81.4},
        "source_event_id": "telegram:42:300"
    });
    let first = mcp_json(
        app.clone()
            .oneshot(mcp_call(
                "andrii-secret",
                1,
                "add_measurement",
                arguments.clone(),
            ))
            .await
            .unwrap(),
    )
    .await;
    let duplicate = mcp_json(
        app.clone()
            .oneshot(mcp_call("andrii-secret", 2, "add_measurement", arguments))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(duplicate["result"]["isError"], false);
    assert_eq!(
        duplicate["result"]["structuredContent"],
        serde_json::json!({
            "outcome": "duplicate",
            "existing_id": first["result"]["structuredContent"]["id"],
        })
    );

    let chart = mcp_json(
        app.oneshot(mcp_call(
            "andrii-secret",
            3,
            "generate_chart",
            serde_json::json!({"kind": "weight", "days": 1}),
        ))
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(chart["result"]["content"][0]["type"], "image");
    assert_eq!(chart["result"]["content"][0]["mimeType"], "image/png");
    use base64::Engine;
    let png = base64::engine::general_purpose::STANDARD
        .decode(chart["result"]["content"][0]["data"].as_str().unwrap())
        .unwrap();
    assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
}

#[tokio::test]
async fn add_measurement_writes_row_and_audit() {
    let db = fresh_db().await;
    let out = storage::add_measurement(
        &db,
        &ctx_valentyna(),
        storage::AddMeasurement {
            person: health_core::Person::Andrii,
            kind: health_core::MeasurementKind::BloodPressure,
            values: serde_json::json!({"systolic":136,"diastolic":97,"pulse":91}),
            source: Some("home_device".into()),
            status: health_core::FactStatus::UserReported,
            event_time: time::macros::datetime!(2026-08-04 14:30 +03:00),
            source_event_id: None,
        },
    )
    .await
    .unwrap();
    let storage::WriteOutcome::Created { id } = out else {
        panic!("expected Created")
    };

    use sea_orm::ConnectionTrait;
    let audit = db
        .query_one_raw(sea_orm::Statement::from_string(
            sea_orm::DatabaseBackend::Postgres,
            format!(
                "SELECT actor::text a, via::text v, target_person::text t, action, result \
                 FROM audit_log WHERE entity_id = '{id}'"
            ),
        ))
        .await
        .unwrap()
        .expect("audit row");
    assert_eq!(audit.try_get::<String>("", "a").unwrap(), "valentyna");
    assert_eq!(
        audit.try_get::<String>("", "v").unwrap(),
        "hermes_valentyna"
    );
    assert_eq!(audit.try_get::<String>("", "t").unwrap(), "andrii");
    assert_eq!(
        audit.try_get::<String>("", "action").unwrap(),
        "add_measurement"
    );
    assert_eq!(audit.try_get::<String>("", "result").unwrap(), "success");
}

#[tokio::test]
async fn identical_measurement_is_reported_duplicate() {
    let db = fresh_db().await;
    let args = || storage::AddMeasurement {
        person: health_core::Person::Andrii,
        kind: health_core::MeasurementKind::Weight,
        values: serde_json::json!({"value":120.5,"unit":"kg"}),
        source: None,
        status: health_core::FactStatus::UserReported,
        event_time: time::macros::datetime!(2026-08-04 08:00 +03:00),
        source_event_id: None,
    };
    let storage::WriteOutcome::Created { id } =
        storage::add_measurement(&db, &ctx_valentyna(), args())
            .await
            .unwrap()
    else {
        panic!()
    };
    let storage::WriteOutcome::Duplicate { existing_id } =
        storage::add_measurement(&db, &ctx_valentyna(), args())
            .await
            .unwrap()
    else {
        panic!("expected Duplicate")
    };
    assert_eq!(id, existing_id);

    use sea_orm::ConnectionTrait;
    let audit = db
        .query_one_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT count(*)::bigint AS count \
             FROM audit_log \
             WHERE entity_id = $1 AND result = 'duplicate'",
            [id.into()],
        ))
        .await
        .unwrap()
        .expect("duplicate audit row count");
    assert_eq!(audit.try_get::<i64>("", "count").unwrap(), 1);
}

#[tokio::test]
async fn concurrent_identical_measurements_create_once_and_audit_duplicate() {
    let setup_db = fresh_db().await;
    let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
    let db_a = sea_orm::Database::connect(&url).await.expect("connect A");
    let db_b = sea_orm::Database::connect(&url).await.expect("connect B");
    let args = || storage::AddMeasurement {
        person: health_core::Person::Andrii,
        kind: health_core::MeasurementKind::Temperature,
        values: serde_json::json!({"value":37.2,"unit":"celsius"}),
        source: Some("home_thermometer".into()),
        status: health_core::FactStatus::UserReported,
        event_time: time::macros::datetime!(2026-08-04 08:15 +03:00),
        source_event_id: None,
    };

    let ctx_a = ctx_valentyna();
    let ctx_b = ctx_valentyna();
    let (out_a, out_b) = tokio::join!(
        storage::add_measurement(&db_a, &ctx_a, args()),
        storage::add_measurement(&db_b, &ctx_b, args()),
    );
    let (created_id, duplicate_id) = match (out_a.unwrap(), out_b.unwrap()) {
        (
            storage::WriteOutcome::Created { id },
            storage::WriteOutcome::Duplicate { existing_id },
        )
        | (
            storage::WriteOutcome::Duplicate { existing_id },
            storage::WriteOutcome::Created { id },
        ) => (id, existing_id),
        outcomes => panic!("expected one Created and one Duplicate, got {outcomes:?}"),
    };
    assert_eq!(created_id, duplicate_id);

    use sea_orm::ConnectionTrait;
    let audit = setup_db
        .query_one_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT
                 count(*)::bigint AS total,
                 count(*) FILTER (WHERE result = 'success')::bigint AS successes,
                 count(*) FILTER (WHERE result = 'duplicate')::bigint AS duplicates
             FROM audit_log
             WHERE action = 'add_measurement' AND entity_id = $1",
            [created_id.into()],
        ))
        .await
        .unwrap()
        .expect("audit counts");
    assert_eq!(audit.try_get::<i64>("", "total").unwrap(), 2);
    assert_eq!(audit.try_get::<i64>("", "successes").unwrap(), 1);
    assert_eq!(audit.try_get::<i64>("", "duplicates").unwrap(), 1);
}

#[tokio::test]
async fn add_meal_writes_row_and_audit() {
    let db = fresh_db().await;
    let storage::WriteOutcome::Created { id } = storage::add_meal(
        &db,
        &ctx_valentyna(),
        storage::AddMeal {
            person: health_core::Person::Andrii,
            description: "Buckwheat with chicken".into(),
            items: Some(serde_json::json!(["buckwheat", "chicken"])),
            calories: Some(540),
            status: health_core::FactStatus::UserReported,
            event_time: time::macros::datetime!(2026-08-05 12:30 +03:00),
            source_event_id: None,
        },
    )
    .await
    .unwrap() else {
        panic!("expected Created")
    };

    use sea_orm::ConnectionTrait;
    let row = db
        .query_one_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT description, items_json, calories FROM meals WHERE id = $1",
            [id.into()],
        ))
        .await
        .unwrap()
        .expect("meal row");
    assert_eq!(
        row.try_get::<String>("", "description").unwrap(),
        "Buckwheat with chicken"
    );
    assert_eq!(
        row.try_get::<serde_json::Value>("", "items_json").unwrap(),
        serde_json::json!(["buckwheat", "chicken"])
    );
    assert_eq!(row.try_get::<i32>("", "calories").unwrap(), 540);
    assert_success_audit(&db, id, "meals", "add_meal").await;
}

#[tokio::test]
async fn same_meal_twice_is_duplicate() {
    let setup_db = fresh_db().await;
    let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
    let db_a = sea_orm::Database::connect(&url).await.expect("connect A");
    let db_b = sea_orm::Database::connect(&url).await.expect("connect B");
    let args = || storage::AddMeal {
        person: health_core::Person::Andrii,
        description: "Oatmeal".into(),
        items: None,
        calories: Some(320),
        status: health_core::FactStatus::UserReported,
        event_time: time::macros::datetime!(2026-08-05 08:00 +03:00),
        source_event_id: None,
    };
    let ctx_a = ctx_valentyna();
    let ctx_b = ctx_valentyna();
    let (out_a, out_b) = tokio::join!(
        storage::add_meal(&db_a, &ctx_a, args()),
        storage::add_meal(&db_b, &ctx_b, args()),
    );
    let (id, existing_id) = created_and_duplicate_ids(out_a, out_b);
    assert_eq!(existing_id, id);
    assert_dedup_audits(&setup_db, "add_meal", id).await;
}

#[tokio::test]
async fn add_symptom_writes_row_and_audit() {
    let db = fresh_db().await;
    let storage::WriteOutcome::Created { id } = storage::add_symptom(
        &db,
        &ctx_valentyna(),
        storage::AddSymptom {
            person: health_core::Person::Andrii,
            description: "Headache".into(),
            severity: Some(6),
            status: health_core::FactStatus::Suspected,
            event_time: time::macros::datetime!(2026-08-05 16:15 +03:00),
            source_event_id: None,
        },
    )
    .await
    .unwrap() else {
        panic!("expected Created")
    };

    use sea_orm::ConnectionTrait;
    let row = db
        .query_one_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT description, severity, status::text AS status FROM symptoms WHERE id = $1",
            [id.into()],
        ))
        .await
        .unwrap()
        .expect("symptom row");
    assert_eq!(
        row.try_get::<String>("", "description").unwrap(),
        "Headache"
    );
    assert_eq!(row.try_get::<i32>("", "severity").unwrap(), 6);
    assert_eq!(row.try_get::<String>("", "status").unwrap(), "suspected");
    assert_success_audit(&db, id, "symptoms", "add_symptom").await;
}

#[tokio::test]
async fn concurrent_identical_symptoms_create_once_and_audit_duplicate() {
    let setup_db = fresh_db().await;
    let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
    let db_a = sea_orm::Database::connect(&url).await.expect("connect A");
    let db_b = sea_orm::Database::connect(&url).await.expect("connect B");
    let args = || storage::AddSymptom {
        person: health_core::Person::Andrii,
        description: "Nausea".into(),
        severity: Some(4),
        status: health_core::FactStatus::UserReported,
        event_time: time::macros::datetime!(2026-08-06 15:00 +03:00),
        source_event_id: None,
    };
    let ctx_a = ctx_valentyna();
    let ctx_b = ctx_valentyna();
    let (out_a, out_b) = tokio::join!(
        storage::add_symptom(&db_a, &ctx_a, args()),
        storage::add_symptom(&db_b, &ctx_b, args()),
    );
    let (id, existing_id) = created_and_duplicate_ids(out_a, out_b);
    assert_eq!(existing_id, id);
    assert_dedup_audits(&setup_db, "add_symptom", id).await;
}

#[tokio::test]
async fn add_sleep_record_writes_row_and_audit() {
    let db = fresh_db().await;
    let start = time::macros::datetime!(2026-08-04 23:00 +03:00);
    let end = time::macros::datetime!(2026-08-05 07:15 +03:00);
    let storage::WriteOutcome::Created { id } = storage::add_sleep_record(
        &db,
        &ctx_valentyna(),
        storage::AddSleepRecord {
            person: health_core::Person::Andrii,
            start_time: start,
            end_time: end,
            quality: Some(8),
            notes: Some("Woke once".into()),
            status: health_core::FactStatus::UserReported,
            source_event_id: None,
        },
    )
    .await
    .unwrap() else {
        panic!("expected Created")
    };

    use sea_orm::ConnectionTrait;
    let row = db
        .query_one_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT start_time, end_time, event_time, quality, notes FROM sleep_records WHERE id = $1",
            [id.into()],
        ))
        .await
        .unwrap()
        .expect("sleep row");
    assert_eq!(
        row.try_get::<time::OffsetDateTime>("", "start_time")
            .unwrap(),
        start
    );
    assert_eq!(
        row.try_get::<time::OffsetDateTime>("", "end_time").unwrap(),
        end
    );
    assert_eq!(
        row.try_get::<time::OffsetDateTime>("", "event_time")
            .unwrap(),
        start
    );
    assert_eq!(row.try_get::<i32>("", "quality").unwrap(), 8);
    assert_eq!(row.try_get::<String>("", "notes").unwrap(), "Woke once");
    assert_success_audit(&db, id, "sleep_records", "add_sleep_record").await;
}

#[tokio::test]
async fn equivalent_sleep_offsets_are_duplicate() {
    let db = fresh_db().await;
    let args = |start_time, end_time| storage::AddSleepRecord {
        person: health_core::Person::Andrii,
        start_time,
        end_time,
        quality: Some(8),
        notes: None,
        status: health_core::FactStatus::UserReported,
        source_event_id: None,
    };
    let storage::WriteOutcome::Created { id } = storage::add_sleep_record(
        &db,
        &ctx_valentyna(),
        args(
            time::macros::datetime!(2026-08-04 23:00 +03:00),
            time::macros::datetime!(2026-08-05 07:00 +03:00),
        ),
    )
    .await
    .unwrap() else {
        panic!("expected Created")
    };
    let storage::WriteOutcome::Duplicate { existing_id } = storage::add_sleep_record(
        &db,
        &ctx_valentyna(),
        args(
            time::macros::datetime!(2026-08-04 20:00 UTC),
            time::macros::datetime!(2026-08-05 04:00 UTC),
        ),
    )
    .await
    .unwrap() else {
        panic!("expected Duplicate")
    };
    assert_eq!(existing_id, id);
}

#[tokio::test]
async fn concurrent_identical_sleep_records_create_once_and_audit_duplicate() {
    let setup_db = fresh_db().await;
    let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
    let db_a = sea_orm::Database::connect(&url).await.expect("connect A");
    let db_b = sea_orm::Database::connect(&url).await.expect("connect B");
    let args = || storage::AddSleepRecord {
        person: health_core::Person::Andrii,
        start_time: time::macros::datetime!(2026-08-06 23:00 +03:00),
        end_time: time::macros::datetime!(2026-08-07 07:00 +03:00),
        quality: Some(7),
        notes: None,
        status: health_core::FactStatus::UserReported,
        source_event_id: None,
    };
    let ctx_a = ctx_valentyna();
    let ctx_b = ctx_valentyna();
    let (out_a, out_b) = tokio::join!(
        storage::add_sleep_record(&db_a, &ctx_a, args()),
        storage::add_sleep_record(&db_b, &ctx_b, args()),
    );
    let (id, existing_id) = created_and_duplicate_ids(out_a, out_b);
    assert_eq!(existing_id, id);
    assert_dedup_audits(&setup_db, "add_sleep_record", id).await;
}

#[tokio::test]
async fn add_medication_writes_row_and_audit() {
    let db = fresh_db().await;
    let started_at = time::macros::datetime!(2026-08-05 09:00 +03:00);
    let storage::WriteOutcome::Created { id } = storage::add_medication(
        &db,
        &ctx_valentyna(),
        storage::AddMedication {
            person: health_core::Person::Andrii,
            name: "Metformin".into(),
            dose: Some("500 mg".into()),
            schedule: Some("with breakfast".into()),
            started_at,
            status: health_core::FactStatus::ConfirmedByDoctor,
        },
    )
    .await
    .unwrap() else {
        panic!("expected Created")
    };

    use sea_orm::ConnectionTrait;
    let row = db
        .query_one_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT name, dose, schedule, started_at FROM medications WHERE id = $1",
            [id.into()],
        ))
        .await
        .unwrap()
        .expect("medication row");
    assert_eq!(row.try_get::<String>("", "name").unwrap(), "Metformin");
    assert_eq!(row.try_get::<String>("", "dose").unwrap(), "500 mg");
    assert_eq!(
        row.try_get::<String>("", "schedule").unwrap(),
        "with breakfast"
    );
    assert_eq!(
        row.try_get::<time::OffsetDateTime>("", "started_at")
            .unwrap(),
        started_at
    );
    assert_success_audit(&db, id, "medications", "add_medication").await;
}

#[tokio::test]
async fn stop_medication_updates_row_and_writes_audit() {
    let db = fresh_db().await;
    let storage::WriteOutcome::Created { id } = storage::add_medication(
        &db,
        &ctx_valentyna(),
        storage::AddMedication {
            person: health_core::Person::Andrii,
            name: "Amoxicillin".into(),
            dose: None,
            schedule: None,
            started_at: time::macros::datetime!(2026-08-01 09:00 +03:00),
            status: health_core::FactStatus::ConfirmedByDoctor,
        },
    )
    .await
    .unwrap() else {
        panic!("expected Created")
    };
    let stopped_at = time::macros::datetime!(2026-08-08 09:00 +03:00);
    let out = storage::stop_medication(
        &db,
        &ctx_valentyna(),
        storage::StopMedication {
            person: health_core::Person::Andrii,
            medication_id: id,
            stopped_at,
            reason: Some("Course complete".into()),
        },
    )
    .await
    .unwrap();
    assert_eq!(out, storage::WriteOutcome::Created { id });

    use sea_orm::ConnectionTrait;
    let row = db
        .query_one_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT stopped_at, stop_reason FROM medications WHERE id = $1",
            [id.into()],
        ))
        .await
        .unwrap()
        .expect("stopped medication row");
    assert_eq!(
        row.try_get::<time::OffsetDateTime>("", "stopped_at")
            .unwrap(),
        stopped_at
    );
    assert_eq!(
        row.try_get::<String>("", "stop_reason").unwrap(),
        "Course complete"
    );
    assert_success_audit(&db, id, "medications", "stop_medication").await;
}

#[tokio::test]
async fn stop_medication_rejects_unknown_id() {
    let db = fresh_db().await;
    let id = uuid::Uuid::new_v4();
    let result = storage::stop_medication(
        &db,
        &ctx_valentyna(),
        storage::StopMedication {
            person: health_core::Person::Andrii,
            medication_id: id,
            stopped_at: time::macros::datetime!(2026-08-08 09:00 +03:00),
            reason: None,
        },
    )
    .await;
    assert!(matches!(result, Err(storage::StorageError::NotFound)));

    use sea_orm::ConnectionTrait;
    let audit = db
        .query_one_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT result FROM audit_log \
             WHERE action = 'stop_medication' AND entity_id = $1",
            [id.into()],
        ))
        .await
        .unwrap()
        .expect("rejected audit row");
    assert_eq!(audit.try_get::<String>("", "result").unwrap(), "rejected");
}

#[tokio::test]
async fn stop_medication_rejects_already_stopped_id_without_overwrite() {
    let db = fresh_db().await;
    let storage::WriteOutcome::Created { id } = storage::add_medication(
        &db,
        &ctx_valentyna(),
        storage::AddMedication {
            person: health_core::Person::Andrii,
            name: "Antibiotic".into(),
            dose: None,
            schedule: None,
            started_at: time::macros::datetime!(2026-08-01 09:00 +03:00),
            status: health_core::FactStatus::ConfirmedByDoctor,
        },
    )
    .await
    .unwrap() else {
        panic!("expected Created")
    };
    let first_stopped_at = time::macros::datetime!(2026-08-08 09:00 +03:00);
    storage::stop_medication(
        &db,
        &ctx_valentyna(),
        storage::StopMedication {
            person: health_core::Person::Andrii,
            medication_id: id,
            stopped_at: first_stopped_at,
            reason: Some("First stop".into()),
        },
    )
    .await
    .unwrap();
    let second = storage::stop_medication(
        &db,
        &ctx_valentyna(),
        storage::StopMedication {
            person: health_core::Person::Andrii,
            medication_id: id,
            stopped_at: time::macros::datetime!(2026-08-09 10:00 +03:00),
            reason: Some("Must not overwrite".into()),
        },
    )
    .await;
    assert!(matches!(second, Err(storage::StorageError::NotFound)));

    use sea_orm::ConnectionTrait;
    let row = db
        .query_one_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT m.stopped_at, m.stop_reason,
                    count(a.id) FILTER (WHERE a.result = 'success')::bigint AS successes,
                    count(a.id) FILTER (WHERE a.result = 'rejected')::bigint AS rejected
             FROM medications m
             JOIN audit_log a ON a.entity_id = m.id AND a.action = 'stop_medication'
             WHERE m.id = $1
             GROUP BY m.stopped_at, m.stop_reason",
            [id.into()],
        ))
        .await
        .unwrap()
        .expect("stopped medication and audits");
    assert_eq!(
        row.try_get::<time::OffsetDateTime>("", "stopped_at")
            .unwrap(),
        first_stopped_at
    );
    assert_eq!(
        row.try_get::<String>("", "stop_reason").unwrap(),
        "First stop"
    );
    assert_eq!(row.try_get::<i64>("", "successes").unwrap(), 1);
    assert_eq!(row.try_get::<i64>("", "rejected").unwrap(), 1);
}

#[tokio::test]
async fn stop_medication_rejects_time_before_start_without_mutation() {
    let db = fresh_db().await;
    let started_at = time::macros::datetime!(2026-08-08 09:00 +03:00);
    let storage::WriteOutcome::Created { id } = storage::add_medication(
        &db,
        &ctx_valentyna(),
        storage::AddMedication {
            person: health_core::Person::Andrii,
            name: "Course".into(),
            dose: None,
            schedule: None,
            started_at,
            status: health_core::FactStatus::ConfirmedByDoctor,
        },
    )
    .await
    .unwrap() else {
        panic!("expected Created")
    };

    let error = storage::stop_medication(
        &db,
        &ctx_valentyna(),
        storage::StopMedication {
            person: health_core::Person::Andrii,
            medication_id: id,
            stopped_at: started_at - time::Duration::seconds(1),
            reason: Some("invalid".into()),
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(error, storage::StorageError::Rejected(_)));

    use sea_orm::ConnectionTrait;
    let row = db
        .query_one_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT m.stopped_at, m.stop_reason, a.result
             FROM medications m
             JOIN audit_log a ON a.entity_id = m.id AND a.action = 'stop_medication'
             WHERE m.id = $1",
            [id.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        row.try_get::<Option<time::OffsetDateTime>>("", "stopped_at")
            .unwrap(),
        None
    );
    assert_eq!(
        row.try_get::<Option<String>>("", "stop_reason").unwrap(),
        None
    );
    assert_eq!(row.try_get::<String>("", "result").unwrap(), "rejected");
}

#[tokio::test]
async fn add_condition_writes_row_and_audit() {
    let db = fresh_db().await;
    let diagnosed_at = time::macros::date!(2026 - 07 - 20);
    let storage::WriteOutcome::Created { id } = storage::add_condition(
        &db,
        &ctx_valentyna(),
        storage::AddCondition {
            person: health_core::Person::Andrii,
            name: "Hypertension".into(),
            notes: Some("Monitor at home".into()),
            diagnosed_at: Some(diagnosed_at),
            status: health_core::FactStatus::ConfirmedByDoctor,
        },
    )
    .await
    .unwrap() else {
        panic!("expected Created")
    };

    use sea_orm::ConnectionTrait;
    let row = db
        .query_one_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT name, notes, diagnosed_at FROM conditions WHERE id = $1",
            [id.into()],
        ))
        .await
        .unwrap()
        .expect("condition row");
    assert_eq!(row.try_get::<String>("", "name").unwrap(), "Hypertension");
    assert_eq!(
        row.try_get::<String>("", "notes").unwrap(),
        "Monitor at home"
    );
    assert_eq!(
        row.try_get::<time::Date>("", "diagnosed_at").unwrap(),
        diagnosed_at
    );
    assert_success_audit(&db, id, "conditions", "add_condition").await;
}

#[tokio::test]
async fn add_allergy_writes_row_and_audit() {
    let db = fresh_db().await;
    let storage::WriteOutcome::Created { id } = storage::add_allergy(
        &db,
        &ctx_valentyna(),
        storage::AddAllergy {
            person: health_core::Person::Andrii,
            allergen: "Penicillin".into(),
            reaction: Some("Rash".into()),
            severity: Some("moderate".into()),
            status: health_core::FactStatus::ConfirmedByDoctor,
        },
    )
    .await
    .unwrap() else {
        panic!("expected Created")
    };

    use sea_orm::ConnectionTrait;
    let row = db
        .query_one_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT allergen, reaction, severity FROM allergies WHERE id = $1",
            [id.into()],
        ))
        .await
        .unwrap()
        .expect("allergy row");
    assert_eq!(row.try_get::<String>("", "allergen").unwrap(), "Penicillin");
    assert_eq!(row.try_get::<String>("", "reaction").unwrap(), "Rash");
    assert_eq!(row.try_get::<String>("", "severity").unwrap(), "moderate");
    assert_success_audit(&db, id, "allergies", "add_allergy").await;
}

#[tokio::test]
async fn add_lab_result_writes_row_and_audit() {
    let db = fresh_db().await;
    let test_date = time::macros::date!(2026 - 08 - 03);
    let storage::WriteOutcome::Created { id } = storage::add_lab_result(
        &db,
        &ctx_valentyna(),
        storage::AddLabResult {
            person: health_core::Person::Andrii,
            test_date,
            test_name: "HbA1c".into(),
            value: 6.2,
            unit: Some("%".into()),
            reference_min: Some(4.0),
            reference_max: Some(5.6),
            flag: Some("high".into()),
            laboratory: Some("Lab One".into()),
            source_document: Some("hba1c.pdf".into()),
            status: health_core::FactStatus::ConfirmedByDocument,
        },
    )
    .await
    .unwrap() else {
        panic!("expected Created")
    };

    use sea_orm::ConnectionTrait;
    let row = db
        .query_one_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT test_date, test_name, value::double precision AS value, unit, \
                    reference_min::double precision AS reference_min, \
                    reference_max::double precision AS reference_max, flag, laboratory, source_document \
             FROM labs WHERE id = $1",
            [id.into()],
        ))
        .await
        .unwrap()
        .expect("lab row");
    assert_eq!(
        row.try_get::<time::Date>("", "test_date").unwrap(),
        test_date
    );
    assert_eq!(row.try_get::<String>("", "test_name").unwrap(), "HbA1c");
    assert_eq!(row.try_get::<f64>("", "value").unwrap(), 6.2);
    assert_eq!(row.try_get::<String>("", "unit").unwrap(), "%");
    assert_eq!(row.try_get::<f64>("", "reference_min").unwrap(), 4.0);
    assert_eq!(row.try_get::<f64>("", "reference_max").unwrap(), 5.6);
    assert_eq!(row.try_get::<String>("", "flag").unwrap(), "high");
    assert_eq!(row.try_get::<String>("", "laboratory").unwrap(), "Lab One");
    assert_eq!(
        row.try_get::<String>("", "source_document").unwrap(),
        "hba1c.pdf"
    );
    assert_success_audit(&db, id, "labs", "add_lab_result").await;
}

#[tokio::test]
async fn concurrent_identical_lab_results_create_once_and_audit_duplicate() {
    let setup_db = fresh_db().await;
    let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
    let db_a = sea_orm::Database::connect(&url).await.expect("connect A");
    let db_b = sea_orm::Database::connect(&url).await.expect("connect B");
    let args = || storage::AddLabResult {
        person: health_core::Person::Andrii,
        test_date: time::macros::date!(2026 - 08 - 06),
        test_name: "Glucose".into(),
        value: 5.4,
        unit: Some("mmol/L".into()),
        reference_min: None,
        reference_max: None,
        flag: None,
        laboratory: None,
        source_document: None,
        status: health_core::FactStatus::ConfirmedByDocument,
    };
    let ctx_a = ctx_valentyna();
    let ctx_b = ctx_valentyna();
    let (out_a, out_b) = tokio::join!(
        storage::add_lab_result(&db_a, &ctx_a, args()),
        storage::add_lab_result(&db_b, &ctx_b, args()),
    );
    let (id, existing_id) = created_and_duplicate_ids(out_a, out_b);
    assert_eq!(existing_id, id);
    assert_dedup_audits(&setup_db, "add_lab_result", id).await;
}

#[tokio::test]
async fn correction_preserves_original_value_and_dedup_identity() {
    let db = fresh_db().await;
    let args = || storage::AddMeasurement {
        person: health_core::Person::Andrii,
        kind: health_core::MeasurementKind::Pulse,
        values: serde_json::json!({"value": 93}),
        source: None,
        status: health_core::FactStatus::UserReported,
        event_time: time::macros::datetime!(2026-08-04 14:30 +03:00),
        source_event_id: None,
    };
    let storage::WriteOutcome::Created { id } =
        storage::add_measurement(&db, &ctx_valentyna(), args())
            .await
            .unwrap()
    else {
        panic!("expected Created")
    };

    storage::correct_measurement(
        &db,
        &ctx_valentyna(),
        storage::CorrectMeasurement {
            measurement_id: id,
            new_values: serde_json::json!({"value": 83}),
            reason: "user confirmed from device photo".into(),
        },
    )
    .await
    .unwrap();

    let series = storage::measurement_series(
        &db,
        health_core::Person::Andrii,
        health_core::MeasurementKind::Pulse,
        time::macros::datetime!(2026-08-01 00:00 UTC),
        time::macros::datetime!(2026-08-31 00:00 UTC),
    )
    .await
    .unwrap();
    assert_eq!(series[0].values, serde_json::json!({"value": 83}));

    use sea_orm::ConnectionTrait;
    let row = db
        .query_one_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT c.old_value, c.new_value, c.reason, a.old_value AS audit_old, \
                    a.new_value AS audit_new, a.result \
             FROM corrections c \
             JOIN audit_log a ON a.entity_id = c.entity_id \
               AND a.action = 'correct_measurement' \
             WHERE c.entity_id = $1",
            [id.into()],
        ))
        .await
        .unwrap()
        .expect("correction and audit rows");
    assert_eq!(
        row.try_get::<serde_json::Value>("", "old_value").unwrap(),
        serde_json::json!({"value": 93})
    );
    assert_eq!(
        row.try_get::<serde_json::Value>("", "new_value").unwrap(),
        serde_json::json!({"value": 83})
    );
    assert_eq!(
        row.try_get::<String>("", "reason").unwrap(),
        "user confirmed from device photo"
    );
    assert_eq!(
        row.try_get::<serde_json::Value>("", "audit_old").unwrap(),
        serde_json::json!({"value": 93})
    );
    assert_eq!(
        row.try_get::<serde_json::Value>("", "audit_new").unwrap(),
        serde_json::json!({"value": 83})
    );
    assert_eq!(row.try_get::<String>("", "result").unwrap(), "success");

    let storage::WriteOutcome::Duplicate { existing_id } =
        storage::add_measurement(&db, &ctx_valentyna(), args())
            .await
            .unwrap()
    else {
        panic!("original reading must retain its dedup identity")
    };
    assert_eq!(existing_id, id);
}

#[tokio::test]
async fn correcting_missing_measurement_is_not_found() {
    let db = fresh_db().await;
    let err = storage::correct_measurement(
        &db,
        &ctx_valentyna(),
        storage::CorrectMeasurement {
            measurement_id: uuid::Uuid::new_v4(),
            new_values: serde_json::json!({"value": 1}),
            reason: "x".into(),
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(err, storage::StorageError::NotFound));
}

#[tokio::test]
async fn measurement_series_is_oldest_first_and_excludes_deleted() {
    let db = fresh_db().await;
    let add = |value, event_time| storage::AddMeasurement {
        person: health_core::Person::Andrii,
        kind: health_core::MeasurementKind::Pulse,
        values: serde_json::json!({"value": value}),
        source: None,
        status: health_core::FactStatus::UserReported,
        event_time,
        source_event_id: None,
    };
    let storage::WriteOutcome::Created { id: deleted_id } = storage::add_measurement(
        &db,
        &ctx_valentyna(),
        add(88, time::macros::datetime!(2026-08-04 09:00 UTC)),
    )
    .await
    .unwrap() else {
        panic!("expected Created")
    };
    storage::add_measurement(
        &db,
        &ctx_valentyna(),
        add(80, time::macros::datetime!(2026-08-04 08:00 UTC)),
    )
    .await
    .unwrap();
    storage::add_measurement(
        &db,
        &ctx_valentyna(),
        add(90, time::macros::datetime!(2026-08-04 10:00 UTC)),
    )
    .await
    .unwrap();

    use sea_orm::ConnectionTrait;
    db.execute_raw(sea_orm::Statement::from_sql_and_values(
        sea_orm::DatabaseBackend::Postgres,
        "UPDATE measurements SET deleted_at = now() WHERE id = $1",
        [deleted_id.into()],
    ))
    .await
    .unwrap();

    let series = storage::measurement_series(
        &db,
        health_core::Person::Andrii,
        health_core::MeasurementKind::Pulse,
        time::macros::datetime!(2026-08-04 00:00 UTC),
        time::macros::datetime!(2026-08-05 00:00 UTC),
    )
    .await
    .unwrap();
    assert_eq!(
        series
            .iter()
            .map(|row| row.values["value"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![80, 90]
    );
}

#[tokio::test]
async fn current_medications_excludes_stopped_and_deleted() {
    let db = fresh_db().await;
    let add = |name: &str, started_at| storage::AddMedication {
        person: health_core::Person::Andrii,
        name: name.into(),
        dose: Some("1 tablet".into()),
        schedule: Some("daily".into()),
        started_at,
        status: health_core::FactStatus::UserReported,
    };
    let storage::WriteOutcome::Created { id: stopped_id } = storage::add_medication(
        &db,
        &ctx_valentyna(),
        add("Stopped", time::macros::datetime!(2026-08-01 08:00 UTC)),
    )
    .await
    .unwrap() else {
        panic!("expected Created")
    };
    let storage::WriteOutcome::Created { id: deleted_id } = storage::add_medication(
        &db,
        &ctx_valentyna(),
        add("Deleted", time::macros::datetime!(2026-08-02 08:00 UTC)),
    )
    .await
    .unwrap() else {
        panic!("expected Created")
    };
    storage::add_medication(
        &db,
        &ctx_valentyna(),
        add(
            "Older active",
            time::macros::datetime!(2026-08-03 08:00 UTC),
        ),
    )
    .await
    .unwrap();
    storage::add_medication(
        &db,
        &ctx_valentyna(),
        add(
            "Newest active",
            time::macros::datetime!(2026-08-04 08:00 UTC),
        ),
    )
    .await
    .unwrap();
    storage::stop_medication(
        &db,
        &ctx_valentyna(),
        storage::StopMedication {
            person: health_core::Person::Andrii,
            medication_id: stopped_id,
            stopped_at: time::macros::datetime!(2026-08-05 08:00 UTC),
            reason: None,
        },
    )
    .await
    .unwrap();
    use sea_orm::ConnectionTrait;
    db.execute_raw(sea_orm::Statement::from_sql_and_values(
        sea_orm::DatabaseBackend::Postgres,
        "UPDATE medications SET deleted_at = now() WHERE id = $1",
        [deleted_id.into()],
    ))
    .await
    .unwrap();

    let rows = storage::current_medications(&db, health_core::Person::Andrii)
        .await
        .unwrap();
    assert_eq!(
        rows.iter().map(|row| row.name.as_str()).collect::<Vec<_>>(),
        vec!["Newest active", "Older active"]
    );
}

#[tokio::test]
async fn recent_returns_latest_first_and_excludes_deleted() {
    let db = fresh_db().await;
    let add = |description: &str, event_time| storage::AddMeal {
        person: health_core::Person::Andrii,
        description: description.into(),
        items: None,
        calories: None,
        status: health_core::FactStatus::UserReported,
        event_time,
        source_event_id: None,
    };
    storage::add_meal(
        &db,
        &ctx_valentyna(),
        add("Oldest", time::macros::datetime!(2026-08-01 08:00 UTC)),
    )
    .await
    .unwrap();
    let storage::WriteOutcome::Created { id: deleted_id } = storage::add_meal(
        &db,
        &ctx_valentyna(),
        add("Deleted", time::macros::datetime!(2026-08-02 08:00 UTC)),
    )
    .await
    .unwrap() else {
        panic!("expected Created")
    };
    storage::add_meal(
        &db,
        &ctx_valentyna(),
        add("Latest", time::macros::datetime!(2026-08-03 08:00 UTC)),
    )
    .await
    .unwrap();
    use sea_orm::ConnectionTrait;
    db.execute_raw(sea_orm::Statement::from_sql_and_values(
        sea_orm::DatabaseBackend::Postgres,
        "UPDATE meals SET deleted_at = now() WHERE id = $1",
        [deleted_id.into()],
    ))
    .await
    .unwrap();

    let rows = storage::recent(&db, health_core::Person::Andrii, "meals", 10)
        .await
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].entity, "meals");
    assert_eq!(rows[0].json["description"], "Latest");
    assert_eq!(rows[1].json["description"], "Oldest");
}

#[tokio::test]
async fn recent_rejects_section_outside_allowlist() {
    let db = fresh_db().await;
    let err = storage::recent(&db, health_core::Person::Andrii, "unknown", 10)
        .await
        .unwrap_err();
    assert!(matches!(err, storage::StorageError::Rejected(_)));
}
