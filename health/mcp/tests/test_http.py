from __future__ import annotations

import json
from pathlib import Path

from starlette.testclient import TestClient

from health_mcp.auth import TokenMap
from health_mcp.server import build_app
from tests.conftest import PRIMARY_TOKEN, SECONDARY_TOKEN

MCP_HEADERS = {
    "content-type": "application/json",
    "accept": "application/json, text/event-stream",
}


def _client(wiki_root: Path) -> TestClient:
    app = build_app(
        tokens=TokenMap(PRIMARY_TOKEN, SECONDARY_TOKEN),
        wiki_root=wiki_root,
        extra_hosts=["testserver", "testserver:*"],
    )
    return TestClient(app)


def _mcp(
    client: TestClient,
    body: dict,
    token: str | None = PRIMARY_TOKEN,
    session_id: str | None = None,
) -> tuple[int, dict | str, str | None]:
    headers = dict(MCP_HEADERS)
    if token is not None:
        headers["authorization"] = f"Bearer {token}"
    if session_id:
        headers["mcp-session-id"] = session_id
    response = client.post("/internal/mcp", headers=headers, content=json.dumps(body))
    sid = response.headers.get("mcp-session-id") or session_id
    try:
        return response.status_code, response.json(), sid
    except Exception:
        return response.status_code, response.text, sid


def test_healthz_is_unauthenticated(wiki_root: Path) -> None:
    with _client(wiki_root) as client:
        response = client.get("/healthz")
        assert response.status_code == 200
        assert response.text == "ok"


def test_mcp_rejects_missing_and_invalid_bearers_without_echoing_them(wiki_root: Path) -> None:
    with _client(wiki_root) as client:
        for authorization in (None, "Basic secret", "Bearer wrong-secret"):
            headers = dict(MCP_HEADERS)
            if authorization is not None:
                headers["authorization"] = authorization
            response = client.post(
                "/internal/mcp",
                headers=headers,
                content='{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
            )
            assert response.status_code == 401
            assert "secret" not in response.text
            assert response.text == "unauthorized"


def test_tools_list_names_and_additional_properties(wiki_root: Path) -> None:
    with _client(wiki_root) as client:
        session_id = _initialize(client)
        status, body, _sid = _mcp(
            client, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, session_id=session_id
        )
        assert status == 200
        assert isinstance(body, dict)
        tools = body["result"]["tools"]
        names = sorted(tool["name"] for tool in tools)
        assert names == [
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
        for tool in tools:
            assert tool["inputSchema"]["additionalProperties"] is False, tool["name"]
        for name in ("add_measurement", "add_meal", "add_symptom", "add_sleep_record"):
            tool = next(item for item in tools if item["name"] == name)
            assert (
                tool["inputSchema"]["properties"]["source_event_id"]["description"]
                == "Stable transport source identity plus a deterministic per-fact ordinal."
            )


def _initialize(client: TestClient) -> str:
    status, body, session_id = _mcp(
        client,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "pytest", "version": "0"},
            },
        },
    )
    assert status == 200
    assert isinstance(body, dict)
    assert session_id
    return session_id


def test_unknown_field_is_tool_error_and_writes_nothing(wiki_root: Path) -> None:
    with _client(wiki_root) as client:
        session_id = _initialize(client)
        status, body, _sid = _mcp(
            client,
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "add_measurement",
                    "arguments": {
                        "kind": "weight",
                        "values": {"value": 80},
                        "person_id": "primary",
                    },
                },
            },
            session_id=session_id,
        )
        assert status == 200
        assert isinstance(body, dict)
        result = body["result"]
        assert result.get("isError") is True
        assert not (wiki_root / "data" / "primary" / "measurements.jsonl").exists()


def test_add_measurement_round_trip_over_http(wiki_root: Path) -> None:
    with _client(wiki_root) as client:
        session_id = _initialize(client)
        status, body, _sid = _mcp(
            client,
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "add_measurement",
                    "arguments": {
                        "kind": "weight",
                        "values": {"value": 80, "unit": "kg"},
                        "event_time": "2026-08-04T14:30:00+03:00",
                    },
                },
            },
            session_id=session_id,
        )
        assert status == 200
        assert isinstance(body, dict)
        structured = body["result"].get("structuredContent") or body["result"].get(
            "structured_content"
        )
        assert structured["outcome"] == "created"
        assert (wiki_root / "generated" / "PRIMARY_RECENT_MEASUREMENTS.md").is_file()
        assert "80" in (wiki_root / "generated" / "PRIMARY_RECENT_MEASUREMENTS.md").read_text(
            encoding="utf-8"
        )


def test_medication_source_identity_is_idempotent_over_http(wiki_root: Path) -> None:
    with _client(wiki_root) as client:
        session_id = _initialize(client)
        results = []
        for request_id in (2, 3):
            status, body, _sid = _mcp(client, {
                'jsonrpc': '2.0', 'id': request_id, 'method': 'tools/call',
                'params': {'name': 'add_medication', 'arguments': {
                    'name': 'synthetic-med-a', 'confirmed': True,
                    'source_event_id': 'test:http:medication:1',
                }},
            }, session_id=session_id)
            assert status == 200
            assert not body['result'].get('isError')
            results.append(body['result']['structuredContent'])
        assert results[0]['outcome'] == 'created'
        assert results[1] == {'outcome': 'duplicate', 'existing_id': results[0]['id']}
