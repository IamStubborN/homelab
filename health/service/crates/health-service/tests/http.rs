use std::fs;

use axum::{body::Body, body::to_bytes, http::Request};
use health_service::{auth::TokenMap, config::Config, mcp};
use serde_json::Value;
use tower::ServiceExt;

const ANDRII_TOKEN: &str = "andrii-secret";

fn app() -> axum::Router {
    let dir = tempfile::tempdir().unwrap();
    let andrii = dir.path().join("andrii-token");
    let valentyna = dir.path().join("valentyna-token");
    fs::write(&andrii, ANDRII_TOKEN).unwrap();
    fs::write(&valentyna, "valentyna-secret").unwrap();
    let tokens = TokenMap::load(&Config {
        database_url: "postgres://unused/health".to_owned(),
        listen_addr: "127.0.0.1:8080".parse().unwrap(),
        andrii_token_file: andrii,
        valentyna_token_file: valentyna,
    })
    .unwrap();
    mcp::router(sea_orm::DatabaseConnection::default(), tokens)
}

fn mcp_request(token: Option<&str>, body: &'static str) -> Request<Body> {
    let mut request = Request::post("/internal/mcp")
        .header("host", "localhost:8080")
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream");
    if let Some(token) = token {
        request = request.header("authorization", token);
    }
    request.body(Body::from(body)).unwrap()
}

#[tokio::test]
async fn healthz_is_unauthenticated() {
    let response = app()
        .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    assert_eq!(
        to_bytes(response.into_body(), 16).await.unwrap().as_ref(),
        b"ok"
    );
}

#[tokio::test]
async fn mcp_rejects_missing_malformed_and_invalid_bearers_without_echoing_them() {
    for authorization in [None, Some("Basic secret"), Some("Bearer wrong-secret")] {
        let response = app()
            .oneshot(mcp_request(
                authorization,
                r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), 401);
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        assert!(!String::from_utf8_lossy(&body).contains("secret"));
    }
}

#[tokio::test]
async fn mcp_lists_exactly_the_phase_one_tools() {
    let response = app()
        .oneshot(mcp_request(
            Some(&format!("Bearer {ANDRII_TOKEN}")),
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    let mut names: Vec<&str> = body["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    names.sort_unstable();

    assert_eq!(
        names,
        [
            "add_allergy",
            "add_condition",
            "add_lab_result",
            "add_meal",
            "add_measurement",
            "add_medication",
            "add_sleep_record",
            "add_symptom",
            "correct_measurement",
            "generate_chart",
            "query_health_data",
            "stop_medication",
        ]
    );
}
