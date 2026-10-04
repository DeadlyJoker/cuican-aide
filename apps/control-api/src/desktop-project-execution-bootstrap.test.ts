import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertDesktopPluginConfigurationFileCurrent,
  loadDesktopPluginConfiguration,
  parseDesktopPluginConfiguration,
} from "./desktop-plugin-configuration.ts";

const actor = {
  principalId: "standalone-principal",
  actorId: "standalone-actor",
  tenantId: "standalone-tenant",
  spaceId: "standalone-space",
};
const source = {
  pluginId: "example.short-drama",
  packageDigest: `sha256:${"a".repeat(64)}`,
  contributionId: "workbench",
};
const target = {
  pluginId: "example.krea2",
  packageDigest: `sha256:${"b".repeat(64)}`,
  contributionId: "studio",
};
const projects = {
  version: "crewon.desktop-project-execution.v1",
  pluginUi: { publications: [source] },
  generationReads: { version: "crewon.project-generation-read.v1" },
  pluginGenerations: {
    publications: [{ source, target: { ...target, action: "image.generate" } }],
  },
  pluginQueries: {
    publications: [{ source, target: { ...target, action: "image.query" } }],
  },
  uiRecovery: {
    version: "crewon.plugin-ui-recovery.v1",
    publications: [
      {
        ...source,
        actions: [
          "crewon.project-generations.v1.generateConcept",
          "crewon.project-generation-queries.v1.queryConceptGeneration",
        ],
      },
    ],
  },
};
// Real private filesystem, schema-only package identities; this fixture does not install or execute packages.
async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "crewon-native-execution-bootstrap-")),
  );
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "private");
  await mkdir(directory, { mode: 0o700 });
  const path = join(directory, "bootstrap.json");
  const document = {
    schemaVersion: "crewon.desktop-plugin-bootstrap.v3",
    actor,
    scope: {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      profileId: "named-execution-profile",
    },
    authorityEpoch: "named-native-execution-epoch-0000001",
    installRoot: join(root, "plugins"),
    sources: [
      {
        sourceId: "named-native-source",
        directory: join(root, "source"),
        pluginId: source.pluginId,
        publisherId: "example",
        version: "1.0.0",
        packageDigest: source.packageDigest,
      },
    ],
    publications: [
      {
        pluginId: source.pluginId,
        publisherId: "example",
        packageDigest: source.packageDigest,
        publicAssets: ["ui.mjs"],
      },
    ],
    projects,
  };
  await writeFile(path, JSON.stringify(document), { mode: 0o600 });
  return { root, directory, path, document };
}

test("actual v3 private load preserves exact data and only its original object proves file-current", async (t) => {
  const f = await fixture(t);
  const loaded = await loadDesktopPluginConfiguration(f.path, { actor });
  assert.deepEqual(loaded, f.document);
  assert.ok(Object.isFrozen(loaded));
  assertDesktopPluginConfigurationFileCurrent(loaded);
  assert.equal(parseDesktopPluginConfiguration(loaded), loaded);
  for (const value of [
    parseDesktopPluginConfiguration(f.document),
    structuredClone(loaded),
    { ...loaded },
  ])
    assert.throws(() => assertDesktopPluginConfigurationFileCurrent(value));
});

test("old bootstrap schemas remain strict and parsed v3 cannot provide ambient runtime fields", async (t) => {
  const f = await fixture(t);
  for (const schemaVersion of [
    "crewon.desktop-plugin-bootstrap.v1",
    "crewon.desktop-plugin-bootstrap.v2",
  ])
    assert.throws(() =>
      parseDesktopPluginConfiguration({ ...f.document, schemaVersion }),
    );
  for (const field of [
    "taskExecution",
    "activation",
    "creditQuotes",
    "wallet",
    "token",
    "supplier",
  ])
    assert.throws(() =>
      parseDesktopPluginConfiguration({ ...f.document, [field]: {} }),
    );
  const { projects: _projects, ...base } = f.document;
  const v1 = { ...base, schemaVersion: "crewon.desktop-plugin-bootstrap.v1" };
  assert.deepEqual(parseDesktopPluginConfiguration(v1), v1);
  const v2 = {
    ...base,
    schemaVersion: "crewon.desktop-plugin-bootstrap.v2",
    projects: {
      version: "crewon.desktop-project-history.v1",
      pluginUi: projects.pluginUi,
    },
  };
  assert.deepEqual(parseDesktopPluginConfiguration(v2), v2);
});

test("new file-current guard rejects content drift and replacement even when replacement bytes match", async (t) => {
  for (const replacement of [false, true]) {
    const f = await fixture(t);
    const loaded = await loadDesktopPluginConfiguration(f.path, { actor });
    if (replacement) await rename(f.path, `${f.path}.old`);
    await writeFile(
      f.path,
      replacement
        ? JSON.stringify(f.document)
        : JSON.stringify({
            ...f.document,
            authorityEpoch: "changed-native-execution-epoch-0001",
          }),
      { mode: 0o600 },
    );
    assert.throws(() => assertDesktopPluginConfigurationFileCurrent(loaded));
  }
});

test("new provenance guard rejects leaf links, private permissions and ancestor inode drift", async (t) => {
  for (const change of [
    "hardlink",
    "symlink",
    "leaf-mode",
    "parent-mode",
    "parent-inode",
  ] as const) {
    const f = await fixture(t);
    const loaded = await loadDesktopPluginConfiguration(f.path, { actor });
    if (change === "hardlink") await link(f.path, `${f.path}.alias`);
    else if (change === "symlink") {
      await rename(f.path, `${f.path}.old`);
      await symlink(`${f.path}.old`, f.path);
    } else if (change === "leaf-mode") await chmod(f.path, 0o640);
    else if (change === "parent-mode") await chmod(f.directory, 0o750);
    else {
      await rename(f.directory, `${f.directory}.old`);
      await mkdir(f.directory, { mode: 0o700 });
      await writeFile(f.path, JSON.stringify(f.document), { mode: 0o600 });
    }
    assert.throws(() => assertDesktopPluginConfigurationFileCurrent(loaded));
  }
});

test("new file-current guard ignores unrelated sibling allocation but rejects changed loaded actor", async (t) => {
  const f = await fixture(t);
  const loaded = await loadDesktopPluginConfiguration(f.path, { actor });
  await writeFile(join(f.directory, "unrelated.json"), "{}", { mode: 0o600 });
  assertDesktopPluginConfigurationFileCurrent(loaded);
  await assert.rejects(
    loadDesktopPluginConfiguration(f.path, {
      actor: { ...actor, actorId: "other-actor" },
    }),
  );
});

test("v3 exact recovery/source mismatch rejects during load instead of issuing a startup owner", async (t) => {
  const f = await fixture(t);
  const wrong = structuredClone(f.document);
  wrong.projects.uiRecovery.publications[0]!.contributionId = "other-module";
  await writeFile(f.path, JSON.stringify(wrong), { mode: 0o600 });
  await assert.rejects(loadDesktopPluginConfiguration(f.path, { actor }));
});
