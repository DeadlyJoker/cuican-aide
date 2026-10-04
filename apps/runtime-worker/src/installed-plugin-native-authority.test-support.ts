import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  parseInstalledPluginPackage,
  parsePluginSelection,
} from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import { prepareDesktopPluginBootstrap } from "../../crewon-ui/electron/desktopPluginBootstrap.ts";
import { loadInstalledPluginAuthorityConfig } from "./plugins/installed-plugin-authority-config.ts";
import { createInstalledPluginWorkerAuthority } from "./plugins/installed-plugin-worker-authority.ts";
export const nativeActor = {
  principalId: "standalone-principal",
  actorId: "standalone-actor",
  tenantId: "standalone-tenant",
  spaceId: "standalone-space",
};
export const nativeDigest = (value: string | Buffer) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
export async function nativeAuthorityFixture(t: TestContext) {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), "crewon-native-authority-"),
  );
  chmodSync(directory, 0o700);
  const identity = {
    pluginId: "example.image",
    publisherId: "example.publisher",
    version: "1.0.0",
    packageDigest: nativeDigest("named-native-policy-test-package"),
  };
  const approvalPath = join(directory, "plugin-approvals.json");
  writeFileSync(
    approvalPath,
    JSON.stringify({
      schemaVersion: "crewon.desktop-plugin-approval.v1",
      sources: [
        {
          ...identity,
          sourceId: "source-one",
          directory: join(directory, "source"),
        },
      ],
      publications: [],
    }),
    { mode: 0o600 },
  );
  const bootstrap = await prepareDesktopPluginBootstrap({
    dataDirectory: directory,
    actor: nativeActor,
    sessionEntropy: randomUUID().replaceAll("-", ""),
  });
  assert.ok(bootstrap);
  const scope = bootstrap.scope,
    databasePath = join(directory, "control.sqlite"),
    store = new SqliteRunStore(databasePath);
  await store.pluginInstallationStore().migrate();
  await store.extensionStore().migrate();
  const at = "2026-10-04T00:00:00.000Z";
  const pkg = parseInstalledPluginPackage({
    schemaVersion: "crewon.installed-plugin-package.v1",
    ...scope,
    ...identity,
    installedAt: at,
    installedByPrincipalId: nativeActor.principalId,
    installedByActorId: nativeActor.actorId,
  });
  const result = await store.pluginInstallationStore().recordInstalledPackage({
    scope,
    actor: nativeActor,
    receipt: {
      idempotencyKey: "install",
      requestDigest: nativeDigest("install"),
    },
    package: pkg,
    expectedSelectionRevision: null,
  });
  assert.equal(result.kind, "install");
  const authorityDirectory = join(directory, ".native-plugin-authority-test");
  mkdirSync(authorityDirectory, { mode: 0o700 });
  const authorityPath = join(authorityDirectory, "authority.json"),
    profilePath = join(directory, "plugin-profile.json");
  const policyPath = join(directory, "plugin-native-policy.json");
  const networkGrants = [
    {
      ...identity,
      baseUrl: "https://example.com/",
      baseUrlParameter: "baseUrl",
      paths: [
        { method: "POST", path: "/prompt" },
        { method: "GET", operationPathPrefix: "/history/" },
      ],
    },
  ];
  writeFileSync(
    policyPath,
    JSON.stringify({
      schemaVersion: "crewon.desktop-native-plugin-policy.v1",
      packages: [{ ...identity, approvalRequirement: "none" }],
      networkGrants,
    }),
    { mode: 0o600 },
  );
  const document = {
    schemaVersion: "crewon.desktop-native-plugin-authority.v1",
    authorityId: "native-test-authority",
    actor: nativeActor,
    scope,
    installRoot: join(directory, "plugins"),
    controlDatabasePath: databasePath,
    bootstrapPath: bootstrap.bootstrapPath,
    bootstrapDigest: nativeDigest(readFileSync(bootstrap.bootstrapPath)),
    approvalPath,
    approvalDigest: nativeDigest(readFileSync(approvalPath)),
    policyPath,
    policyDigest: nativeDigest(readFileSync(policyPath)),
    profilePath,
    profileDigest: nativeDigest(readFileSync(profilePath)),
    packages: [identity],
    networkGrants: [
      {
        ...identity,
        baseUrl: "https://example.com/",
        baseUrlParameter: "baseUrl",
        paths: [
          { method: "POST", path: "/prompt" },
          { method: "GET", operationPathPrefix: "/history/" },
        ],
      },
    ],
  };
  writeFileSync(authorityPath, JSON.stringify(document), { mode: 0o600 });
  const configurationPath = join(authorityDirectory, "worker.json");
  const configuration = {
    schemaVersion: "crewon.installed-plugin-native-worker.v1",
    installRoot: document.installRoot,
    releaseDocumentPath: join(authorityDirectory, "release.json"),
    nativeAuthorityPath: authorityPath,
    historicalScope: null,
    timeoutMs: 1000,
  };
  writeFileSync(configurationPath, JSON.stringify(configuration), {
    mode: 0o600,
  });
  const config = loadInstalledPluginAuthorityConfig(configurationPath, {}),
    authority = createInstalledPluginWorkerAuthority(config);
  t.after(async () => {
    await authority.close();
    await store.close();
    await bootstrap.cleanup();
    rmSync(directory, { recursive: true, force: true });
  });
  const select = async (state: "enabled" | "disabled") => {
    const current = await store
      .pluginInstallationStore()
      .loadSelection({ scope, pluginId: identity.pluginId });
    assert.ok(current);
    const selection = parsePluginSelection({
      ...current,
      state,
      revision: current.revision + 1,
      updatedAt: at,
      updatedByPrincipalId: nativeActor.principalId,
      updatedByActorId: nativeActor.actorId,
    });
    await store.pluginInstallationStore().commitSelection({
      scope,
      actor: nativeActor,
      receipt: {
        idempotencyKey: `select-${selection.revision}`,
        requestDigest: nativeDigest(`select-${selection.revision}`),
      },
      expectedSelectionRevision: current.revision,
      selection,
    });
  };
  return {
    directory,
    identity,
    bootstrap,
    scope,
    databasePath,
    store,
    approvalPath,
    policyPath,
    profilePath,
    authorityPath,
    configurationPath,
    config,
    configuration,
    document,
    authority,
    select,
    signal: new AbortController().signal,
  };
}
