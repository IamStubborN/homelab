#!/usr/bin/env python3
"""OpenAI-compatible embeddings proxy for Ollama IPEX.

IPEX ignores encoding_format=base64 and returns a JSON float array. The
OpenAI SDK always requests base64 and then Buffer.from(array, "base64"),
which turns 1024 floats into 256 garbage values. This sidecar calls native
/api/embed and returns little-endian float32 packed as base64.
"""

from __future__ import annotations

import base64
import json
import struct
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OLLAMA_EMBED_URL = "http://ollama-ipex:11434/api/embed"
DEFAULT_MODEL = "bge-m3"
LISTEN = ("0.0.0.0", 8080)


def pack_b64(vec):
    buf = struct.pack("<" + "f" * len(vec), *(float(x) for x in vec))
    return base64.b64encode(buf).decode("ascii")


def ollama_embed(model, inputs):
    payload = json.dumps({"model": model or DEFAULT_MODEL, "input": inputs}).encode()
    req = urllib.request.Request(
        OLLAMA_EMBED_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode())
    return data.get("embeddings")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/health", "/healthz"):
            self._send(200, {"status": "ok"})
            return
        if path in ("/v1/models", "/models"):
            self._send(
                200,
                {
                    "object": "list",
                    "data": [
                        {"id": DEFAULT_MODEL, "object": "model", "owned_by": "ollama"}
                    ],
                },
            )
            return
        self._send(
            404, {"error": {"message": "not found", "type": "invalid_request_error"}}
        )

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path not in ("/v1/embeddings", "/embeddings"):
            self._send(
                404,
                {"error": {"message": "not found", "type": "invalid_request_error"}},
            )
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            req = json.loads(raw.decode() or "{}")
        except json.JSONDecodeError:
            self._send(
                400,
                {"error": {"message": "invalid json", "type": "invalid_request_error"}},
            )
            return
        model = req.get("model") or DEFAULT_MODEL
        inp = req.get("input", "")
        if isinstance(inp, str):
            inputs = [inp]
        elif isinstance(inp, list):
            inputs = inp
        else:
            self._send(
                400,
                {
                    "error": {
                        "message": "input must be string or array",
                        "type": "invalid_request_error",
                    }
                },
            )
            return
        try:
            embeddings = ollama_embed(model, inputs)
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")[:500]
            self._send(
                502,
                {
                    "error": {
                        "message": "ollama http %s: %s" % (e.code, body),
                        "type": "server_error",
                    }
                },
            )
            return
        except Exception as e:
            self._send(
                502, {"error": {"message": "ollama: %s" % e, "type": "server_error"}}
            )
            return
        if not embeddings:
            self._send(
                502,
                {
                    "error": {
                        "message": "ollama returned no embeddings",
                        "type": "server_error",
                    }
                },
            )
            return
        if embeddings and isinstance(embeddings[0], (int, float)):
            embeddings = [embeddings]
        data = [
            {"object": "embedding", "index": i, "embedding": pack_b64(vec)}
            for i, vec in enumerate(embeddings)
        ]
        self._send(
            200,
            {
                "object": "list",
                "data": data,
                "model": model,
                "usage": {"prompt_tokens": 0, "total_tokens": 0},
            },
        )


if __name__ == "__main__":
    httpd = ThreadingHTTPServer(LISTEN, Handler)
    print(
        "embed-proxy listening on %s:%s -> %s"
        % (LISTEN[0], LISTEN[1], OLLAMA_EMBED_URL),
        flush=True,
    )
    httpd.serve_forever()
