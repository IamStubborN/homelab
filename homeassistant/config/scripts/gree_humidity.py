#!/usr/bin/env python3
import asyncio
import logging
import sys

from greeclimate.device import Device
from greeclimate.deviceinfo import DeviceInfo

logging.disable(logging.CRITICAL)

async def read_humidity(ip: str, mac: str) -> int:
    info = DeviceInfo(ip, 7000, mac, mac, 'gree', None, None)
    device = Device(info, timeout=8, bind_timeout=8)
    await device.bind()
    await asyncio.wait_for(device._valid_state.wait(), timeout=8)
    await device.update_state()
    await asyncio.sleep(1)
    humidity = device.current_humidity
    if humidity is None:
        raise RuntimeError('humidity is not available')
    return int(humidity)

async def main() -> int:
    if len(sys.argv) != 3:
        print('usage: gree_humidity.py <ip> <mac>', file=sys.stderr)
        return 2
    try:
        print(await read_humidity(sys.argv[1], sys.argv[2]))
        return 0
    except Exception as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 1

if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
