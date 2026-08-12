import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { compileWorkflowVersion } from "./workflow-version.ts";

test("shared fixture separates TypeScript canonical authority from Rust legacy import", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../test-contracts/fixtures/workflow-rust-compatibility.reference.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(fixture.canonicalBoundary, {
    identity: ["workflowId", "workflowVersionId", "contentDigest"],
    binding: ["workflowId", "workflowVersionId", "contentDigest"],
    valueAuthority: ["valueId", "valueDigest"],
    nodeTopology: [
      "dependsOn",
      "entryNodeIds",
      "outputNodeIds",
      "executionOrder",
    ],
    statusAuthority: "typescriptRunLifecycleAndScheduler",
    errorAuthority: "typedWorkflowVersionAndApplicationErrors",
  });
  const compiled = compileWorkflowVersion(fixture.typescriptCanonicalSource, {
    sha256: () =>
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  assert.equal(compiled.schemaVersion, "crewon.workflow-version.v0");
  assert.equal(compiled.workflowVersionId, "canonical-workflow-v1");
  assert.deepEqual(compiled.executionOrder, ["root", "verify"]);
  assert.equal(
    fixture.rustLegacyAuthority.runtimeAuthority,
    "rustLegacySerial",
  );
  assert.equal(fixture.untaggedImportedLegacyAuthority.schemaVersion, undefined);
});
