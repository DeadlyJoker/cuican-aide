import assert from "node:assert/strict";
import test from "node:test";
import { parseDesktopProjectOutlineToolsConfiguration } from "./desktop-project-outline-tools.ts";
const publication = {
  pluginId: "crewon.short-drama",
  packageDigest: `sha256:${"a".repeat(64)}`,
  contributionId: "workbench",
};
const configuration = {
  version: "crewon.project-outline-tools.v2",
  publications: [publication],
};
const options = {
  publications: [
    {
      pluginId: publication.pluginId,
      packageDigest: publication.packageDigest,
    },
  ],
  metadataPublications: [publication],
};
test("outline installation declaration is detached, frozen and matches the exact approved tuple", () => {
  const parsed = parseDesktopProjectOutlineToolsConfiguration(
    configuration,
    options,
  );
  assert.deepEqual(parsed, configuration);
  assert.notEqual(parsed.publications, configuration.publications);
  assert.ok(Object.isFrozen(parsed.publications[0]));
});
test("outline installation does not infer consent from old protocols or another publication", () => {
  for (const candidate of [
    { ...configuration, version: "crewon.project-foundation-tools.v1" },
    { ...configuration, version: "crewon.project-tools.v1" },
    { ...configuration, publications: [] },
    { ...configuration, publications: [publication, publication] },
    { ...configuration, grant: true },
  ])
    assert.throws(() =>
      parseDesktopProjectOutlineToolsConfiguration(candidate, options),
    );
  for (const context of [
    { ...options, publications: [] },
    { ...options, metadataPublications: [] },
    {
      ...options,
      metadataPublications: [{ ...publication, contributionId: "other" }],
    },
  ])
    assert.throws(() =>
      parseDesktopProjectOutlineToolsConfiguration(configuration, context),
    );
});
test("outline installation rejects getters without evaluating them", () => {
  let reads = 0;
  assert.throws(() =>
    parseDesktopProjectOutlineToolsConfiguration(
      {
        version: configuration.version,
        get publications() {
          reads++;
          return configuration.publications;
        },
      },
      options,
    ),
  );
  assert.equal(reads, 0);
});
