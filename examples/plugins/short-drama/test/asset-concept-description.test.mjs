import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { content, details } from "./asset-controller.test-support.mjs";
const { outputFiles } = await build({
  entryPoints: [
    new URL("../src/workbench/AssetConceptDescription.ts", import.meta.url)
      .pathname,
  ],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node24",
});
const { assetConceptDescription } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`
);
function view() {
  return {
    asset: {
      projectId: "project-a",
      assetId: "asset-a",
      kind: "character",
      selectedContentRevision: 1,
      locked: true,
    },
    selectedContentRevision: {
      projectId: "project-a",
      assetId: "asset-a",
      kind: "character",
      contentRevision: 1,
      brief: { briefRevision: 1, contentDigest: details().brief.contentDigest },
      content: { ...content, visualPrompt: "  侧光中的修复师\n黑色短发  " },
    },
    dependencyState: "current",
  };
}
test("copies the adopted description exactly into a local immutable draft; locked assets still allow exploration", () => {
  const source = view(),
    project = details();
  const result = assetConceptDescription(source, project);
  assert.equal(
    result.prompt,
    source.selectedContentRevision.content.visualPrompt,
  );
  assert.equal(result.name, content.name);
  assert.equal(result.copiedFromAsset.contentRevision, 1);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.source));
  assert.ok(Object.isFrozen(result.copiedFromAsset));
  project.brief.briefRevision = 2;
  source.selectedContentRevision.content.visualPrompt = "后来的改动";
  assert.equal(result.source.briefRevision, 1);
  assert.equal(result.prompt, "  侧光中的修复师\n黑色短发  ");
});
for (const [name, change] of [
  [
    "another project",
    (v) => {
      v.asset.projectId = "other";
    },
  ],
  [
    "another content project",
    (v) => {
      v.selectedContentRevision.projectId = "other";
    },
  ],
  [
    "another asset",
    (v) => {
      v.selectedContentRevision.assetId = "other";
    },
  ],
  [
    "another kind",
    (v) => {
      v.selectedContentRevision.kind = "scene";
    },
  ],
  [
    "unadopted content",
    (v) => {
      v.asset.selectedContentRevision = null;
    },
  ],
  [
    "mismatched adoption",
    (v) => {
      v.asset.selectedContentRevision = 2;
    },
  ],
  [
    "stale source",
    (v) => {
      v.dependencyState = "stale";
    },
  ],
  [
    "old brief",
    (v) => {
      v.selectedContentRevision.brief.briefRevision = 2;
    },
  ],
  [
    "mismatched brief digest",
    (v) => {
      v.selectedContentRevision.brief.contentDigest = `sha256:${"b".repeat(64)}`;
    },
  ],
  [
    "empty description",
    (v) => {
      v.selectedContentRevision.content.visualPrompt = "  ";
    },
  ],
  [
    "invalid description",
    (v) => {
      v.selectedContentRevision.content.visualPrompt = "image\u0000";
    },
  ],
])
  test(`declines ${name} without preparing an input`, () => {
    const source = view();
    change(source);
    assert.equal(assetConceptDescription(source, details()), null);
  });
test("requires an active actual project and an adopted revision", () => {
  assert.equal(assetConceptDescription(view(), null), null);
  assert.equal(assetConceptDescription(null, details()), null);
  const project = details();
  project.project.state = "archived";
  assert.equal(assetConceptDescription(view(), project), null);
});
