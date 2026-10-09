import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareDesktopPluginBootstrap } from "../../crewon-ui/electron/desktopPluginBootstrap.ts";
import {
  parseDesktopPluginConfiguration,
  loadDesktopPluginConfiguration,
  assertDesktopPluginConfigurationFileCurrent,
} from "./desktop-plugin-configuration.ts";
// Private bootstrap schema fixture; it does not claim installation or a real Node grant.
const publication = {
  pluginId: "crewon.short-drama",
  packageDigest: `sha256:${"a".repeat(64)}`,
  contributionId: "workbench",
};
const tools = {
  version: "crewon.project-outline-tools.v2",
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
    profileId: "named-outline-profile",
  },
  authorityEpoch: "named-native-outline-epoch-000001",
  installRoot: "/tmp/crewon-schema-only-plugins",
  sources: [
    {
      sourceId: "named-outline-source",
      directory: "/tmp/crewon-schema-only-source",
      pluginId: publication.pluginId,
      publisherId: "crewon",
      version: "47.0.0",
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
test("v3 captures an explicit independent Outline Node declaration and no UI sibling inference", () => {
  const parsed = parseDesktopPluginConfiguration({
    ...document,
    projectOutlineTools: tools,
  });
  assert.deepEqual(parsed, { ...document, projectOutlineTools: tools });
  assert.ok(Object.isFrozen(parsed));
  assert.equal(
    Object.hasOwn(
      parseDesktopPluginConfiguration(document),
      "projectOutlineTools",
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
      "projectOutlineTools",
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
    { ...v1, projectOutlineTools: tools },
    { ...v2, projectOutlineTools: tools },
    { ...document, projectOutlineTools: undefined },
    {
      ...document,
      projectOutlineTools: {
        ...tools,
        publications: [{ ...publication, contributionId: "unknown" }],
      },
    },
    {
      ...document,
      projects: { version: projects.version },
      projectOutlineTools: tools,
    },
    {
      ...document,
      projectOutlineTools: {
        ...tools,
        publications: [
          { ...publication, packageDigest: `sha256:${"b".repeat(64)}` },
        ],
      },
    },
  ])
    assert.throws(() => parseDesktopPluginConfiguration(candidate));
});

test("the actual Native v3 writer and private Control reader retain the independent outline declaration and original file lifetime", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "crewon-outline-bootstrap-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "plugin-approvals.json"),
    JSON.stringify({
      schemaVersion: "crewon.desktop-plugin-approval.v3",
      sources: document.sources,
      publications: document.publications,
      projects,
      projectOutlineTools: tools,
    }),
    { mode: 0o600 },
  );
  const native = await prepareDesktopPluginBootstrap({
    dataDirectory: root,
    actor: document.actor,
    sessionEntropy: "named-test-native-outline-bootstrap-session-00001",
  });
  assert.ok(native);
  try {
    const loaded = await loadDesktopPluginConfiguration(native.bootstrapPath, {
      actor: document.actor,
    });
    assert.equal(loaded.schemaVersion, "crewon.desktop-plugin-bootstrap.v3");
    if (loaded.schemaVersion !== "crewon.desktop-plugin-bootstrap.v3")
      throw new Error("wrong schema");
    assert.deepEqual(loaded.projectOutlineTools, tools);
    assert.equal(Object.hasOwn(loaded, "projectFoundationTools"), false);
    assertDesktopPluginConfigurationFileCurrent(loaded);
    await native.cleanup();
    assert.throws(() => assertDesktopPluginConfigurationFileCurrent(loaded));
  } finally {
    await native.cleanup();
  }
});
