"""An incompatible optional module must not prevent a healthy core update."""
import importlib.util
from pathlib import Path
import tempfile
from unittest.mock import patch

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("update_runtime", root / "lampa/update-runtime.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
config = {"Entrypoint": ["/usr/share/dotnet/dotnet", "Core.dll"], "Cmd": [], "WorkingDir": "/lampac", "User": "lampac"}
for extension, core in [(True, True), (False, True), (False, False)]:
    with tempfile.TemporaryDirectory() as directory:
        record = {"phase": "staged", "fingerprint": "test", "candidate": "synthetic", "generation": "test"}
        probes = []
        def probe(root, state, record, extension):
            probes.append(extension)
            return (extension_result if extension else core)
        extension_result = extension
        with patch.object(runtime, "current", return_value=({}, {"Config": config}, [])), \
             patch.object(runtime, "fingerprint", return_value="test"), \
             patch.object(runtime, "inspect", return_value={"Config": config}), \
             patch.object(runtime, "probe_candidate", side_effect=probe):
            if core:
                runtime.check(root, Path(directory), record)
                assert record["phase"] == "checked"
                assert record["homelab_sync_enabled"] is extension
            else:
                try:
                    runtime.check(root, Path(directory), record)
                    raise AssertionError("broken core must never be approved")
                except RuntimeError:
                    assert record["phase"] != "checked"
        assert probes == ([True] if extension else [True, False])
print("PASS: incompatible optional module is disabled; broken core remains blocked")
