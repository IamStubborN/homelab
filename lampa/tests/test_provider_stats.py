import importlib.util
import io
import json
import pathlib
import unittest

SPEC = importlib.util.spec_from_file_location("provider_stats", pathlib.Path(__file__).resolve().parents[1] / "provider-stats.py")
stats = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stats)


def line(path, start, status=200, ms=50, size=5000, written=None):
    return (written or start.replace("Z", "").ljust(29, "0")[:29] + "Z") + " " + json.dumps({"RequestPath": path, "StartUTC": start, "DownstreamStatus": status, "Duration": ms * 1_000_000, "DownstreamContentSize": size})


class ProviderStats(unittest.TestCase):
    def test_counts_only_providers_and_skips_seen_lines(self):
        state = stats.load("/nonexistent/state.json")
        lines = [
            line("/lite/alpha?s=1&uid=fixture-secret", "2026-11-08T10:00:00.000000001Z"),
            line("/lite/alpha/video?e=1", "2026-11-08T10:00:01.000000001Z", status=500, ms=9000),
            line("/lite/events?id=1", "2026-11-08T10:00:02.000000001Z"),
            line("/lite/beta", "2026-11-08T10:00:03.000000001Z", size=10),
            "not json",
        ]
        self.assertEqual(stats.collect(state, lines), 3)
        self.assertEqual(stats.collect(state, lines), 0, "a repeated window adds nothing")
        day = state["days"]["2026-11-08"]
        self.assertEqual(day["alpha"]["catalog"]["n"], 1)
        self.assertEqual(day["alpha"]["video"], {"n": 1, "fail": 1, "empty": 0, "slow": 1, "ms": 9000})
        self.assertEqual(day["beta"]["catalog"]["empty"], 1)
        self.assertNotIn("fixture-secret", json.dumps(state), "queries and identities are never stored")

    def test_a_slow_request_logged_after_the_previous_run_is_still_counted(self):
        state = stats.load("/nonexistent/state.json")
        stats.collect(state, [line("/lite/alpha", "2026-11-08T10:00:05Z", written="2026-11-08T10:00:05.100000000Z")])
        # Started before that line, finished (and was written) 9 s later; Go trims StartUTC.
        late = line("/lite/alpha/video", "2026-11-08T10:00:00.5Z", ms=9000, written="2026-11-08T10:00:09.600000000Z")
        self.assertEqual(stats.collect(state, [late]), 1)
        self.assertEqual(state["days"]["2026-11-08"]["alpha"]["video"]["slow"], 1)

    def test_report_names_failing_providers(self):
        counter = {"n": 6, "fail": 4, "empty": 0, "slow": 0, "ms": 600}
        self.assertEqual(stats.verdict(counter), "отключить: чаще ошибается")
        self.assertEqual(stats.verdict({"n": 6, "fail": 0, "empty": 0, "slow": 4, "ms": 1}), "отключить: слишком медленный")
        self.assertEqual(stats.verdict({"n": 2, "fail": 2, "empty": 0, "slow": 0, "ms": 1}), "", "too few requests to judge")
        state = {"days": {stats.dt.date.today().isoformat(): {"gamma": {"video": counter}}}}
        out = io.StringIO(); stats.report(state, 7, out)
        self.assertIn("gamma", out.getvalue()); self.assertIn("отключить", out.getvalue())


if __name__ == "__main__":
    unittest.main()
