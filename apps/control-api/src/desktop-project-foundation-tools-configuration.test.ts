import assert from "node:assert/strict";
import test from "node:test";
import { parseDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
// Private bootstrap schema fixture; it does not claim installation or a real Node grant.
const publication = {
  pluginId: "crewon.short-drama",
  packageDigest: `sha256:${"a".repeat(64)}`,
  contributionId: "workbench",
};
const tools = {
  version: "crewon.project-foundation-tools.v1",
  publications: [publication],
};
const projects = {
  version: "crewon.desktop-project-execution.v1",
  pluginUi: { publications: [publication] },
};
const document = {
  schemaVersion: "crewon.desktop-plugin-bootstrap.v3",
  actor: {
    principalId: "standalone-principal",
    actorId: "standalone-actor",
    tenantId: "standalone-tenant",
    spaceId: "standalone-space",
  },
  scope: {
    tenantId: "standalone-tenant",
    spaceId: "standalone-space",
    profileId: "named-foundation-profile",
  },
  authorityEpoch: "named-native-foundation-epoch-000001",
  installRoot: "/tmp/crewon-schema-only-plugins",
  sources: [
    {
      sourceId: "named-foundation-source",
      directory: "/tmp/crewon-schema-only-source",
      pluginId: publication.pluginId,
      publisherId: "crewon",
      version: "40.0.0",
      packageDigest: publication.packageDigest,
    },
  ],
  publications: [
    {
      pluginId: publication.pluginId,
      publisherId: "crewon",
      packageDigest: publication.packageDigest,
      publicAssets: ["ui.mjs"],
    },
  ],
  projects,
};
test("v3 captures an explicit independent Foundation Node declaration and no UI sibling inference", () => {
  const parsed = parseDesktopPluginConfiguration({
    ...document,
    projectFoundationTools: tools,
  });
  assert.deepEqual(parsed, { ...document, projectFoundationTools: tools });
  assert.ok(Object.isFrozen(parsed));
  assert.equal(
    Object.hasOwn(
      parseDesktopPluginConfiguration(document),
      "projectFoundationTools",
    ),
    false,
  );
  const withUi = {
    ...document,
    projectFoundation: {
      version: "crewon.project-foundation.v1",
      pluginUi: { publications: [publication] },
      uploads: { version: "crewon.project-source-uploads.v1" },
    },
  };
  assert.equal(
    Object.hasOwn(
      parseDesktopPluginConfiguration(withUi),
      "projectFoundationTools",
    ),
    false,
  );
});
test("v1/v2 and absent or foreign metadata cannot carry a Node declaration", () => {
  const { projects: _projects, ...base } = document;
  const v1 = { ...base, schemaVersion: "crewon.desktop-plugin-bootstrap.v1" };
  const v2 = {
    ...base,
    schemaVersion: "crewon.desktop-plugin-bootstrap.v2",
    projects: {
      version: "crewon.desktop-project-history.v1",
      pluginUi: projects.pluginUi,
    },
  };
  assert.deepEqual(parseDesktopPluginConfiguration(v1), v1);
  assert.deepEqual(parseDesktopPluginConfiguration(v2), v2);
  for (const candidate of [
    { ...v1, projectFoundationTools: tools },
    { ...v2, projectFoundationTools: tools },
    { ...document, projectFoundationTools: undefined },
    {
      ...document,
      projectFoundationTools: {
        ...tools,
        publications: [{ ...publication, contributionId: "unknown" }],
      },
    },
    {
      ...document,
      projects: { version: projects.version },
      projectFoundationTools: tools,
    },
    {
      ...document,
      projectFoundationTools: {
        ...tools,
        publications: [
          { ...publication, packageDigest: `sha256:${"b".repeat(64)}` },
        ],
      },
    },
  ])
    assert.throws(() => parseDesktopPluginConfiguration(candidate));
});
