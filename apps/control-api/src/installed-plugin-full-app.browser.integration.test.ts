import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { trackDesktopTestChildren } from "../../crewon-ui/electron/desktopPluginTestChildren.test-support.ts";
import { installedReleaseProcessPackagesMissing } from "../../runtime-worker/src/installed-plugin-release-process.test-support.ts";
import { installedPluginFullAppFixture } from "./installed-plugin-full-app.test-support.ts";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const uiRoot = join(repository, "apps/crewon-ui");
const uiRequire = createRequire(join(uiRoot, "package.json"));
const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
const packagesUnconfigured =
  process.env.CREWON_TEST_BUSINESS_PLUGIN_V1_DIR === undefined &&
  process.env.CREWON_TEST_BUSINESS_PLUGIN_V2_DIR === undefined &&
  installedReleaseProcessPackagesMissing;
type Fixture = Awaited<ReturnType<typeof installedPluginFullAppFixture>>;
type Receipt = Readonly<{
  disposition: "committed" | "replayed";
  threadId: string;
  threadRevision: number;
  runId: string;
  messageId: string;
  configurationRevision: number;
}>;
type BrowserProof = Readonly<{
  acceptance: string;
  phase: "execute" | "reopen";
  nativeBridge: boolean;
  authGateLogin: boolean;
  originalAccountMenu: boolean;
  receipt: Receipt;
  transcript: string;
  entry: string;
  requests: readonly Readonly<{
    id: number;
    method: string;
    path: string;
    resourceType: string;
    status: number | null;
    eventStream: boolean;
  }>[];
}>;

