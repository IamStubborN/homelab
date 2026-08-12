import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "search_ladder_skill", ROOT / "shared/skills/web-research/search.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class SearchLadderSkillTests(unittest.TestCase):
    def test_research_uses_fixed_endpoint_and_bearer_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            MODULE.KEY_PATH = Path(directory) / "key"
            MODULE.KEY_PATH.write_text("secret\n", encoding="utf-8")

            def opener(request, timeout):
                self.assertEqual(request.full_url, MODULE.URL)
                self.assertEqual(request.get_header("Authorization"), "Bearer secret")
                self.assertEqual(timeout, 30)
                self.assertEqual(
                    json.loads(request.data),
                    {
                        "mode": "research",
                        "max_results": 3,
                        "max_pages": 2,
                        "max_chars": 12000,
                        "query": "current Go release",
                    },
                )
                return Response(
                    b'{"mode":"research","provider":"tavily","results":[{"title":"Go","url":"https://go.dev"}],"evidence":[{"source_id":"S1","title":"Go","final_url":"https://go.dev","summary":"Current release.","excerpts":["Go is available."],"cached":false,"truncated":true,"warnings":[]}]}'
                )

            payload = MODULE.research(query="current Go release", limit=3, pages=2, opener=opener)
            rendered = MODULE.render(payload)
            self.assertIn("https://go.dev", rendered)
            self.assertIn("Go is available.", rendered)

    def test_direct_question_body_is_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            MODULE.KEY_PATH = Path(directory) / "key"
            MODULE.KEY_PATH.write_text("secret", encoding="utf-8")

            def opener(request, timeout):
                self.assertEqual(timeout, 30)
                body = json.loads(request.data)
                self.assertEqual(body["url"], "https://example.com")
                self.assertEqual(body["focus"], "What changed?")
                self.assertEqual(body["mode"], "question")
                return Response(b'{"mode":"question","evidence":[{"source_id":"S1","final_url":"https://example.com","excerpts":["Changed."],"warnings":[]}]}' )

            MODULE.research(url="https://example.com", focus="What changed?", mode="question", opener=opener)

    def test_render_rejects_empty_results(self):
        with self.assertRaisesRegex(RuntimeError, "no results"):
            MODULE.render({"mode": "research", "results": [], "evidence": []})


if __name__ == "__main__":
    unittest.main()
