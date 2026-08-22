from __future__ import annotations

import base64
import json
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

from mcp.server import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from mcp_types import CallToolResult, ImageContent, TextContent
from pydantic import ConfigDict, Field, create_model
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import PlainTextResponse, Response
from starlette.routing import Mount, Route

from health_mcp.auth import BearerAuthMiddleware, TokenMap, current_identity
from health_mcp.store import WikiStore
from health_mcp.types import SOURCE_EVENT_ID_DESCRIPTION, CashierError

DEFAULT_LISTEN_ADDR = "0.0.0.0:8080"
DEFAULT_WIKI_ROOT = "/wiki/shared/health"


def listen_bind() -> tuple[str, int]:
    raw = os.environ.get("HEALTH_LISTEN_ADDR", DEFAULT_LISTEN_ADDR)
    host, separator, port = raw.rpartition(":")
    if not separator or not host:
        raise SystemExit(f"invalid HEALTH_LISTEN_ADDR: {raw}")
    try:
        return host, int(port)
    except ValueError as exc:
        raise SystemExit(f"invalid HEALTH_LISTEN_ADDR: {raw}") from exc
SOURCE_EVENT_ID = Annotated[
    str | None,
    Field(default=None, description=SOURCE_EVENT_ID_DESCRIPTION),
]

mcp = MCPServer("health")
_store: WikiStore | None = None


def store() -> WikiStore:
    if _store is None:
        raise CashierError("wiki store is not configured")
    return _store


def _ok(payload: dict[str, Any]) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text=json.dumps(payload, ensure_ascii=False))],
        structured_content=payload,
    )


def _err(message: str) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=message)], is_error=True)


def _call(fn: Any, **kwargs: Any) -> CallToolResult:
    try:
        result = fn(current_identity(), **kwargs)
    except CashierError as exc:
        return _err(str(exc))
    if hasattr(result, "as_dict"):
        return _ok(result.as_dict())
    if isinstance(result, list):
        return _ok({"rows": result})
    if isinstance(result, bytes | bytearray):
        return CallToolResult(
            content=[
                ImageContent(
                    type="image",
                    data=base64.b64encode(bytes(result)).decode("ascii"),
                    mime_type="image/png",
                )
            ]
        )
    return _ok(result)


@mcp.tool(description="Record a typed health measurement.")
async def add_measurement(
    kind: str,
    values: dict[str, Any],
    person: str | None = None,
    source: str | None = None,
    status: str | None = None,
    event_time: str | None = None,
    source_event_id: SOURCE_EVENT_ID = None,
) -> CallToolResult:
    return _call(
        store().add_measurement,
        kind=kind,
        values=values,
        person=person,
        source=source,
        status=status,
        event_time=event_time,
        source_event_id=source_event_id,
    )


@mcp.tool(description="Correct a measurement after explicit user confirmation.")
async def correct_measurement(
    measurement_id: str,
    new_values: dict[str, Any],
    reason: str,
    confirmed: bool | None = None,
) -> CallToolResult:
    return _call(
        store().correct_measurement,
        measurement_id=measurement_id,
        new_values=new_values,
        reason=reason,
        confirmed=confirmed,
    )


@mcp.tool(description="Record a meal.")
async def add_meal(
    description: str,
    person: str | None = None,
    items: dict[str, Any] | list[Any] | None = None,
    calories: int | None = None,
    status: str | None = None,
    event_time: str | None = None,
    source_event_id: SOURCE_EVENT_ID = None,
) -> CallToolResult:
    return _call(
        store().add_meal,
        description=description,
        person=person,
        items=items,
        calories=calories,
        status=status,
        event_time=event_time,
        source_event_id=source_event_id,
    )


@mcp.tool(description="Record a symptom.")
async def add_symptom(
    description: str,
    person: str | None = None,
    severity: int | None = None,
    status: str | None = None,
    event_time: str | None = None,
    source_event_id: SOURCE_EVENT_ID = None,
) -> CallToolResult:
    return _call(
        store().add_symptom,
        description=description,
        person=person,
        severity=severity,
        status=status,
        event_time=event_time,
        source_event_id=source_event_id,
    )


@mcp.tool(description="Record a sleep interval.")
async def add_sleep_record(
    start_time: str,
    end_time: str,
    person: str | None = None,
    quality: int | None = None,
    notes: str | None = None,
    status: str | None = None,
    source_event_id: SOURCE_EVENT_ID = None,
) -> CallToolResult:
    return _call(
        store().add_sleep_record,
        start_time=start_time,
        end_time=end_time,
        person=person,
        quality=quality,
        notes=notes,
        status=status,
        source_event_id=source_event_id,
    )


@mcp.tool(description="Add a medication after explicit user confirmation.")
async def add_medication(
    name: str,
    person: str | None = None,
    dose: str | None = None,
    schedule: str | None = None,
    started_at: str | None = None,
    status: str | None = None,
    confirmed: bool | None = None,
) -> CallToolResult:
    return _call(
        store().add_medication,
        name=name,
        person=person,
        dose=dose,
        schedule=schedule,
        started_at=started_at,
        status=status,
        confirmed=confirmed,
    )


@mcp.tool(description="Stop a medication after explicit user confirmation.")
async def stop_medication(
    medication_id: str,
    person: str | None = None,
    stopped_at: str | None = None,
    reason: str | None = None,
    confirmed: bool | None = None,
) -> CallToolResult:
    return _call(
        store().stop_medication,
        medication_id=medication_id,
        person=person,
        stopped_at=stopped_at,
        reason=reason,
        confirmed=confirmed,
    )


