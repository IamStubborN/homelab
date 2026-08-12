use std::{str::FromStr, sync::Arc};

use axum::{
    Router,
    extract::{Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use health_core::RequestCtx;
use rmcp::{
    ServerHandler,
    handler::server::{tool::Extension, wrapper::Parameters},
    model::{CallToolResult, ContentBlock, ErrorData},
    schemars, tool, tool_handler, tool_router,
    transport::{StreamableHttpServerConfig, StreamableHttpService},
};
use sea_orm::DatabaseConnection;
use serde::Deserialize;
use time::{Date, OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{auth::TokenMap, ops, storage};

#[derive(Clone)]
pub struct HealthMcp {
    db: DatabaseConnection,
    tokens: Arc<TokenMap>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct AddMeasurementInput {
    person: Option<String>,
    kind: String,
    values: serde_json::Value,
    source: Option<String>,
    status: Option<String>,
    event_time: Option<String>,
    /// Stable transport source identity plus a deterministic per-fact ordinal.
    source_event_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct CorrectMeasurementInput {
    measurement_id: String,
    new_values: serde_json::Value,
    reason: String,
    confirmed: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct AddMealInput {
    person: Option<String>,
    description: String,
    items: Option<serde_json::Value>,
    calories: Option<i32>,
    status: Option<String>,
    event_time: Option<String>,
    /// Stable transport source identity plus a deterministic per-fact ordinal.
    source_event_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct AddSymptomInput {
    person: Option<String>,
    description: String,
    severity: Option<i32>,
    status: Option<String>,
    event_time: Option<String>,
    /// Stable transport source identity plus a deterministic per-fact ordinal.
    source_event_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct AddSleepRecordInput {
    person: Option<String>,
    start_time: String,
    end_time: String,
    quality: Option<i32>,
    notes: Option<String>,
    status: Option<String>,
    /// Stable transport source identity plus a deterministic per-fact ordinal.
    source_event_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct AddMedicationInput {
    person: Option<String>,
    name: String,
    dose: Option<String>,
    schedule: Option<String>,
    started_at: Option<String>,
    status: Option<String>,
    confirmed: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct StopMedicationInput {
    person: Option<String>,
    medication_id: String,
    stopped_at: Option<String>,
    reason: Option<String>,
    confirmed: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct AddConditionInput {
    person: Option<String>,
    name: String,
    notes: Option<String>,
    diagnosed_at: Option<String>,
    status: Option<String>,
    confirmed: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct AddAllergyInput {
    person: Option<String>,
    allergen: String,
    reaction: Option<String>,
    severity: Option<String>,
    status: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct AddLabResultInput {
    person: Option<String>,
    test_date: String,
    test_name: String,
    value: f64,
    unit: Option<String>,
    reference_min: Option<f64>,
    reference_max: Option<f64>,
    flag: Option<String>,
    laboratory: Option<String>,
    source_document: Option<String>,
    status: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct QueryHealthDataInput {
    person: Option<String>,
    section: String,
    limit: Option<u32>,
    from: Option<String>,
    to: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct GenerateChartInput {
    person: Option<String>,
    kind: String,
    days: Option<u32>,
    title: Option<String>,
}

#[tool_router]
impl HealthMcp {
    fn new(db: DatabaseConnection, tokens: Arc<TokenMap>) -> Self {
        Self { db, tokens }
    }

    #[tool(description = "Record a typed health measurement.")]
    async fn add_measurement(
        &self,
        Parameters(input): Parameters<AddMeasurementInput>,
        Extension(parts): Extension<axum::http::request::Parts>,
    ) -> Result<CallToolResult, ErrorData> {
        let params = ops::AddMeasurementParams {
            person: parse_optional(&input.person, "person")?,
            kind: parse(&input.kind, "kind")?,
            values: input.values,
            source: input.source,
            status: parse_optional(&input.status, "status")?,
            event_time: parse_optional_time(&input.event_time, "event_time")?,
            source_event_id: input.source_event_id,
        };
        tool_outcome(ops::add_measurement(&self.db, request_ctx(&parts)?, params).await)
    }

    #[tool(description = "Correct a measurement after explicit user confirmation.")]
    async fn correct_measurement(
        &self,
        Parameters(input): Parameters<CorrectMeasurementInput>,
        Extension(parts): Extension<axum::http::request::Parts>,
    ) -> Result<CallToolResult, ErrorData> {
        let measurement_id = parse_uuid(&input.measurement_id, "measurement_id")?;
        let result = ops::correct_measurement(
            &self.db,
            request_ctx(&parts)?,
            ops::CorrectMeasurementParams {
                measurement_id,
                new_values: input.new_values,
                reason: input.reason,
                confirmed: input.confirmed,
            },
        )
        .await;
        match result {
            Ok(()) => Ok(CallToolResult::structured(
                serde_json::json!({"outcome": "updated", "id": measurement_id}),
            )),
            Err(error) => Ok(tool_error(error)),
        }
    }

    #[tool(description = "Record a meal.")]
    async fn add_meal(
        &self,
        Parameters(input): Parameters<AddMealInput>,
        Extension(parts): Extension<axum::http::request::Parts>,
    ) -> Result<CallToolResult, ErrorData> {
        let params = ops::AddMealParams {
            person: parse_optional(&input.person, "person")?,
            description: input.description,
            items: input.items,
            calories: input.calories,
            status: parse_optional(&input.status, "status")?,
            event_time: parse_optional_time(&input.event_time, "event_time")?,
            source_event_id: input.source_event_id,
        };
        tool_outcome(ops::add_meal(&self.db, request_ctx(&parts)?, params).await)
    }

    #[tool(description = "Record a symptom.")]
    async fn add_symptom(
        &self,
        Parameters(input): Parameters<AddSymptomInput>,
        Extension(parts): Extension<axum::http::request::Parts>,
    ) -> Result<CallToolResult, ErrorData> {
        let params = ops::AddSymptomParams {
            person: parse_optional(&input.person, "person")?,
            description: input.description,
            severity: input.severity,
            status: parse_optional(&input.status, "status")?,
            event_time: parse_optional_time(&input.event_time, "event_time")?,
            source_event_id: input.source_event_id,
        };
        tool_outcome(ops::add_symptom(&self.db, request_ctx(&parts)?, params).await)
    }

    #[tool(description = "Record a sleep interval.")]
    async fn add_sleep_record(
        &self,
        Parameters(input): Parameters<AddSleepRecordInput>,
        Extension(parts): Extension<axum::http::request::Parts>,
    ) -> Result<CallToolResult, ErrorData> {
        let params = ops::AddSleepRecordParams {
            person: parse_optional(&input.person, "person")?,
            start_time: parse_time(&input.start_time, "start_time")?,
            end_time: parse_time(&input.end_time, "end_time")?,
            quality: input.quality,
            notes: input.notes,
            status: parse_optional(&input.status, "status")?,
            source_event_id: input.source_event_id,
        };
        tool_outcome(ops::add_sleep_record(&self.db, request_ctx(&parts)?, params).await)
    }

    #[tool(description = "Add a medication after explicit user confirmation.")]
    async fn add_medication(
        &self,
        Parameters(input): Parameters<AddMedicationInput>,
        Extension(parts): Extension<axum::http::request::Parts>,
    ) -> Result<CallToolResult, ErrorData> {
        let params = ops::AddMedicationParams {
            person: parse_optional(&input.person, "person")?,
            name: input.name,
            dose: input.dose,
            schedule: input.schedule,
            started_at: parse_optional_time(&input.started_at, "started_at")?,
            status: parse_optional(&input.status, "status")?,
            confirmed: input.confirmed,
        };
        tool_outcome(ops::add_medication(&self.db, request_ctx(&parts)?, params).await)
    }

    #[tool(description = "Stop a medication after explicit user confirmation.")]
    async fn stop_medication(
        &self,
        Parameters(input): Parameters<StopMedicationInput>,
        Extension(parts): Extension<axum::http::request::Parts>,
    ) -> Result<CallToolResult, ErrorData> {
        let params = ops::StopMedicationParams {
            person: parse_optional(&input.person, "person")?,
            medication_id: parse_uuid(&input.medication_id, "medication_id")?,
            stopped_at: parse_optional_time(&input.stopped_at, "stopped_at")?,
            reason: input.reason,
            confirmed: input.confirmed,
        };
        tool_updated(ops::stop_medication(&self.db, request_ctx(&parts)?, params).await)
    }

    #[tool(description = "Record a health condition.")]
    async fn add_condition(
        &self,
        Parameters(input): Parameters<AddConditionInput>,
        Extension(parts): Extension<axum::http::request::Parts>,
    ) -> Result<CallToolResult, ErrorData> {
        let params = ops::AddConditionParams {
            person: parse_optional(&input.person, "person")?,
            name: input.name,
            notes: input.notes,
            diagnosed_at: parse_optional_date(&input.diagnosed_at, "diagnosed_at")?,
            status: parse_optional(&input.status, "status")?,
            confirmed: input.confirmed,
        };
        tool_outcome(ops::add_condition(&self.db, request_ctx(&parts)?, params).await)
    }

    #[tool(description = "Record an allergy.")]
    async fn add_allergy(
        &self,
        Parameters(input): Parameters<AddAllergyInput>,
        Extension(parts): Extension<axum::http::request::Parts>,
    ) -> Result<CallToolResult, ErrorData> {
        let params = ops::AddAllergyParams {
            person: parse_optional(&input.person, "person")?,
            allergen: input.allergen,
            reaction: input.reaction,
            severity: input.severity,
            status: parse_optional(&input.status, "status")?,
        };
        tool_outcome(ops::add_allergy(&self.db, request_ctx(&parts)?, params).await)
    }

    #[tool(description = "Record a laboratory result.")]
    async fn add_lab_result(
        &self,
        Parameters(input): Parameters<AddLabResultInput>,
        Extension(parts): Extension<axum::http::request::Parts>,
    ) -> Result<CallToolResult, ErrorData> {
        let params = ops::AddLabResultParams {
            person: parse_optional(&input.person, "person")?,
            test_date: parse_date(&input.test_date, "test_date")?,
            test_name: input.test_name,
            value: input.value,
            unit: input.unit,
            reference_min: input.reference_min,
            reference_max: input.reference_max,
            flag: input.flag,
            laboratory: input.laboratory,
            source_document: input.source_document,
            status: parse_optional(&input.status, "status")?,
        };
        tool_outcome(ops::add_lab_result(&self.db, request_ctx(&parts)?, params).await)
    }

    #[tool(description = "Query recent health rows or a measurement series.")]
    async fn query_health_data(
        &self,
        Parameters(input): Parameters<QueryHealthDataInput>,
        Extension(parts): Extension<axum::http::request::Parts>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = ops::query_health_data(
            &self.db,
            request_ctx(&parts)?,
            ops::QueryHealthDataParams {
                person: parse_optional(&input.person, "person")?,
                section: input.section,
                limit: input.limit,
                from: parse_optional_time(&input.from, "from")?,
                to: parse_optional_time(&input.to, "to")?,
            },
        )
        .await;
        match result {
            Ok(rows) => Ok(CallToolResult::structured(
                serde_json::json!({"rows": rows}),
            )),
            Err(error) => Ok(tool_error(error)),
        }
    }

    #[tool(description = "Render a measurement series as a PNG chart.")]
    async fn generate_chart(
        &self,
        Parameters(input): Parameters<GenerateChartInput>,
        Extension(parts): Extension<axum::http::request::Parts>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = ops::generate_chart(
            &self.db,
            request_ctx(&parts)?,
            ops::GenerateChartParams {
                person: parse_optional(&input.person, "person")?,
                kind: parse(&input.kind, "kind")?,
                days: input.days,
                title: input.title,
            },
        )
        .await;
        match result {
            Ok(png) => Ok(CallToolResult::success(vec![ContentBlock::image(
                STANDARD.encode(png),
                "image/png",
            )])),
            Err(error) => Ok(tool_error(error)),
        }
    }
}

#[tool_handler(router = Self::tool_router())]
impl ServerHandler for HealthMcp {}

pub fn router(
    db: DatabaseConnection,
    tokens: TokenMap,
    listen_addr: std::net::SocketAddr,
) -> Router {
    let state = HealthMcp::new(db, Arc::new(tokens));
    let protected = mcp_routes(state.clone(), listen_addr)
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate));
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .merge(protected)
}

fn mcp_routes(state: HealthMcp, listen_addr: std::net::SocketAddr) -> Router {
    let session_manager = Arc::new(
        rmcp::transport::streamable_http_server::session::local::LocalSessionManager::default(),
    );
    let port = listen_addr.port();
    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_allowed_hosts([
            "health-service".to_owned(),
            format!("health-service:{port}"),
            "localhost".to_owned(),
            format!("localhost:{port}"),
            "127.0.0.1".to_owned(),
            format!("127.0.0.1:{port}"),
        ])
        .with_json_response(true);
    let factory = state.clone();
    let service = StreamableHttpService::new(move || Ok(factory.clone()), session_manager, config);
    Router::new().route_service("/internal/mcp", service)
}

async fn authenticate(
    State(state): State<HealthMcp>,
    mut request: Request,
    next: Next,
) -> Response {
    let Some(token) = bearer_token(&request) else {
        return unauthorized();
    };
    let Some(ctx) = state.tokens.resolve(token) else {
        return unauthorized();
    };
    request.extensions_mut().insert(Arc::new(ctx));
    next.run(request).await
}

fn bearer_token(request: &Request) -> Option<&str> {
    let mut values = request.headers().get_all(header::AUTHORIZATION).iter();
    let value = values.next()?.as_bytes();
    if values.next().is_some() {
        return None;
    }
    let separator = value.iter().position(|byte| *byte == b' ')?;
    let (scheme, token_with_space) = value.split_at(separator);
    let token = &token_with_space[1..];
    if !scheme.eq_ignore_ascii_case(b"bearer") || !crate::auth::is_supported_bearer_token(token) {
        return None;
    }
    std::str::from_utf8(token).ok()
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
}

fn request_ctx(parts: &axum::http::request::Parts) -> Result<&RequestCtx, ErrorData> {
    parts
        .extensions
        .get::<Arc<RequestCtx>>()
        .map(AsRef::as_ref)
        .ok_or_else(|| {
            ErrorData::internal_error("authenticated request context is unavailable", None)
        })
}

fn parse<T: FromStr>(value: &str, field: &'static str) -> Result<T, ErrorData> {
    T::from_str(value)
        .map_err(|_| ErrorData::invalid_params(format!("invalid {field}: {value}"), None))
}

fn parse_optional<T: FromStr>(
    value: &Option<String>,
    field: &'static str,
) -> Result<Option<T>, ErrorData> {
    value
        .as_deref()
        .map(|value| parse(value, field))
        .transpose()
}

fn parse_uuid(value: &str, field: &'static str) -> Result<Uuid, ErrorData> {
    parse(value, field)
}

fn parse_time(value: &str, field: &'static str) -> Result<OffsetDateTime, ErrorData> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|_| ErrorData::invalid_params(format!("invalid {field}: {value}"), None))
}

fn parse_optional_time(
    value: &Option<String>,
    field: &'static str,
) -> Result<Option<OffsetDateTime>, ErrorData> {
    value
        .as_deref()
        .map(|value| parse_time(value, field))
        .transpose()
}

fn parse_date(value: &str, field: &'static str) -> Result<Date, ErrorData> {
    Date::parse(
        value,
        time::macros::format_description!("[year]-[month]-[day]"),
    )
    .map_err(|_| ErrorData::invalid_params(format!("invalid {field}: {value}"), None))
}

fn parse_optional_date(
    value: &Option<String>,
    field: &'static str,
) -> Result<Option<Date>, ErrorData> {
    value
        .as_deref()
        .map(|value| parse_date(value, field))
        .transpose()
}

fn tool_outcome(
    result: Result<storage::WriteOutcome, ops::OpsError>,
) -> Result<CallToolResult, ErrorData> {
    match result {
        Ok(storage::WriteOutcome::Created { id }) => Ok(CallToolResult::structured(
            serde_json::json!({"outcome": "created", "id": id}),
        )),
        Ok(storage::WriteOutcome::Duplicate { existing_id }) => Ok(CallToolResult::structured(
            serde_json::json!({"outcome": "duplicate", "existing_id": existing_id}),
        )),
        Err(error) => Ok(tool_error(error)),
    }
}

fn tool_updated(
    result: Result<storage::WriteOutcome, ops::OpsError>,
) -> Result<CallToolResult, ErrorData> {
    match result {
        Ok(storage::WriteOutcome::Created { id }) => Ok(CallToolResult::structured(
            serde_json::json!({"outcome": "updated", "id": id}),
        )),
        Ok(storage::WriteOutcome::Duplicate { existing_id }) => Ok(CallToolResult::structured(
            serde_json::json!({"outcome": "duplicate", "existing_id": existing_id}),
        )),
        Err(error) => Ok(tool_error(error)),
    }
}

fn tool_error(error: ops::OpsError) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(error.to_string())])
}
