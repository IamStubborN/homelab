import copy
import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location("retention", Path(__file__).parents[1] / "image-retention.py")
retention = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retention)


def image_id(number):
    return f"sha256:{number:064x}"


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.ids = [image_id(n) for n in range(1, 5)]
        self.digests = {i: ["example/app@" + i] for i in self.ids}
        self.state = {
            "version": 1, "daemon": "test", "project": "homelab",
            "services": {"app/1": {"ref": "example/app:latest", "history": self.ids[:3]}},
            "digests": self.digests,
        }
        self.snapshot = {
            "daemon": "test",
            "containers": [self.container(self.ids[2])],
            "images": {i: {"id": i, "tags": [], "digests": self.digests[i], "size": 100} for i in self.ids},
        }

    def container(self, image, status="running", service="app"):
        return {"id": service, "image": image, "ref": "example/app:latest", "status": status,
                "labels": {retention.ENABLE: "true", retention.COMPOSE + "project": "homelab",
                           retention.COMPOSE + "service": service, retention.COMPOSE + "container-number": "1"}}

    def candidates(self):
        return [row["id"] for row in retention.plan(self.state, self.snapshot)["candidates"]]

    def test_only_proven_old_image_is_eligible_and_plan_is_read_only(self):
        before = copy.deepcopy(self.state)
        self.assertEqual(self.candidates(), self.ids[:1])
        self.assertEqual(self.state, before)

    def test_manual_rollback_tag_protects_an_old_image(self):
        self.snapshot["images"][self.ids[0]]["tags"] = ["example/app:rollback"]
        self.assertEqual(self.candidates(), [])

    def test_stopped_container_reference_protects_an_old_image(self):
        self.snapshot["containers"].append(self.container(self.ids[0], "exited", "old"))
        self.assertEqual(self.candidates(), [])

    def test_missing_service_freezes_all_history(self):
        self.snapshot["containers"] = []
        self.assertEqual(self.candidates(), [])

    def test_unknown_digest_prevents_removal_of_the_entire_image(self):
        self.snapshot["images"][self.ids[0]]["digests"] = ["untracked/app@" + self.ids[0]]
        self.assertEqual(self.candidates(), [])

    def test_rollback_protects_returned_image_and_last_current_image(self):
        self.snapshot["containers"][0]["image"] = self.ids[0]
        self.assertEqual(self.candidates(), [self.ids[1]])


if __name__ == "__main__":
    unittest.main()
