import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class MediaSkillTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.skill = (ROOT / "shared/skills/media/SKILL.md").read_text(encoding="utf-8")
        cls.normalized = " ".join(cls.skill.split())

    def test_choices_and_provider_selection_are_explicit(self):
        self.assertIn("native `clarify`", self.skill)
        self.assertIn("two to five choices", self.skill)
        self.assertIn("source=all", self.skill)
        self.assertIn("explicitly selects Rezka or Prowlarr", self.skill)
        self.assertIn("One episode remains one episode", self.skill)

    def test_notifier_owns_successful_download_cards(self):
        self.assertIn("return exactly `NO_REPLY`", self.skill)
        self.assertIn("deterministic notifier owns the job card", self.skill)
        self.assertNotIn("10-cell progress bar", self.skill)

    def test_download_requires_exact_result_and_coordinates(self):
        self.assertIn("exact result", self.skill)
        self.assertIn("required Rezka translation", self.skill)
        self.assertIn("series coordinates", self.skill)
        self.assertIn("season download requires explicit confirmation", self.skill)


if __name__ == "__main__":
    unittest.main()
