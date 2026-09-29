import copy
import pathlib
import sys
import unittest
from unittest import mock


SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import local_runtime_contract as contract


class LocalRuntimeContractTests(unittest.TestCase):
    def setUp(self):
        self.provenance = {
            "revision": "a" * 40,
            "source_tree_digest": "b" * 64,
            "runner_build_digest": "c" * 64,
        }
        self.tools = [{"name": "media_jobs_list", "inputSchema": {"type": "object"}}]
        self.snapshot = {
            "kind": "local-runtime",
            "schema_version": 1,
            "provenance": self.provenance,
            "images": {
                name: {"image": "sha256:" + char * 64,
                       "version": "abc-dirty", **self.provenance}
                for name, char in (("media-service", "1"), ("download-runner", "2"))
            },
            "cli_sha256": "d" * 64,
            "tools": self.tools,
        }

    def test_exact_runtime_is_accepted(self):
        contract.validate(self.snapshot, copy.deepcopy(self.snapshot), self.tools, "d" * 64)

    def test_image_schema_cli_and_build_drift_fail_closed(self):
        mutations = [
            lambda x: x["images"]["media-service"].update(image="sha256:" + "3" * 64),
            lambda x: x["images"]["download-runner"].update(image="sha256:" + "3" * 64),
            lambda x: x["images"]["download-runner"].update(runner_build_digest="e" * 64),
            lambda x: x["tools"][0]["inputSchema"].update(additionalProperties=False),
            lambda x: x.update(cli_sha256="e" * 64),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                actual = copy.deepcopy(self.snapshot)
                mutate(actual)
                with self.assertRaises(contract.ContractError):
                    contract.validate(self.snapshot, actual, self.tools, "d" * 64)

    def test_unknown_fields_and_mutable_refs_rejected_even_if_runtime_matches(self):
        mutations = [
            lambda x: x.update(extra="anything"),
            lambda x: x.update(kind="registry"),
            lambda x: x.update(schema_version=True),
            lambda x: x["images"]["media-service"].update(image="media:local"),
            lambda x: x["images"]["download-runner"].update(extra="anything"),
            lambda x: x["provenance"].update(revision="bad"),
            lambda x: x["images"]["media-service"].update(source_tree_digest="e" * 64),
            lambda x: x.update(tools=[]),
            lambda x: x["tools"].append(copy.deepcopy(x["tools"][0])),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                bad = copy.deepcopy(self.snapshot)
                mutate(bad)
                with self.assertRaises(contract.ContractError):
                    contract.validate(bad, bad, bad["tools"], "d" * 64)

    def test_staged_cli_and_tracked_schema_must_match(self):
        with self.assertRaises(contract.ContractError):
            contract.validate(self.snapshot, self.snapshot, self.tools, "e" * 64)
        with self.assertRaises(contract.ContractError):
            contract.validate(self.snapshot, self.snapshot, [{"name": "new_tool"}], "d" * 64)

    def test_schema_order_is_irrelevant_but_content_is_exact(self):
        self.snapshot["tools"].append({"name": "media_queue", "inputSchema": {}})
        actual = copy.deepcopy(self.snapshot)
        actual["tools"].reverse()
        contract.validate(self.snapshot, actual, actual["tools"], "d" * 64)

    def test_schema_wrapper_is_validated_without_relabeling_catalog_origin(self):
        schema = {"schema_version": 1, "source_digest": "e" * 64, "tools": self.tools}
        self.assertEqual(contract.schema_tools(schema), self.tools)
        for change in ({"schema_version": True}, {"source_digest": "bad"}, {"extra": True}):
            with self.subTest(change=change), self.assertRaises(contract.ContractError):
                contract.schema_tools({**schema, **change})

    def test_collector_rejects_retagged_image_or_overridden_container_labels(self):
        labels = {label: self.snapshot["images"]["media-service"][field] for field, label in contract.LABELS.items()}
        image_id = "sha256:" + "1" * 64
        container = {"Image": image_id, "Config": {"Image": image_id, "Labels": labels},
                     "State": {"Running": True, "Health": {"Status": "healthy"}}}
        image = {"Id": image_id, "Config": {"Labels": labels}}
        import json
        with mock.patch.object(contract, "run", side_effect=[json.dumps([container]), json.dumps([image])]):
            self.assertEqual(contract.image_attestation("media-service"), self.snapshot["images"]["media-service"])
        for mutation in (
            lambda c: c["Config"].update(Image="media:local"),
            lambda c: c["Config"]["Labels"].update({contract.LABELS["revision"]: "f" * 40}),
            lambda c: c["State"]["Health"].update(Status="unhealthy"),
        ):
            bad = copy.deepcopy(container)
            mutation(bad)
            with mock.patch.object(contract, "run", side_effect=[json.dumps([bad]), json.dumps([image])]):
                with self.assertRaises(contract.ContractError):
                    contract.image_attestation("media-service")


if __name__ == "__main__":
    unittest.main()
