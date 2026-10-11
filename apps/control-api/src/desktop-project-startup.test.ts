import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadDesktopPluginConfiguration,
  parseDesktopPluginConfiguration,
} from "./desktop-plugin-configuration.ts";
import {
  captureDesktopProjectRecoveryStartup,
  composeDesktopProjectStartup,
} from "./desktop-project-startup.ts";
import { createStandaloneControlApiWithPlugins } from "./standalone-composition.ts";
import type { StandaloneControlApiConfig } from "./standalone-composition.ts";

const actor = {
  principalId: "standalone-principal",
  actorId: "standalone-actor",
  tenantId: "standalone-tenant",
  spaceId: "standalone-space",
};
// Schema-only named identities. Actual provider identity is supplied by private approvals.
const source = {
  sourceId: "named-native-startup-source",
  directory: "/named-native-startup-fixture/source",
  pluginId: "test.native-startup-source",
  publisherId: "test.native-startup-publisher",
  version: "1.0.0",
  packageDigest: `sha256:${"a".repeat(64)}`,
};
const publication = {
  pluginId: source.pluginId,
  publisherId: source.publisherId,
  packageDigest: source.packageDigest,
  publicAssets: ["ui.mjs"],
};
const module = {
  pluginId: source.pluginId,
  packageDigest: source.packageDigest,
  contributionId: "workbench",
};
const base = {
  schemaVersion: "crewon.desktop-plugin-bootstrap.v1",
  actor,
  scope: {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    profileId: "named-native-startup-profile",
  },
  authorityEpoch: "named-native-startup-trusted-epoch-01",
  installRoot: "/named-native-startup-fixture/install",
  sources: [source],
  publications: [publication],
};
const projects = {
  version: "crewon.desktop-project-history.v1",
  pluginUi: { publications: [module] },
  generationReads: { version: "crewon.project-generation-read.v1" },
  generationReadUi: { publications: [module] },
  resultSelections: {
    version: "crewon.project-concept-selection.v1",
    adapter: "comfyui-krea2",
    identities: [
      {
        pluginVersion: "1.0.0",
        manifestDigest: `sha256:${"b".repeat(64)}`,
        implementationDigest: `sha256:${"c".repeat(64)}`,
      },
    ],
  },
  selectionUi: { publications: [module] },
  uiRecovery: {
    version: "crewon.plugin-ui-recovery.v1",
    publications: [
      {
        ...module,
        actions: ["crewon.project-generation-selections.v1.selectConceptImage"],
      },
    ],
  },
};
const v2 = {
  ...base,
  schemaVersion: "crewon.desktop-plugin-bootstrap.v2",
  projects,
};
const resource = {
  kind: "creativeProject" as const,
  tenantId: actor.tenantId,
  spaceId: actor.spaceId,
  projectId: "named-native-history-project",
};

test("legacy Native bootstrap retains its exact v1 shape and does not acquire project capabilities", () => {
  const parsed = parseDesktopPluginConfiguration(base);
  assert.equal(JSON.stringify(parsed), JSON.stringify(base));
  assert.deepEqual(
    composeDesktopProjectStartup({ configuration: parsed, actor }),
    {},
  );
  assert.throws(() => parseDesktopPluginConfiguration({ ...base, projects }));
  assert.throws(() =>
    parseDesktopPluginConfiguration({ ...v2, projects: undefined }),
  );
});

test("actual private v2 file loads frozen grants and composes original pure Comfy verifier and selection recovery", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "crewon-native-project-startup-")),
  );
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "bootstrap.json");
  await writeFile(path, JSON.stringify(v2), { mode: 0o600 });
  const parsed = await loadDesktopPluginConfiguration(path, { actor });
  assert.deepEqual(parsed, v2);
  assert.equal(parsed.schemaVersion, "crewon.desktop-plugin-bootstrap.v2");
  const startup = composeDesktopProjectStartup({
    configuration: parsed,
    actor,
  });
  assert.equal(
    typeof startup.creativeProjects!.resultSelections!.verifier.verifyImage,
    "function",
  );
  assert.deepEqual(startup.uiRecovery, projects.uiRecovery);
  assert.equal(startup.creativeProjects!.pluginGenerations, undefined);
  assert.equal(startup.creativeProjects!.pluginQueries, undefined);
  assert.ok(Object.isFrozen(startup));
});

