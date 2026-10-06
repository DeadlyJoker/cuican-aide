import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
const directory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL(
    `../dist/${process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "24.0.0"}/`,
    import.meta.url,
  ).pathname;
test("published input profile uses the same canonical workflows as the actual bundled Node adapter", async () => {
  const descriptor = JSON.parse(
    await readFile(join(directory, "crewon.plugin.json"), "utf8"),
  );
  const profile = JSON.parse(
    await readFile(join(directory, "media-input-profile.json"), "utf8"),
  );
  assert.equal(
    profile.schemaVersion,
    "crewon.short-drama-media-input-profile.v1",
  );
  assert.equal(profile.pluginId, "crewon.short-drama");
  const { referenceWorkflowCatalog } = await import(
    pathToFileURL(join(directory, "node.mjs")).href
  );
  assert.equal(profile.workflows.length, referenceWorkflowCatalog.length);
  for (const workflow of profile.workflows) {
    const bytes = await readFile(join(directory, workflow.file));
    const file = descriptor.files.find((f) => f.path === workflow.file);
    assert.equal(file.byteLength, bytes.length);
    assert.equal(file.sha256, createHash("sha256").update(bytes).digest("hex"));
    const catalog = referenceWorkflowCatalog.find(
      (w) => w.workflowId === workflow.workflowId,
    );
    assert.equal(workflow.workflowDigest, catalog.workflowDigest);
    assert.equal(workflow.output.nodeId, catalog.outputNodeId);
    assert.deepEqual(workflow.output, {
      kind: "image",
      nodeId: catalog.outputNodeId,
      dimensions: "workflow-native",
    });
  }
});
