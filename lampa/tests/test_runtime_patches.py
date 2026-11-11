import re
import unittest
from pathlib import Path

RUNTIME = Path(__file__).resolve().parent.parent / "runtime"


class RuntimePatchesTest(unittest.TestCase):
    def test_every_patch_reaches_the_build_and_applies_without_fuzz(self):
        dockerfile = (RUNTIME / "Dockerfile").read_text()
        ignore = (RUNTIME / ".dockerignore").read_text().split()
        self.assertIn("!patches/*.patch", ignore)
        patches = sorted((RUNTIME / "patches").glob("*.patch"))
        self.assertTrue(patches)
        for patch in patches:
            self.assertIn("/patches/" + patch.name, dockerfile)
            text = patch.read_text()
            self.assertRegex(text, r"(?m)^--- a/\S+\n\+\+\+ b/\S+$")
            self.assertIn("AGPL-3.0", text.split("--- a/")[0], "the header names the upstream file and licence")
        self.assertIn("--fuzz=0", dockerfile)


if __name__ == "__main__":
    unittest.main()
