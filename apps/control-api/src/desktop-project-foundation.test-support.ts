import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { parseExtensionManifest } from "@crewon/domain";
import { verifyLocalPluginPackage } from "@crewon/plugin-host";
import {
  PROJECT_FOUNDATION_UI_METHOD_ACTIONS,
  projectFoundationUiCodec,
  type ProjectFoundationUiInputMap,
  type ProjectFoundationUiMethod,
} from "@crewon/contracts/project-foundation";
import {
  PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS,
  projectSourceUploadsCodec,
  projectSourceUploadPartPath,
  parseProjectSourceUploadPartResponse,
  type ProjectSourceUploadInputMap,
  type ProjectSourceUploadMethod,
  type ProjectSourceUploadPartLocator,
} from "@crewon/contracts/project-source-uploads";
import {
  loadDesktopPluginConfiguration,
  type DesktopPluginConfiguration,
} from "./desktop-plugin-configuration.ts";
import { composeDesktopProjectStartup } from "./desktop-project-startup.ts";
import { createStandaloneControlApiWithPlugins } from "./standalone-composition.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import { nativeConfigurationManifest } from "./desktop-plugin-configuration.test-support.ts";

export const desktopFoundationActor = Object.freeze({
  tenantId: "desktop-foundation-tenant",
  spaceId: "desktop-foundation-space",
  principalId: "desktop-foundation-principal",
  actorId: "desktop-foundation-native-actor",
});
export const desktopFoundationHash = (bytes: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const headers = Object.freeze({
  "authorization": `Bearer ${"s".repeat(32)}`,
  "origin": "crewon://desktop",
  "x-csrf-token": "c".repeat(32),
});
type Runtime = Awaited<
  ReturnType<typeof createStandaloneControlApiWithPlugins>
>;

/** Actual private Native bootstrap, verified dual-entry bytes, original session/router and
 * file-backed SQLite. No Electron, model, Worker or paid provider is supplied by this fixture. */
export async function desktopFoundationFixture(t: TestContext) {
  let runtime: Runtime | undefined;
  const files = await productionSourceFixture(t, {
    beforeCleanup: async () => runtime?.app.close(),
  });
  const original = await files.source("short-drama-39", {
    pluginId: "test.desktop-drama",
    version: "39.0.0",
    uiOnly: true,
    requires: [
      { service: "crewon.project-foundation", apiVersion: "1", optional: true },
      {
        service: "crewon.project-source-uploads",
        apiVersion: "1",
        optional: true,
      },
    ],
  });
  const manifest = parseExtensionManifest({
    ...nativeConfigurationManifest,
    pluginId: original.pluginId,
    version: original.version,
  });
  const entries = [
    {
      path: "ui.mjs",
      bytes: await readFile(join(original.directory, "ui.mjs")),
    },
    { path: "business.json", bytes: Buffer.from(JSON.stringify(manifest)) },
    {
      path: "node.mjs",
      bytes: Buffer.from(
        `export default {apiVersion:'crewon.plugin-host.v1',pluginId:${JSON.stringify(original.pluginId)},setup(){return {dispose(){}};}};`,
      ),
    },
  ];
  const descriptor = {
    ...original.descriptor,
    entrypoints: {
      node: "node.mjs",
      ui: { path: "ui.mjs", mode: "trustedModule" as const },
    },
    businessManifestPath: "business.json",
    files: entries.map(({ path, bytes }) => ({
      path,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  };
  for (const entry of entries)
    await writeFile(join(original.directory, entry.path), entry.bytes);
  await writeFile(
    join(original.directory, "crewon.plugin.json"),
    JSON.stringify(descriptor),
  );
  const verified = await verifyLocalPluginPackage({
    directory: original.directory,
  });
  const pkg = {
    ...original,
    descriptor,
    packageDigest: verified.packageDigest,
  };
  const { descriptor: _descriptor, ...source } = pkg;
  const module = {
    pluginId: pkg.pluginId,
    packageDigest: pkg.packageDigest,
    contributionId: "workbench",
  };
  const declaration = {
    schemaVersion: "crewon.desktop-plugin-bootstrap.v3" as const,
    actor: desktopFoundationActor,
    scope: {
      tenantId: desktopFoundationActor.tenantId,
      spaceId: desktopFoundationActor.spaceId,
      profileId: "desktop-foundation-native-profile",
    },
    authorityEpoch: "desktop-foundation-private-approved-epoch-39",
    installRoot: files.installRoot,
    sources: [source],
    publications: [
      {
        pluginId: pkg.pluginId,
        packageDigest: pkg.packageDigest,
        publisherId: pkg.publisherId,
        publicAssets: ["ui.mjs"],
      },
    ],
    projects: {
      version: "crewon.desktop-project-execution.v1",
      pluginUi: { publications: [module] },
    },
    projectFoundation: {
      version: "crewon.project-foundation.v1",
      pluginUi: { publications: [module] },
      uploads: {
        version: "crewon.project-source-uploads.v1",
        pluginUi: { publications: [module] },
      },
    },
  };
  const bootstrapPath = join(files.root, "private-bootstrap.json");
  const databasePath = join(files.root, "original-native.sqlite");
  await writeFile(bootstrapPath, JSON.stringify(declaration), { mode: 0o600 });
  const load = () =>
    loadDesktopPluginConfiguration(bootstrapPath, {
      actor: desktopFoundationActor,
    });
  let configuration = await load();
  function base() {
    return {
      databasePath,
      actor: desktopFoundationActor,
      defaultAgentVersionId: "unavailable-real-model",
      sessionToken: "s".repeat(32),
      csrfToken: "c".repeat(32),
      allowedOrigins: ["crewon://desktop"],
      artifactStore: new InMemoryArtifactStore(),
      artifactEncryptionKeyId: "fixture-key",
      heartbeatIntervalMs: null,
      outboxScanIntervalMs: null,
      outboxRetention: null,
      artifactRetention: null,
      automationScanIntervalMs: null,
    };
  }
  async function open(input: DesktopPluginConfiguration = configuration) {
    assert.equal(
      runtime,
      undefined,
      "close before reopening the original Native database",
    );
    configuration = input;
    runtime = await createStandaloneControlApiWithPlugins({
      ...base(),
      ...composeDesktopProjectStartup({
        configuration,
        actor: desktopFoundationActor,
      }),
      desktopPlugins: configuration,
    });
  }
  async function close() {
    await runtime?.app.close();
    runtime = undefined;
  }
  function request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: object | Buffer,
    key?: string,
    additionalHeaders: Record<string, string> = {},
  ) {
    assert.ok(runtime);
    return runtime.app.inject({
      method,
      url,
      headers: {
        ...headers,
        ...additionalHeaders,
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(payload === undefined ? {} : { payload }),
    });
  }
  async function install() {
    const response = await request(
      "POST",
      "/api/v1/plugins/installations",
      {
        sourceId: pkg.sourceId,
        expectedPluginId: pkg.pluginId,
        expectedPackageDigest: pkg.packageDigest,
        expectedSelectionRevision: null,
      },
      "desktop-foundation-install",
    );
    assert.equal(response.statusCode, 200, response.body);
    await select(1, "enabled", "desktop-foundation-enable");
  }
  async function select(
    revision: number,
    state: "enabled" | "disabled" | "uninstalled",
    key: string,
  ) {
    const response = await request(
      "PUT",
      `/api/v1/plugins/selections/${pkg.pluginId}`,
      {
        expectedSelectionRevision: revision,
        state,
        selectedPackageDigest:
          state === "uninstalled" ? null : pkg.packageDigest,
      },
      key,
    );
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  }
  async function mount(revision = 2) {
    const response = await request("POST", "/api/v1/plugins/ui/mounts", {
      pluginId: pkg.pluginId,
      contributionId: "workbench",
      expectedSelectionRevision: revision,
      expectedPackageDigest: pkg.packageDigest,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as { mountRef: string };
  }
  function invokeRaw(mountRef: string, action: string, input: object) {
    return request("POST", `/api/v1/plugins/ui/mounts/${mountRef}/actions`, {
      action,
      input,
    });
  }
  async function invoke<M extends ProjectFoundationUiMethod>(
    mountRef: string,
    method: M,
    input: ProjectFoundationUiInputMap[M],
  ) {
    const expected = projectFoundationUiCodec.parseRequest({
      action: PROJECT_FOUNDATION_UI_METHOD_ACTIONS[method],
      input,
    });
    const response = await invokeRaw(
      mountRef,
      PROJECT_FOUNDATION_UI_METHOD_ACTIONS[method],
      input,
    );
    assert.equal(response.statusCode, 200, response.body);
    return projectFoundationUiCodec.parseResponse(
      response.json().output,
      expected,
    );
  }
  async function upload<M extends ProjectSourceUploadMethod>(
    mountRef: string,
    method: M,
    input: ProjectSourceUploadInputMap[M],
  ) {
    const expected = projectSourceUploadsCodec.parseRequest({
      action: PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS[method],
      input,
    });
    const response = await invokeRaw(
      mountRef,
      PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS[method],
      input,
    );
    assert.equal(response.statusCode, 200, response.body);
    return projectSourceUploadsCodec.parseResponse(
      response.json().output,
      expected,
    );
  }
  async function writePart(
    mountRef: string,
    locator: ProjectSourceUploadPartLocator,
    bytes: Buffer,
  ) {
    const response = await request(
      "PUT",
      projectSourceUploadPartPath(mountRef, locator),
      bytes,
      undefined,
      { "content-type": "application/octet-stream" },
    );
    assert.equal(response.statusCode, 200, response.body);
    return parseProjectSourceUploadPartResponse(
      response.json(),
      locator,
      bytes.byteLength,
    );
  }
  function query(sql: string) {
    const database = new DatabaseSync(databasePath);
    try {
      return database.prepare(sql).all();
    } finally {
      database.close();
    }
  }
  function count(table: string) {
    assert.match(table, /^[a-z_]+$/u);
    return Number(query(`SELECT count(*) AS n FROM ${table}`)[0]!.n);
  }
  async function assertNoExecution() {
    await assert.rejects(access(files.marker), { code: "ENOENT" });
    for (const table of [
      "extension_tasks",
      "plugin_credit_accounts",
      "project_generation_executions",
    ])
      assert.equal(
        query(
          `SELECT count(*) AS n FROM sqlite_master WHERE name='${table}'`,
        )[0]!.n,
        0,
        table,
      );
    assert.equal(count("run_snapshots"), 0);
    assert.equal(count("extension_run_bindings"), 0);
  }
  return {
    files,
    pkg,
    module,
    declaration,
    bootstrapPath,
    databasePath,
    configuration,
    base,
    load,
    open,
    close,
    request,
    install,
    select,
    mount,
    invokeRaw,
    invoke,
    upload,
    writePart,
    query,
    count,
    assertNoExecution,
  };
}