test(
  "unchanged production Web index/AuthGate/App opens original account settings and installed professional module, explicitly creates one Thread, executes the actual package through BFF/Control/Worker/PG, displays its original SSE transcript, and recovers after cold browser/Control/Worker reopen",
  {
    skip:
      !connectionString || packagesUnconfigured
        ? "actual outside-built Report v1/v2 and Root-owned PostgreSQL URL are required"
        : false,
    timeout: 360_000,
  },
  async (t) => {
    const evidenceDirectory = resolve(
      process.env.CREWON_FULL_APP_EVIDENCE_DIRECTORY ??
        join(
          repository,
          "output/extensions/checks/installed-plugin-full-app-browser",
        ),
    );
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(tmpdir(), "crewon-full-app-browser-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const fixture = await installedPluginFullAppFixture(t, {
      connectionString: connectionString!,
      uiDirectory: join(uiRoot, "dist"),
    });
    const launcher = join(directory, "browser-launcher.mjs");
    const esbuild = await import(uiRequire.resolve("esbuild"));
    await esbuild.build({
      entryPoints: [
        join(
          uiRoot,
          "electron/installedPluginFullApp.browser-driver.test-support.ts",
        ),
      ],
      outfile: launcher,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      external: ["electron"],
      logLevel: "silent",
    });
    const checkpoints: Record<string, unknown> = {};
    try {
      const first = await runBrowser({
        fixture,
        launcher,
        directory,
        evidenceDirectory,
        phase: "execute",
        onCheckpoint: async (stage) => {
          const facts = await fixture.storeFacts();
          assert.equal(facts.runs.length, 0, stage);
          assert.equal(
            facts.threads.length,
            stage === "module-open" ? 0 : 1,
            stage,
          );
          assert.equal(facts.admissions.length, 0, stage);
          assert.equal(facts.creditHolds.length, 0, stage);
          assert.equal(fixture.supplierRequests().length, 0, stage);
          assert.equal(fixture.modelRequests().length, 0, stage);
          checkpoints[stage] = facts;
        },
      });
      checkBrowserProof(first, fixture);
      assert.equal(first.receipt.disposition, "committed");
      assert.equal(
        first.receipt.configurationRevision,
        fixture.configurationRevision,
      );
      const creates = first.requests.filter(
        (request) =>
          request.method === "POST" && request.path === "/api/v1/threads",
      );
      assert.equal(creates.length, 1);
      assert.ok(creates[0]!.status !== null && creates[0]!.status! < 300);
      assert.equal(
        first.requests.filter(
          (request) =>
            request.method === "POST" &&
            /^\/api\/v1\/plugins\/ui\/mounts\/[^/]+\/actions$/u.test(
              request.path,
            ),
        ).length,
        1,
      );
      const completed = await fixture.waitForRun(first.receipt.runId);
      const executedFacts = await fixture.storeFacts();
      assert.equal(executedFacts.threads.length, 1);
      assert.equal(executedFacts.runs.length, 1);
      assert.equal(executedFacts.runs[0]!.runId, first.receipt.runId);
      assert.equal(executedFacts.runs[0]!.status, "completed");
      assert.equal(executedFacts.admissions.length, 1);
      const admission = executedFacts.admissions[0]!;
      assert.equal(admission.runId, first.receipt.runId);
      assert.equal(admission.threadId, first.receipt.threadId);
      assert.equal(admission.pluginId, fixture.packageIdentity.pluginId);
      assert.equal(admission.publisherId, fixture.packageIdentity.publisherId);
      assert.equal(admission.version, fixture.packageIdentity.version);
      assert.equal(
        admission.packageDigest,
        fixture.packageIdentity.packageDigest,
      );
      assert.equal(admission.principalId, fixture.actor.principalId);
      assert.equal(admission.actorId, fixture.actor.actorId);
      assert.equal(admission.profileId, fixture.scope.profileId);
      assert.equal(admission.contributionId, "studio");
      assert.equal(admission.action, "report.generate");
      assert.equal(executedFacts.bindings.length, 1);
      assert.equal(
        executedFacts.bindings[0]!.configurationRevision,
        fixture.configurationRevision,
      );
      assert.equal(executedFacts.bindings[0]!.source, null);
      assert.equal(executedFacts.creditAdmissions.length, 1);
      assert.equal(
        executedFacts.creditAdmissions[0]!.reservation.quotedCredits,
        "30",
      );
      assert.equal(executedFacts.creditHolds.length, 1);
      assert.equal(executedFacts.creditAccount?.reservedCredits, "30");
      assert.equal(executedFacts.settlementExecuted, false);
      assert.equal(executedFacts.operations.length, 0);
      assert.equal(executedFacts.toolReceipts.length, 1);
      assert.ok(executedFacts.events.length > 0);
      assert.ok(
        JSON.stringify(executedFacts.transcript).includes(
          fixture.expectedTranscriptText,
        ),
      );
      assert.equal(
        fixture
          .supplierRequests()
          .filter((request) => request.method === "POST").length,
        1,
      );
      await fixture.reopenControl();
      await fixture.reopenWorker();
      const reopened = await runBrowser({
        fixture,
        launcher,
        directory,
        evidenceDirectory,
        phase: "reopen",
        receipt: first.receipt,
      });
      checkBrowserProof(reopened, fixture);
      assert.deepEqual(reopened.receipt, first.receipt);
      assert.equal(
        reopened.requests.filter(
          (request) =>
            request.method === "POST" && request.path === "/api/v1/threads",
        ).length,
        0,
      );
      assert.equal(
        reopened.requests.filter(
          (request) =>
            request.method === "POST" && request.path.endsWith("/actions"),
        ).length,
        0,
      );
      const restoredFacts = await fixture.storeFacts();
      assert.equal(restoredFacts.threads.length, 1);
      assert.equal(restoredFacts.runs.length, 1);
      assert.deepEqual(restoredFacts.admissions, executedFacts.admissions);
      assert.deepEqual(restoredFacts.bindings, executedFacts.bindings);
      assert.deepEqual(
        restoredFacts.creditAdmissions,
        executedFacts.creditAdmissions,
      );
      assert.deepEqual(restoredFacts.creditHolds, executedFacts.creditHolds);
      assert.deepEqual(restoredFacts.operations, executedFacts.operations);
      assert.deepEqual(restoredFacts.transcript, executedFacts.transcript);
      assert.equal(
        fixture
          .supplierRequests()
          .filter((request) => request.method === "POST").length,
        1,
      );
      const supplierRequests = fixture.supplierRequests();
      const modelRequests = fixture.modelRequests();
      assert.equal(modelRequests.length, 2);
      assert.deepEqual(fixture.edgeFailures(), []);
      const browserRequests = fixture.browserRequests();
      const authorityRequests = fixture.authorityRequests();
      await fixture.close();
      const cleanup = await fixture.cleanupProof();
      await writeFile(
        join(evidenceDirectory, "full-app-integration-proof.json"),
        JSON.stringify(
          {
            scope:
              "Unchanged production Web index → main.tsx → AgentPlatformAuthGate → App; actual BFF/Control/Worker and PostgreSQL",
            packageIdentity: fixture.packageIdentity,
            configurationRevision: fixture.configurationRevision,
            staticProof: fixture.staticProof,
            fixtureAuthorities: [
              "identity",
              "profile",
              "policy",
              "model Responses",
              "personal wallet/price quote",
              "professional report supplier",
            ],
            checkpoints,
            first,
            completed,
            executedFacts,
            reopened,
            restoredFacts,
            supplierRequests,
            modelRequests,
            browserRequests,
            authorityRequests,
            cleanup,
            excludedClaims: [
              "formal Native Main/preload",
              "packaged.app",
              "online enterprise login",
              "online model or supplier",
              "real personal payment/settlement",
              "tasks@1 query action",
            ],
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
    } finally {
      await fixture.close();
    }
  },
);

function checkBrowserProof(proof: BrowserProof, fixture: Fixture) {
  assert.equal(proof.acceptance, "unchanged-production-Web-full-App");
  assert.equal(proof.nativeBridge, false);
  assert.equal(proof.authGateLogin, true);
  assert.equal(proof.originalAccountMenu, true);
  assert.match(proof.entry, /assets\/index-[^/]+\.js$/u);
  assert.ok(proof.transcript.includes(fixture.expectedTranscriptText));
  for (const path of [
    "/agent-platform-api/api/v1/auth/login",
    "/agent-platform-api/api/v1/auth/me",
    "/control-api/session",
    "/api/v1/agent-versions/active",
    "/api/v1/thread-catalog",
    "/api/v1/plugins/ui/catalog",
  ])
    assert.ok(
      proof.requests.some(
        (request) => request.path === path && request.status === 200,
      ),
      path,
    );
  assert.ok(
    proof.requests.some(
      (request) =>
        /^\/api\/v1\/plugins\/ui\/mounts\/[^/]+\/assets\//u.test(
          request.path,
        ) && request.status === 200,
    ),
  );
  assert.ok(
    proof.requests.some(
      (request) => request.eventStream && request.status === 200,
    ),
  );
  if (proof.phase === "execute")
    assert.ok(
      proof.requests.some(
        (request) =>
          request.eventStream &&
          request.status === 200 &&
          request.path ===
            `/api/v1/runs/${encodeURIComponent(proof.receipt.runId)}/events`,
      ),
      "the actual accepted Run opens its original stream",
    );
  assert.ok(
    proof.requests.some(
      (request) =>
        request.eventStream &&
        request.status === 200 &&
        request.path ===
          `/api/v1/threads/${encodeURIComponent(proof.receipt.threadId)}/events`,
    ),
    "the selected task opens its original Thread stream",
  );
}

async function runBrowser(
  options: Readonly<{
    fixture: Fixture;
    launcher: string;
    directory: string;
    evidenceDirectory: string;
    phase: "execute" | "reopen";
    receipt?: Receipt;
    onCheckpoint?(stage: "module-open" | "thread-ready"): Promise<void>;
  }>,
): Promise<BrowserProof> {
  const { fixture, phase } = options;
  const checkpointDirectory = join(options.directory, "checkpoints-" + phase);
  await mkdir(checkpointDirectory, { mode: 0o700 });
  const inputPath = join(options.directory, "browser-" + phase + ".json");
  await writeFile(
    inputPath,
    JSON.stringify({
      origin: fixture.browser.origin,
      certificateFingerprint: fixture.browser.certificateFingerprint,
      login: fixture.login,
      packageIdentity: fixture.packageIdentity,
      contributionId: "studio",
      configurationValue: fixture.configurationValue.organization,
      configurationRevision: fixture.configurationRevision,
      reportSubject: fixture.reportSubject,
      expectedTranscriptText: fixture.expectedTranscriptText,
      phase,
      ...(options.receipt ? { receipt: options.receipt } : {}),
      evidenceDirectory: options.evidenceDirectory,
      checkpointDirectory,
      userData: join(options.directory, "browser-profile-" + phase),
    }),
    { mode: 0o600 },
  );
  const owned = browserChild(
    String(uiRequire("electron")),
    [options.launcher, inputPath],
    {
      ...cleanEnvironment(),
      NODE_EXTRA_CA_CERTS: fixture.browser.caPath,
    },
  );
  const descendants = trackDesktopTestChildren(owned.child);
  try {
    if (phase === "execute") {
      for (const stage of ["module-open", "thread-ready"] as const) {
        await waitForOutput(
          owned,
          'CREWON_FULL_APP_STAGE:{"stage":"' + stage + '"}',
        );
        assert.ok(options.onCheckpoint);
        await options.onCheckpoint(stage);
        await writeFile(
          join(checkpointDirectory, stage + ".continue"),
          "checked\n",
          { mode: 0o600 },
        );
      }
    }
    const result = await terminal(owned, 180_000);
    assert.equal(result.code, 0, owned.output());
    assert.equal(result.signal, null, owned.output());
    const match = /CREWON_FULL_APP_PROOF:(.+)/u.exec(owned.output());
    assert.ok(match, owned.output());
    return JSON.parse(match[1]!) as BrowserProof;
  } finally {
    if (!owned.finished()) owned.child.kill("SIGKILL");
    await owned.completion;
    assert.deepEqual(
      await descendants.close(),
      [],
      "owned Chromium children physically retired",
    );
  }
}

type Child = Readonly<{
  child: ChildProcess;
  completion: Promise<
    Readonly<{ code: number | null; signal: NodeJS.Signals | null }>
  >;
  output(): string;
  finished(): boolean;
}>;
function browserChild(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Child {
  const child = spawn(command, [...args], {
    cwd: repository,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    finished = false;
  const append = (value: Buffer) => {
    output += value.toString("utf8");
    if (output.length > 512 * 1024) child.kill("SIGKILL");
  };
  child.stdout!.on("data", append);
  child.stderr!.on("data", append);
  const completion = new Promise<
    Readonly<{ code: number | null; signal: NodeJS.Signals | null }>
  >((accept, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      finished = true;
      accept({ code, signal });
    });
  });
  void completion.catch(() => {});
  return { child, completion, output: () => output, finished: () => finished };
}
async function waitForOutput(owned: Child, expected: string) {
  const until = Date.now() + 90_000;
  while (!owned.output().includes(expected)) {
    assert.ok(!owned.finished(), owned.output());
    assert.ok(
      Date.now() < until,
      "full_app_browser_checkpoint_timeout:" + owned.output(),
    );
    await new Promise((done) => setTimeout(done, 20));
  }
}
async function terminal(owned: Child, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      owned.completion,
      new Promise<never>((_accept, reject) => {
        timer = setTimeout(() => {
          owned.child.kill("SIGKILL");
          reject(
            new Error("full_app_browser_process_timeout:" + owned.output()),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment))
    if (
      name.startsWith("CREWON_") ||
      [
        "ELECTRON_RUN_AS_NODE",
        "NODE_OPTIONS",
        "NODE_EXTRA_CA_CERTS",
        "AICUICAN_API_KEY",
      ].includes(name)
    )
      delete environment[name];
  return environment;
}
