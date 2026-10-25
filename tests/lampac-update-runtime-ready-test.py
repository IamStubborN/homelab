"""http_ready waits by time, long enough for a new version's first start."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("update_runtime", ROOT / "lampa/update-runtime.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)

clock = [0.0]
runtime.time.monotonic = lambda: clock[0]
runtime.time.sleep = lambda seconds: clock.__setitem__(0, clock[0] + seconds + 3)
runtime.inspect = lambda kind, name: {"State": {"Running": True}}


def ready_after(seconds):
    def docker(*args):
        if clock[0] < seconds:
            raise RuntimeError("connection refused")
        return "hash"
    runtime.docker = docker
    clock[0] = 0.0
    return runtime.http_ready("lampa")


assert ready_after(5 * 60), "a 5-minute first start must count as ready"
assert not ready_after(11 * 60), "the wait must end after READY_SECONDS"
assert clock[0] < runtime.READY_SECONDS + 10
runtime.inspect = lambda kind, name: {"State": {"Running": False}}
assert not ready_after(0), "a stopped container is never ready"
print("Lampac readiness wait tests passed")
