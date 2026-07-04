#!/usr/bin/env python3
import json
import socket
import sys
import time

PORT = 5555
TIMEOUT = 5


def send_command(ip: str, cmd: int, msg: dict) -> dict:
    sn = str(int(time.time() * 1000))
    payload = {"cmd": cmd, "pv": 0, "sn": sn, "msg": msg}
    data = (json.dumps(payload, separators=(",", ":")) + "\r\n").encode()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(TIMEOUT)
        sock.connect((ip, PORT))
        sock.sendall(data)
        deadline = time.time() + TIMEOUT
        buffer = b""
        while time.time() < deadline:
            raw = sock.recv(4096)
            if not raw:
                break
            buffer += raw
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                line = line.strip()
                if not line:
                    continue
                response = json.loads(line)
                if response.get("sn") == sn:
                    return response.get("msg", {}).get("data", {})
    return {}


def query(ip: str) -> bool:
    state = send_command(ip, 2, {"attr": [0]})
    return bool(int(state.get("1", 0)))


def control(ip: str, on: bool) -> bool:
    send_command(ip, 3, {"attr": [1], "data": {"1": 255 if on else 0}})
    # Read back so Home Assistant gets a command failure if the device did not apply it.
    return query(ip) is on


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[2] not in {"state", "on", "off"}:
        print("Usage: cozylife_socket.py <ip> <state|on|off>", file=sys.stderr)
        return 2
    ip, action = sys.argv[1], sys.argv[2]
    try:
        if action == "state":
            print("ON" if query(ip) else "OFF")
            return 0
        ok = control(ip, action == "on")
        print("OK" if ok else "FAILED")
        return 0 if ok else 1
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