test("Native local project policy binds every actual owner identity component and exact tenant/space", async () => {
  const configuration = parseDesktopPluginConfiguration(v2);
  const { authorization } = composeDesktopProjectStartup({
    configuration,
    actor,
  }).creativeProjects!;
  assert.deepEqual(
    await authorization.authorize({
      actor,
      action: "creativeProject:write",
      resource,
    }),
    { outcome: "allow" },
  );
  for (const field of [
    "principalId",
    "actorId",
    "tenantId",
    "spaceId",
  ] as const) {
    const changed = { ...actor, [field]: "other-native-owner" };
    assert.equal(
      (
        await authorization.authorize({
          actor: changed,
          action: "creativeProject:read",
          resource,
        })
      ).outcome,
      "deny",
    );
    assert.throws(
      () => composeDesktopProjectStartup({ configuration, actor: changed }),
      /desktop_plugin_owner_mismatch/u,
    );
  }
  for (const field of ["tenantId", "spaceId"] as const)
    assert.equal(
      (
        await authorization.authorize({
          actor,
          action: "creativeProject:read",
          resource: { ...resource, [field]: "other-scope" },
        })
      ).outcome,
      "deny",
    );
});

test("read-only startup cannot grant metadata writes or selection authority", async () => {
  const configuration = parseDesktopPluginConfiguration({
    ...v2,
    projects: {
      version: projects.version,
      generationReads: projects.generationReads,
      generationReadUi: projects.generationReadUi,
    },
  });
  const startup = composeDesktopProjectStartup({ configuration, actor });
  const authorization = startup.creativeProjects!.authorization;
  assert.equal(
    (
      await authorization.authorize({
        actor,
        action: "creativeProject:read",
        resource,
      })
    ).outcome,
    "allow",
  );
  for (const action of [
    "creativeProject:create",
    "creativeProject:list",
    "creativeProject:write",
  ] as const)
    assert.equal(
      (await authorization.authorize({ actor, action, resource })).outcome,
      "deny",
    );
  assert.equal(startup.creativeProjects!.resultSelections, undefined);
  assert.equal(startup.uiRecovery, undefined);
});

test("recovery opt-in accessors refuse before registry or database acquisition without invoking the accessor", () => {
  let called = false;
  const runtimeConfiguration = {};
  Object.defineProperty(runtimeConfiguration, "uiRecovery", {
    enumerable: true,
    get: () => {
      called = true;
      return projects.uiRecovery;
    },
  });
  assert.throws(() =>
    captureDesktopProjectRecoveryStartup({
      runtimeConfiguration,
      publications: [publication],
      projects: undefined,
    }),
  );
  assert.equal(called, false);
});

test("actual Standalone entry refuses a borrowed recovery grant before opening a database", async () => {
  let databaseRead = false;
  const config = {
    actor,
    desktopPlugins: parseDesktopPluginConfiguration(base),
    uiRecovery: projects.uiRecovery,
    sessionToken: "named-native-preflight-session-at-least-32",
    csrfToken: "named-native-preflight-csrf-at-least-32",
    allowedOrigins: ["crewon://desktop"],
    artifactStore: {},
    artifactEncryptionKeyId: "named-native-preflight-key",
    defaultAgentVersionId: "named-native-preflight-agent",
  };
  Object.defineProperty(config, "databasePath", {
    enumerable: true,
    get: () => {
      databaseRead = true;
      throw new Error("unexpected_database_acquisition");
    },
  });
  await assert.rejects(
    createStandaloneControlApiWithPlugins(
      config as unknown as Parameters<
        typeof createStandaloneControlApiWithPlugins
      >[0] &
        StandaloneControlApiConfig,
    ),
    /desktop_plugin_ui_recovery_configuration_invalid/u,
  );
  assert.equal(databaseRead, false);
});

test("actual Standalone entry refuses a Native observer on legacy projects before opening a database", async () => {
  let databaseRead = false;
  let observed = false;
  const config = {
    actor,
    desktopPlugins: parseDesktopPluginConfiguration(base),
    desktopNativeProjectWorkspaceObserver: async () => {
      observed = true;
      throw new Error("unexpected_observation");
    },
  };
  Object.defineProperty(config, "databasePath", {
    enumerable: true,
    get() {
      databaseRead = true;
      throw new Error("unexpected_database_acquisition");
    },
  });
  await assert.rejects(
    createStandaloneControlApiWithPlugins(
      config as unknown as Parameters<
        typeof createStandaloneControlApiWithPlugins
      >[0],
    ),
    /project_conversation_native_provisioning_invalid/u,
  );
  assert.equal(databaseRead, false);
  assert.equal(observed, false);
});
