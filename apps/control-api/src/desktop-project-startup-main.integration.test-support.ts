import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { ControlApiClient } from "@crewon/control-client";
import { nativeProjectHistoryFixture } from "./desktop-project-history-plugin-runtime.test-support.ts";
import {
  fullAppPortClosed,
  startFullAppProcess,
  stopFullAppProcess,
} from "./installed-plugin-full-app-process.test-support.ts";
import { waitTaskProcess } from "./installed-plugin-tasks-process.test-support.ts";
import { taskProcessFreePort } from "./installed-plugin-tasks-process-authorities.test-support.ts";

/** Original Standalone Main and real installed source UI bytes on file-backed SQL. The
 * target admission, historical provider result, funding, owner and private approval are
 * named fixtures; this does not launch Electron, a Worker or paid provider execution. */
export async function nativeProjectMainFixture(t: TestContext) {
  const cleanup: (() => unknown | Promise<unknown>)[] = [];
  const children: ReturnType<typeof startFullAppProcess>[] = [];
  let closed = false;
  t.after(async () => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    for (const close of [
      ...[...children]
        .reverse()
        .map((child) => () => stopFullAppProcess(child)),
      ...cleanup,
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "native_project_main_cleanup_failed");
  });
  // Existing fixture hooks run only after every owned child has physically terminated.
  const context = new Proxy(t, {
    get(target, key) {
      if (key === "after")
        return (close: () => unknown | Promise<unknown>) => cleanup.push(close);
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const databaseLocations = new Set<string>();
  const originalLocation = DatabaseSync.prototype.location;
  const observation = t.mock.method(
    DatabaseSync.prototype,
    "location",
    function (
      this: DatabaseSync,
      ...args: Parameters<typeof originalLocation>
    ) {
      const actual = Reflect.apply(originalLocation, this, args) as ReturnType<
        typeof originalLocation
      >;
      if (actual !== null) databaseLocations.add(actual);
      return actual;
    },
  );
  let f: Awaited<ReturnType<typeof nativeProjectHistoryFixture>>;
  try {
    // Observes the real constructor's installation-database capture; no guessed path or scan.
    f = await nativeProjectHistoryFixture(context, { selectionRecovery: true });
  } finally {
    observation.mock.restore();
  }
  assert.equal(databaseLocations.size, 1);
  const databasePath = [...databaseLocations][0]!;
  assert.equal((await lstat(databasePath)).isFile(), true);

  const root = f.files.root;
  const keyPath = join(root, "named-native-main-artifact-key");
  await writeFile(keyPath, randomBytes(32), { mode: 0o600 });
  const providerObservationPath = join(root, "named-native-main-fetches.jsonl");
  await writeFile(providerObservationPath, "", { mode: 0o600 });
  const observerPath = join(root, "named-native-main-fetch-observer.mjs");
  // Records and forwards the actual transport unchanged. No HTTP handler, authorization,
  // application result, quote or provider response is supplied by this observer.
  await writeFile(
    observerPath,
    `import { appendFileSync } from 'node:fs';
const original = globalThis.fetch;
globalThis.fetch = new Proxy(original, {
  apply(target, receiver, args) {
    const raw = args[0];
    const url = raw instanceof Request ? raw.url : String(raw);
    appendFileSync(${JSON.stringify(providerObservationPath)}, JSON.stringify({url, method: args[1]?.method ?? 'GET'}) + '\\n');
    return Reflect.apply(target, receiver, args);
  }
});
`,
    { mode: 0o600 },
  );
  const projects = {
    version: "crewon.desktop-project-history.v1",
    pluginUi: { publications: f.publications },
    generationReads: { version: "crewon.project-generation-read.v1" },
    generationReadUi: { publications: f.publications },
    resultSelections: {
      version: "crewon.project-concept-selection.v1",
      adapter: "comfyui-krea2",
      identities: [
        {
          pluginVersion: f.history.configuration.pluginVersion,
          manifestDigest: f.history.configuration.manifestDigest,
          implementationDigest: f.history.configuration.implementationDigest,
        },
      ],
    },
    selectionUi: { publications: f.publications },
    uiRecovery: f.recoveryConfiguration,
  };
  const approval = {
    schemaVersion: "crewon.desktop-plugin-approval.v2",
    sources: f.configuration.sources,
    publications: f.configuration.publications,
    projects,
  };
  const approvalBytes = Buffer.from(JSON.stringify(approval));
  const approvalPath = join(root, "named-native-main-approved-projects.json");
  await writeFile(approvalPath, approvalBytes, { mode: 0o600 });
  const hash = (value: string | Buffer) =>
    createHash("sha256").update(value).digest("hex");
  let generation = 0;
  const start = async () => {
    generation++;
    const sessionToken =
      `named-native-main-session-${generation}-` + "s".repeat(32);
    const csrfToken = `named-native-main-csrf-${generation}-` + "c".repeat(32);
    const port = await taskProcessFreePort();
    const origin = `http://127.0.0.1:${port}`;
    const authorityEpoch = hash(
      JSON.stringify({
        schemaVersion: "crewon.desktop-plugin-epoch.v1",
        approvalDigest: hash(approvalBytes),
        sessionEntropy: sessionToken,
      }),
    );
    const bootstrapPath = join(
      root,
      `named-native-main-bootstrap-${generation}.json`,
    );
    const bootstrap = {
      ...f.configuration,
      schemaVersion: "crewon.desktop-plugin-bootstrap.v2",
      authorityEpoch,
      projects,
    };
    await writeFile(bootstrapPath, JSON.stringify(bootstrap), { mode: 0o600 });
    assert.equal((await lstat(bootstrapPath)).mode & 0o777, 0o600);
    // Only the current executable path and named local fixture opt-ins cross the process boundary.
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      NODE_OPTIONS: `--import=${pathToFileURL(observerPath).href}`,
      CREWON_CONTROL_SECURITY_MODE: "standalone",
      CREWON_CONTROL_DB_PATH: databasePath,
      CREWON_CONTROL_PORT: String(port),
      CREWON_PRINCIPAL_ID: f.history.actor.principalId,
      CREWON_ACTOR_ID: f.history.actor.actorId,
      CREWON_TENANT_ID: f.history.actor.tenantId,
      CREWON_SPACE_ID: f.history.actor.spaceId,
      CREWON_CONTROL_SESSION_TOKEN: sessionToken,
      CREWON_CONTROL_CSRF_TOKEN: csrfToken,
      CREWON_CONTROL_ALLOWED_ORIGINS: origin,
      CREWON_DESKTOP_PLUGIN_BOOTSTRAP_PATH: bootstrapPath,
      CREWON_ARTIFACT_ROOT: join(root, "named-native-main-artifacts"),
      CREWON_ARTIFACT_DB_PATH: join(root, "named-native-main-artifacts.sqlite"),
      CREWON_ARTIFACT_ENCRYPTION_KEY_PATH: keyPath,
      CREWON_ARTIFACT_ENCRYPTION_KEY_ID: "named-native-main-artifact-key",
      CREWON_ARTIFACT_RETENTION: "off",
      CREWON_OUTBOX_RETENTION_MS: "off",
      CREWON_OUTBOX_SCAN_INTERVAL_MS: "10000",
      CREWON_AUTOMATION_SCAN_INTERVAL_MS: "10000",
    };
    const child = startFullAppProcess("control", environment);
    children.push(child);
    await waitTaskProcess(
      "actual Standalone Main with private Native project history approval",
      async () => child.stdout().includes("CrewON Control API listening"),
      [child],
    );
    const client = new ControlApiClient({
      baseUrl: `http://127.0.0.1:${port}`,
      accessToken: sessionToken,
      csrfToken,
      origin,
    });
    const mount = async () => {
      const selection = await f
        .parent()
        .pluginInstallationStore()
        .loadSelection({
          scope: f.scope,
          pluginId: f.v1.pluginId,
        });
      assert.ok(selection?.selectedPackageDigest);
      return client.plugins.openMount({
        pluginId: f.v1.pluginId,
        contributionId: "workbench",
        expectedSelectionRevision: selection.revision,
        expectedPackageDigest: selection.selectedPackageDigest,
      });
    };
    return {
      child,
      port,
      client,
      environment,
      authorityEpoch,
      bootstrapPath,
      sessionToken,
      csrfToken,
      origin,
      mount,
      async stop() {
        await stopFullAppProcess(child);
        assert.equal(await fullAppPortClosed(port), true);
      },
    };
  };
  return {
    ...f,
    databasePath,
    projects,
    start,
    async providerTransports() {
      return (await readFile(providerObservationPath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { url: string; method: string });
    },
  };
}
