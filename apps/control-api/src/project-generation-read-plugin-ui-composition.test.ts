import assert from "node:assert/strict";
import test from "node:test";
import { captureCreativeProjectCompositionConfig } from "./creative-project-composition.ts";
import {
  assertProjectGenerationReadPluginPublications,
  captureProjectGenerationReadPluginUiConfig,
} from "./project-generation-read-plugin-ui-composition.ts";

const publication = {
  pluginId: "fixture.drama",
  packageDigest: `sha256:${"d".repeat(64)}`,
  contributionId: "workbench",
};
const authorization = {
  authorize: async () => ({ outcome: "allow" as const }),
};

test("read UI is independently disabled and exact allowlist capture cannot be changed after startup", () => {
  assert.equal(
    captureProjectGenerationReadPluginUiConfig(undefined),
    undefined,
  );
  const raw = { publications: [{ ...publication }] };
  const captured = captureProjectGenerationReadPluginUiConfig(raw)!;
  raw.publications[0]!.contributionId = "replaced";
  assert.deepEqual(captured.publications, [publication]);
  assert.ok(Object.isFrozen(captured.publications[0]));
  const metadata = captureCreativeProjectCompositionConfig({
    authorization,
    pluginUi: { publications: [publication] },
  })!;
  assert.equal(metadata.generationReadUi, undefined);
  assert.equal(metadata.generationReads, undefined);
  assert.throws(
    () =>
      captureCreativeProjectCompositionConfig({
        authorization,
        generationReadUi: { publications: [publication] },
      }),
    /read_ui_reader_required/u,
  );
  const full = captureCreativeProjectCompositionConfig({
    authorization,
    generationReads: { version: "crewon.project-generation-read.v1" },
    generationReadUi: { publications: [publication] },
  })!;
  assert.deepEqual(full.generationReadUi!.publications, [publication]);
});

test("read UI deployment config rejects getters, unknown fields, duplicate/oversize lists and unapproved packages without evaluating input", () => {
  let evaluated = 0;
  const accessor = Object.defineProperty({}, "publications", {
    enumerable: true,
    get() {
      evaluated++;
      return [publication];
    },
  });
  for (const value of [
    accessor,
    { publications: [publication], paid: true },
    { publications: [publication, publication] },
    { publications: Array.from({ length: 33 }, () => publication) },
  ])
    assert.throws(() => captureProjectGenerationReadPluginUiConfig(value));
  const raw = {
    authorization,
    generationReads: { version: "crewon.project-generation-read.v1" },
  };
  Object.defineProperty(raw, "generationReadUi", {
    enumerable: true,
    get() {
      evaluated++;
      return { publications: [publication] };
    },
  });
  assert.throws(() => captureCreativeProjectCompositionConfig(raw));
  assert.equal(evaluated, 0);
  assert.throws(
    () =>
      assertProjectGenerationReadPluginPublications(
        { publications: [publication] },
        [{ ...publication, packageDigest: `sha256:${"e".repeat(64)}` }],
      ),
    /publication_unapproved/u,
  );
  assertProjectGenerationReadPluginPublications(
    { publications: [publication] },
    [publication],
  );
});