@mcp.tool(description="Record a health condition.")
async def add_condition(
    name: str,
    person: str | None = None,
    notes: str | None = None,
    diagnosed_at: str | None = None,
    status: str | None = None,
    confirmed: bool | None = None,
) -> CallToolResult:
    return _call(
        store().add_condition,
        name=name,
        person=person,
        notes=notes,
        diagnosed_at=diagnosed_at,
        status=status,
        confirmed=confirmed,
    )


@mcp.tool(description="Record an allergy.")
async def add_allergy(
    allergen: str,
    person: str | None = None,
    reaction: str | None = None,
    severity: str | None = None,
    status: str | None = None,
) -> CallToolResult:
    return _call(
        store().add_allergy,
        allergen=allergen,
        person=person,
        reaction=reaction,
        severity=severity,
        status=status,
    )


@mcp.tool(description="Record a laboratory result.")
async def add_lab_result(
    test_date: str,
    test_name: str,
    value: float,
    person: str | None = None,
    unit: str | None = None,
    reference_min: float | None = None,
    reference_max: float | None = None,
    flag: str | None = None,
    laboratory: str | None = None,
    source_document: str | None = None,
    status: str | None = None,
) -> CallToolResult:
    return _call(
        store().add_lab_result,
        test_date=test_date,
        test_name=test_name,
        value=value,
        person=person,
        unit=unit,
        reference_min=reference_min,
        reference_max=reference_max,
        flag=flag,
        laboratory=laboratory,
        source_document=source_document,
        status=status,
    )


@mcp.tool(description="Query recent health rows or a measurement series.")
async def query_health_data(
    section: str,
    person: str | None = None,
    limit: int | None = None,
    from_time: str | None = None,
    to_time: str | None = None,
) -> CallToolResult:
    return _call(
        store().query,
        section=section,
        person=person,
        limit=limit,
        from_time=from_time,
        to_time=to_time,
    )


@mcp.tool(description="Render a measurement series as a PNG chart.")
async def generate_chart(
    kind: str,
    person: str | None = None,
    days: int | None = None,
    title: str | None = None,
) -> CallToolResult:
    return _call(
        store().generate_chart,
        kind=kind,
        person=person,
        days=days,
        title=title,
    )


def _forbid_unknown_fields() -> None:
    from mcp.server.mcpserver.utilities.func_metadata import ArgModelBase

    for tool in mcp._tool_manager.list_tools():
        old = tool.fn_metadata.arg_model
        new = create_model(
            old.__name__,
            __base__=(old, ArgModelBase),
            __config__=ConfigDict(extra="forbid", arbitrary_types_allowed=True),
        )
        tool.fn_metadata.arg_model = new
        schema = new.model_json_schema(by_alias=True)
        schema["additionalProperties"] = False
        tool.parameters = schema
    _alias_query_range_fields()


def _alias_query_range_fields() -> None:
    tool = mcp._tool_manager.get_tool("query_health_data")
    if tool is None:
        return
    properties = tool.parameters.setdefault("properties", {})
    if "from_time" in properties:
        properties["from"] = properties.pop("from_time")
    if "to_time" in properties:
        properties["to"] = properties.pop("to_time")
    original_run = tool.run

    async def run(
        arguments: dict[str, Any],
        context: Any,
        convert_result: bool = False,
    ) -> Any:
        remapped = dict(arguments)
        if "from" in remapped and "from_time" not in remapped:
            remapped["from_time"] = remapped.pop("from")
        if "to" in remapped and "to_time" not in remapped:
            remapped["to_time"] = remapped.pop("to")
        return await original_run(remapped, context, convert_result=convert_result)

    object.__setattr__(tool, "run", run)


_forbid_unknown_fields()


async def healthz(_request: Request) -> Response:
    return PlainTextResponse("ok")


def build_app(
    tokens: TokenMap | None = None,
    wiki_root: Path | str | None = None,
    extra_hosts: list[str] | None = None,
) -> Starlette:
    global _store
    tokens = tokens or TokenMap.from_env()
    root = Path(wiki_root or os.environ.get("WIKI_HEALTH_ROOT", DEFAULT_WIKI_ROOT))
    _store = WikiStore(root)
    allowed_hosts = [
        "health-service",
        "health-service:*",
        "localhost",
        "localhost:*",
        "127.0.0.1",
        "127.0.0.1:*",
    ]
    if extra_hosts:
        allowed_hosts.extend(extra_hosts)
    security = TransportSecuritySettings(allowed_hosts=allowed_hosts)
    mcp_app = mcp.streamable_http_app(
        streamable_http_path="/mcp",
        json_response=True,
        transport_security=security,
        host="0.0.0.0",
    )

    @asynccontextmanager
    async def lifespan(_app: Starlette) -> AsyncIterator[None]:
        async with mcp.session_manager.run():
            yield

    return Starlette(
        routes=[
            Route("/healthz", healthz, methods=["GET"]),
            Mount(
                "/internal",
                app=mcp_app,
                middleware=[Middleware(BearerAuthMiddleware, tokens=tokens)],
            ),
        ],
        lifespan=lifespan,
    )


app = build_app() if os.environ.get("HEALTH_TOKEN_FILE_ANDRII") else None


if __name__ == "__main__":
    import uvicorn

    host, port = listen_bind()
    uvicorn.run("health_mcp.server:app", host=host, port=port, factory=False)
