#!/usr/bin/env python3
import json
import socket
import sys
import time

PORT = 5555
TIMEOUT = 2.5
ATTEMPTS = 2
RETRY_DELAY = 0.2


def send_command_once(ip: str, cmd: int, msg: dict, sn: str) -> dict:
    payload = {"cmd": cmd, "pv": 0, "sn": sn, "msg": msg}
    data = (json.dumps(payload, separators=(",", ":")) + "\r\n").encode()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        deadline = time.monotonic() + TIMEOUT
        sock.settimeout(TIMEOUT)
        sock.connect((ip, PORT))
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise socket.timeout('command deadline expired during connection')
        sock.settimeout(remaining)
        sock.sendall(data)
        buffer = b""
        while (remaining := deadline - time.monotonic()) > 0:
            sock.settimeout(remaining)
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


def send_command(ip: str, cmd: int, msg: dict) -> dict:
    # CozyLife devices occasionally accept the TCP connection but drop the
    # response. Bound each attempt across connect, send and receive so retries
    # take at most two timeout budgets plus the short retry delay.
    for attempt in range(ATTEMPTS):
        sn = str(int(time.time() * 1000))
        try:
            response = send_command_once(ip, cmd, msg, sn)
        except (OSError, json.JSONDecodeError):
            response = {}
        if response:
            return response
        if attempt + 1 < ATTEMPTS:
            time.sleep(RETRY_DELAY)
    return {}


def query(ip: str) -> bool:
    state = send_command(ip, 2, {"attr": [0]})
    if "1" not in state:
        raise TimeoutError(f"no state response from {ip}:{PORT}")
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
