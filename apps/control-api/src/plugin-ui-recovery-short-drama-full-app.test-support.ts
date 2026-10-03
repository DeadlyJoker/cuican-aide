import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseGetConceptSelectionResponse,
  parsePluginUiRecoveryHintsResponse,
  parseSelectConceptImageResponse,
  parseStagePluginUiRecoveryResponse,
  type GetConceptSelectionResponse,
  type PluginUiRecoveryHintsResponse,
  type PluginUiRecoveryRequest,
  type SelectConceptImageResponse,
  type StagePluginUiRecoveryResponse,
} from "@crewon/contracts";
import { trackDesktopTestChildren } from "../../crewon-ui/electron/desktopPluginTestChildren.test-support.ts";
import {
  recoveryMainFixture,
  mainRecoveryActions,
} from "./plugin-ui-recovery-main.integration.test-support.ts";
import {
  createFullAppEdge,
  fullAppLogin,
} from "./installed-plugin-full-app-edge.test-support.ts";
import {
  startFullAppProcess,
  stopFullAppProcess,
  fullAppPortClosed,
} from "./installed-plugin-full-app-process.test-support.ts";
import { waitTaskProcess } from "./installed-plugin-tasks-process.test-support.ts";
import {
  taskProcessAccessToken,
  taskProcessCookie,
  taskProcessFreePort,
} from "./installed-plugin-tasks-process-authorities.test-support.ts";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const uiRequire = createRequire(
  join(repository, "apps/crewon-ui/package.json"),
);
const STAGE_PREFIX = "CREWON_SHORT_DRAMA_RECOVERY_STAGE:";
const PROOF_PREFIX = "CREWON_SHORT_DRAMA_RECOVERY_PROOF:";
export const shortDramaRecoveryIdentity = Object.freeze({
  pluginId: "crewon.short-drama",
  publisherId: "example.publisher",
  version: "9.0.0",
  packageDigest:
    "sha256:981c3bcdb7fc9c47186118a482bb1d8ec3dd1d4f95d3a09139f7a104dfba2334",
});
export type RecoveryBrowserPhase = "cold" | "selection-submit" | "cold-retry";
export type RecoveryBrowserStage = "module-ready" | "selection-submitted";
export type RecoveryBrowserRequest = Readonly<{
  id: number;
  method: string;
  path: string;
  resourceType: string;
  status: number | null;
  startedAt: number;
  headersAt: number | null;
  kind: "mutation" | "stage" | "read" | "other";
  action: string | null;
  input: unknown;
}>;
export type RecoveryBrowserProof = Readonly<{
  phase: RecoveryBrowserPhase;
  nativeBridge: false;
  authGateLogin: true;
  originalAccountMenu: true;
  settings: Readonly<{
    navigation: readonly string[];
    styles: Readonly<Record<string, string>>;
  }>;
  screenshots: readonly string[];
  recovery: PluginUiRecoveryHintsResponse;
  recoveryResponseAt: number;
  moduleReadyObservedAt: number;
  requests: readonly RecoveryBrowserRequest[];
  selectionReceipt: SelectConceptImageResponse | null;
  currentSelection: GetConceptSelectionResponse | null;
  stageAck: StagePluginUiRecoveryResponse | null;
  selectionStageResponseAt: number | null;
  selectionActionStartedAt: number | null;
}>;
type OwnedBrowser = Readonly<{
  child: ChildProcess;
  completion: Promise<
    Readonly<{ code: number | null; signal: NodeJS.Signals | null }>
  >;
  output(): string;
  finished(): boolean;
}>;
type MainSession = Awaited<
  ReturnType<Awaited<ReturnType<typeof recoveryMainFixture>>["start"]>
>;
export const browserBusinessWrites = (proof: RecoveryBrowserProof) =>
  proof.requests.filter(
    (request) =>
      request.method === "POST" &&
      request.path.endsWith("/actions") &&
      request.kind === "mutation" &&
      Object.values(mainRecoveryActions).some(
        (action) => action === request.action,
      ),
  );

/** Unchanged formal Web artifacts and original Main/BFF. Funding, paid history and output
 * images come only from the existing explicitly named seed; no Worker is started. */
export async function shortDramaRecoveryFullAppFixture(t: TestContext) {
  const packageDirectory =
    process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY;
  const driverPath = process.env.CREWON_RECOVERY_BROWSER_DRIVER_PATH;
  assert.ok(
    packageDirectory,
    "an actual released short-drama 9 package is required",
  );
  assert.ok(driverPath, "Root must compile the isolated Chromium driver first");
  const driver = await realpath(driverPath);
  await readFile(driver);
  const evidenceDirectory = join(
    repository,
    "output/extensions/checks/plugin-ui-recovery-full-app-ui9-browser-20261004",
  );
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const finalizers: (() => unknown | Promise<unknown>)[] = [];
  const mains: MainSession[] = [];
  const bffs: ReturnType<typeof startFullAppProcess>[] = [];
  const browsers = new Set<OwnedBrowser>();
  let edge: Awaited<ReturnType<typeof createFullAppEdge>> | null = null;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    const operations = [
      ...[...browsers].map((browser) => () => retireBrowser(browser)),
      ...[...bffs].reverse().map((child) => () => stopFullAppProcess(child)),
      ...[...mains].reverse().map((session) => () => session.stop()),
      ...(edge === null ? [] : [() => edge!.close()]),
      ...finalizers,
    ];
    for (const operation of operations) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "full_app_recovery_cleanup_failed");
  };
  t.after(close);
  // TestContext cleanup is deferred; no production UI/session/authorization context is replaced.
  const deferred = new Proxy(t, {
    get(target, key) {
      if (key === "after")
        return (finalize: () => unknown | Promise<unknown>) =>
          finalizers.push(finalize);
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  edge = await createFullAppEdge(join(repository, "apps/crewon-ui/dist"));
  const browserEdge = edge;
  const main = await recoveryMainFixture(deferred, {
    installationManagement: true,
    originalAppCatalog: true,
    sourcePackageDirectory: await realpath(packageDirectory),
    browserOrigin: browserEdge.origin,
    sessionCookie: taskProcessCookie,
    accessToken: taskProcessAccessToken,
  });
  for (const [field, expected] of Object.entries(shortDramaRecoveryIdentity))
    assert.equal(
      field === "packageDigest"
        ? main.source.packageDigest
        : main.source.descriptor[
            field as "pluginId" | "publisherId" | "version"
          ],
      expected,
    );
  assert.equal(main.source.descriptor.entrypoints.node, null);
  assert.equal(main.contribution.id, "workbench");
  assert.ok(main.publicAssets.includes("ui.mjs"));
  assert.ok(main.publicAssets.some((path) => path.startsWith("assets/")));
  assert.ok(main.sessionAuthorityUrl);
  const start = async () => {
    const session = await main.start();
    mains.push(session);
    const bffPort = await taskProcessFreePort();
    const bff = startFullAppProcess("bff", {
      ...cleanEnvironment(),
      NODE_EXTRA_CA_CERTS: main.caPath,
      NODE_TLS_REJECT_UNAUTHORIZED: "1",
      NODE_OPTIONS: "--dns-result-order=ipv4first",
      CREWON_WEB_PUBLIC_ORIGIN: browserEdge.origin,
      CREWON_CONTROL_TARGET: `http://127.0.0.1:${session.port}`,
      CREWON_CONTROL_BFF_TOKEN: main.bffToken,
      CREWON_CONTROL_CSRF_TOKEN:
        "named-main-web-control-csrf-" + "c".repeat(32),
      CREWON_WEB_CSRF_SECRET: "named-main-web-browser-csrf-" + "s".repeat(32),
      CREWON_IDENTITY_SESSION_URL: main.sessionAuthorityUrl,
      CREWON_IDENTITY_SERVICE_TOKEN: main.sessionAuthorityToken,
      CREWON_IDENTITY_TIMEOUT_MS: "10000",
      CREWON_WEB_BFF_PORT: String(bffPort),
    });
    bffs.push(bff);
    await waitTaskProcess(
      "actual original full Web recovery BFF",
      async () => bff.stdout().includes("CrewON Web BFF listening"),
      [session.child, bff],
    );
    browserEdge.target(`http://127.0.0.1:${bffPort}`);
    return {
      ...session,
      bff,
      bffPort,
      async stop() {
        await stopFullAppProcess(bff);
        assert.equal(await fullAppPortClosed(bffPort), true);
        await session.stop();
      },
    };
  };
  const runBrowser = async (
    phase: RecoveryBrowserPhase,
    options: Readonly<{
      expectedSelection: null | Readonly<{
        selectionRevision: number;
        resultIndex: number;
        filename: string;
      }>;
      checkpoint(stage: RecoveryBrowserStage): Promise<void>;
    }>,
  ): Promise<RecoveryBrowserProof> => {
    const checkpointDirectory = join(main.files.root, `checkpoints-${phase}`);
    await mkdir(checkpointDirectory, { mode: 0o700 });
    const inputPath = join(main.files.root, `browser-${phase}.json`);
    await writeFile(
      inputPath,
      JSON.stringify({
        origin: browserEdge.origin,
        certificateFingerprint: browserEdge.certificateFingerprint,
        login: fullAppLogin,
        packageIdentity: shortDramaRecoveryIdentity,
        contributionId: main.contribution.id,
        phase,
        stagedRequests: main.requests,
        expectedSelection: options.expectedSelection,
        evidenceDirectory,
        checkpointDirectory,
        userData: join(main.files.root, `browser-profile-${phase}`),
      }),
      { mode: 0o600 },
    );
    const owned = browserChild(
      String(uiRequire("electron")),
      [driver, inputPath],
      { ...cleanEnvironment(), NODE_EXTRA_CA_CERTS: main.caPath },
    );
    browsers.add(owned);
    const descendants = trackDesktopTestChildren(owned.child);
    let bodyFailure: unknown;
    try {
      const stages: RecoveryBrowserStage[] =
        phase === "cold"
          ? ["module-ready"]
          : ["module-ready", "selection-submitted"];
      for (const stage of stages) {
        await waitForCheckpoint(owned, phase, stage);
        await options.checkpoint(stage);
        await writeFile(
          join(checkpointDirectory, `${stage}.continue`),
          "checked\n",
          {
            mode: 0o600,
          },
        );
      }
      const result = await terminal(owned, 120_000);
      assert.equal(result.code, 0, owned.output());
      assert.equal(result.signal, null, owned.output());
      const line = owned
        .output()
        .split("\n")
        .find((value) => value.startsWith(PROOF_PREFIX));
      assert.ok(line, owned.output());
      const proof = checkedBrowserProof(
        JSON.parse(line.slice(PROOF_PREFIX.length)),
        phase,
        main.selectionRequest,
      );
      await writeFile(
        join(evidenceDirectory, `${phase}-parent-verified.json`),
        JSON.stringify(proof, null, 2) + "\n",
        { mode: 0o600 },
      );
      return proof;
    } catch (error) {
      bodyFailure = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        await retireBrowser(owned);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        assert.deepEqual(
          await descendants.close(),
          [],
          "all owned Chromium descendants retired",
        );
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        browsers.delete(owned);
      }
      if (cleanupErrors.length)
        throw new AggregateError(
          [
            ...(bodyFailure === undefined ? [] : [bodyFailure]),
            ...cleanupErrors,
          ],
          "full_app_browser_cleanup_failed",
        );
    }
  };
  return {
    main,
    start,
    runBrowser,
    close,
    evidenceDirectory,
    staticProof: browserEdge.staticProof,
    edgeRequests: browserEdge.requests,
    edgeFailures: browserEdge.failures,
    cleanupProof: () => ({
      closed,
      activeBrowsers: browsers.size,
      mainProcesses: mains.map(({ child }) => ({
        pid: child.child.pid,
        finished: child.finished(),
      })),
      bffProcesses: bffs.map((child) => ({
        pid: child.child.pid,
        finished: child.finished(),
      })),
    }),
  };
}

function checkedBrowserProof(
  input: unknown,
  phase: RecoveryBrowserPhase,
  selectionRequest: PluginUiRecoveryRequest,
): RecoveryBrowserProof {
  const value = proofObject(input);
  assert.equal(value.phase, phase);
  assert.equal(value.nativeBridge, false);
  assert.equal(value.authGateLogin, true);
  assert.equal(value.originalAccountMenu, true);
  assert.ok(Array.isArray(value.requests) && value.requests.length <= 1024);
  assert.ok(Array.isArray(value.screenshots));
  const settings = proofObject(value.settings);
  assert.ok(Array.isArray(settings.navigation));
  const styles = proofObject(settings.styles);
  const recoveryResponseAt = proofTime(value.recoveryResponseAt),
    moduleReadyObservedAt = proofTime(value.moduleReadyObservedAt);
  assert.ok(recoveryResponseAt <= moduleReadyObservedAt);
  const selected = phase !== "cold";
  return {
    phase,
    nativeBridge: false,
    authGateLogin: true,
    originalAccountMenu: true,
    settings: {
      navigation: settings.navigation.map(proofString),
      styles: Object.fromEntries(
        Object.entries(styles).map(([name, style]) => [
          name,
          proofString(style),
        ]),
      ),
    },
    screenshots: value.screenshots.map(proofString),
    requests: value.requests.map(checkedBrowserRequest),
    recovery: parsePluginUiRecoveryHintsResponse(value.recovery),
    recoveryResponseAt,
    moduleReadyObservedAt,
    selectionReceipt:
      value.selectionReceipt === null
        ? null
        : parseSelectConceptImageResponse(value.selectionReceipt),
    currentSelection:
      value.currentSelection === null
        ? null
        : parseGetConceptSelectionResponse(value.currentSelection),
    stageAck: selected
      ? parseStagePluginUiRecoveryResponse(value.stageAck, selectionRequest)
      : null,
    selectionStageResponseAt: selected
      ? proofTime(value.selectionStageResponseAt)
      : null,
    selectionActionStartedAt: selected
      ? proofTime(value.selectionActionStartedAt)
      : null,
  };
}
function checkedBrowserRequest(input: unknown): RecoveryBrowserRequest {
  const value = proofObject(input);
  assert.ok(Number.isInteger(value.id) && Number(value.id) >= 0);
  assert.ok(
    value.status === null ||
      (Number.isInteger(value.status) &&
        Number(value.status) >= 100 &&
        Number(value.status) <= 599),
  );
  assert.ok(value.action === null || typeof value.action === "string");
  const kind = value.kind;
  assert.ok(
    kind === "mutation" ||
      kind === "stage" ||
      kind === "read" ||
      kind === "other",
  );
  return {
    id: Number(value.id),
    method: proofString(value.method),
    path: proofString(value.path),
    resourceType: proofString(value.resourceType),
    status: value.status === null ? null : Number(value.status),
    startedAt: proofTime(value.startedAt),
    headersAt: value.headersAt === null ? null : proofTime(value.headersAt),
    kind,
    action: value.action,
    input: value.input,
  };
}
function proofObject(input: unknown): Record<string, unknown> {
  assert.ok(
    input !== null && typeof input === "object" && !Array.isArray(input),
  );
  return Object.fromEntries(Object.entries(input));
}
function proofString(input: unknown): string {
  assert.equal(typeof input, "string");
  assert.ok(typeof input === "string");
  return input;
}
function proofTime(input: unknown): number {
  assert.ok(
    typeof input === "number" && Number.isSafeInteger(input) && input > 0,
  );
  return input;
}
function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith("CREWON_") &&
        ![
          "ELECTRON_RUN_AS_NODE",
          "NODE_OPTIONS",
          "NODE_EXTRA_CA_CERTS",
          "AICUICAN_API_KEY",
        ].includes(name),
    ),
  );
}
function browserChild(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): OwnedBrowser {
  const child = spawn(command, [...args], {
    cwd: repository,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    finished = false;
  const append = (bytes: Buffer) => {
    output += bytes.toString("utf8");
    if (Buffer.byteLength(output) > 512 * 1024) child.kill("SIGKILL");
  };
  child.stdout!.on("data", append);
  child.stderr!.on("data", append);
  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((accept, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      finished = true;
      accept({ code, signal });
    });
  });
  void completion.catch(() => {});
  return { child, completion, output: () => output, finished: () => finished };
}
async function waitForCheckpoint(
  owned: OwnedBrowser,
  phase: RecoveryBrowserPhase,
  stage: RecoveryBrowserStage,
) {
  const deadline = Date.now() + 90_000;
  while (true) {
    const checkpoints = owned
      .output()
      .split("\n")
      .slice(0, -1)
      .filter((line) => line.startsWith(STAGE_PREFIX))
      .map((line) => JSON.parse(line.slice(STAGE_PREFIX.length)));
    if (
      checkpoints.some(
        (value) => value.phase === phase && value.stage === stage,
      )
    )
      return;
    assert.ok(!owned.finished(), owned.output());
    assert.ok(
      Date.now() < deadline,
      `recovery_browser_checkpoint_timeout:${phase}:${stage}:${owned.output()}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function terminal(owned: OwnedBrowser, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      owned.completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("recovery_browser_timeout:" + owned.output())),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function retireBrowser(owned: OwnedBrowser) {
  if (!owned.finished()) owned.child.kill("SIGTERM");
  try {
    await terminal(owned, 15_000);
  } catch (error) {
    if (!owned.finished()) owned.child.kill("SIGKILL");
    await owned.completion.catch(() => {});
    throw error;
  }
}
