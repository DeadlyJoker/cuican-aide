import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DirectResponsesTransport } from "../packages/agent-responses/src/index.ts";
import { compileAgentVersion, createAgentVersionAsset } from "../packages/agent-version/src/index.ts";
import { ControlApiClient, streamRunEvents } from "../packages/control-client/src/index.ts";
import { SqliteRunStore } from "../packages/store/src/index.ts";

import { activateStandaloneRuntimeAgentVersionRelease } from "../apps/runtime-worker/src/agent-version-release-composition.ts";
import { loadAgentVersionRuntimeFactory } from "../apps/runtime-worker/src/runtime-binding-config.ts";
import { findOwnedPackagedWindowsProcesses } from "./windows-packaged-processes.mjs";

const repo = resolve(import.meta.dirname, "..");
const smokeMode = process.env.CREWON_PACKAGED_SMOKE_MODE === "launch" ? "launch" : "workflow";
const appBinary = process.env.CREWON_PACKAGED_APP_BINARY?.trim() ||
  join(repo, "apps/crewon-ui/src-tauri/target/release/bundle/macos/Crewon.app/Contents/MacOS/crewon-ui");
const installRoot = process.env.CREWON_PACKAGED_INSTALL_ROOT?.trim() ?? null;
const home = mkdtempSync(join(tmpdir(), "crewon-slice7-app-"));
const localData = process.platform === "win32"
  ? join(home, "AppData", "Local")
  : join(home, "Library", "Application Support");
const runtimeRoot = join(localData, "ai.crewon.desktop", "control-runtime-v0");
const databasePath = join(runtimeRoot, "control.sqlite");
const bindingsPath = join(home, "runtime-bindings.json");
const samples: Array<{ body: string }> = [];
const provider = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    samples.push({ body });
    process.stderr.write(`slice7_provider_request:${request.method}:${request.url}:` +
      `${digester.sha256(body)}\n`);
    const id = `resp-${samples.length}`;
    const events = [
      { type: "response.created", sequence_number: 0, response: { id } },
      { type: "response.output_text.delta", sequence_number: 1, delta: "{}" },
      { type: "response.output_item.done", sequence_number: 2, item: {
        type: "message", role: "assistant",
        content: [{ type: "output_text", text: "{}" }],
      } },
      { type: "response.completed", sequence_number: 3, response: {
        id, status: "completed", output: [{ type: "message",
          role: "assistant", content: [{ type: "output_text", text: "{}" }] }],
        usage: { input_tokens: 4, input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1, total_tokens: 5 },
      } },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const address = provider.address();
assert.ok(address && typeof address === "object");
const providerBase = `http://127.0.0.1:${address.port}/v1`;
const responsesEndpoint = `${providerBase}/responses`;

mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
const digester = { sha256: (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}` };
const sources = [agentSource("workflow-agent"), agentSource("workflow-verifier")];
const versions = sources.map((source) => compileAgentVersion(source, digester));
writeFileSync(bindingsPath, JSON.stringify({
  schemaVersion: "crewon.agent-version-runtime-bindings.v0",
  bindings: versions.slice(1).map((version) => ({
    tenantId: "standalone-tenant", agentVersionId: version.agentVersionId,
    contentDigest: version.contentDigest, authorityId: `authority-${version.agentVersionId}`,
    workspaceBindingId: null, provider: { kind: "directResponses", endpoint: responsesEndpoint,
      apiKeyEnvironment: null, storeResponses: true,
      idleTimeoutMs: 10_000, sequencePolicy: "required" },
    mcpStdioConfigPath: null, remoteMcpConfigPath: null,
  })),
}));
const store = new SqliteRunStore(databasePath, { workflowDigester: digester });
for (const version of versions.slice(1)) await store.registerAgentVersion(createAgentVersionAsset({
  tenantId: "standalone-tenant", version, createdAt: new Date().toISOString(),
}));
const runtimeFactory = loadAgentVersionRuntimeFactory(bindingsPath, process.env);
const route = { authorityId: "standalone-authority", runtimeGeneration: "ts-v0",
  agentVersionId: "workflow-agent", policySnapshotId: "standalone-policy-v0",
  workspaceBindingId: null };
await activateStandaloneRuntimeAgentVersionRelease({
  databasePath, runtimeTenantId: "standalone-tenant", route,
  transport: new DirectResponsesTransport({ endpoint: responsesEndpoint, model: "slice7-model", storeResponses: true }),
  agentVersionDeployments: runtimeFactory.deploymentBindings("standalone-tenant"),
  actor: { principalId: "release-principal", actorId: "release-actor",
    tenantId: "standalone-tenant", spaceId: "standalone-space" },
  authorization: { authorize: async () => ({ outcome: "allow" }) },
  clock: { now: () => new Date().toISOString() }, activationId: "slice7-seed-release",
});
await store.close();
writeFileSync(join(runtimeRoot, "provider-credentials.v1.json"), JSON.stringify({
  schemaVersion: "crewon.provider-credential-catalog.v1",
  activeProviderId: "slice7", activeRuntimeBindingId: "slice7-runtime",
  bindings: { slice7: { providerId: "slice7", endpoint: providerBase,
    credentialKind: "none", environmentVariable: null } },
}), { mode: 0o600 });

const appEnvironment = { ...process.env, HOME: home, USERPROFILE: home,
  LOCALAPPDATA: localData, APPDATA: join(home, "AppData", "Roaming"),
  LANG: process.env.LANG ?? "en_US.UTF-8", USER: process.env.USER ?? "slice7",
  LOGNAME: process.env.LOGNAME ?? "slice7",
  CREWON_MODEL_ID: "slice7-model", CREWON_AGENT_VERSION_ID: "workflow-agent",
  CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH: bindingsPath,
  CREWON_RESPONSES_STORE: "true",
  CREWON_WORKER_SCAN_INTERVAL_MS: "5000" };
let app = startApp();
try {
  if (smokeMode === "launch") {
    await waitFor(() => portOpen(3210) || null);
    assert.equal(portOpen(6176), false);
    app.kill("SIGKILL");
    await waitForExit(app);
    await waitFor(() => launchCleanupComplete() || null);
    console.log(JSON.stringify({ home, launch: true, guardianCleanup: true,
      controlPort: 3210, removedAppServerPortClosed: true,
      packagedProcessCleanup: process.platform === "win32" }));
  } else {
    const authority = await waitForControlAuthority();
    await waitFor(() => portOpen(3210) || null);
  const client = controlClient(authority);
  const thread = await post(authority, "/api/v1/threads", "slice7-thread", { title: "Slice 7" });
  await post(authority, "/api/v1/workflow-versions", "slice7-workflow-publish", workflow());
  const startInput = { workflowVersionId: "slice7-workflow-v1",
    threadId: thread.thread.threadId, input: {} };
  const started = await client.startWorkflowRun(startInput, "slice7-workflow-start");
  const runId = started.run.runId as string;
  const replayed = await client.startWorkflowRun(startInput, "slice7-workflow-start");
  assert.equal(started.disposition, "committed");
  assert.equal(replayed.disposition, "replayed");
  assert.equal(replayed.run.runId, runId);
  assert.deepEqual(workflowAdmissionEvidence(runId), { receipts: 1, runs: 1 });
  assert.equal((await client.getRun(runId)).run.runId, runId);
  await waitFor(() => completedAttemptCount(runId) === 1 && samples.length === 1);
  const gate = await waitFor(async () => {
    const publications = await client.listWorkflowHumanGates(runId);
    return publications.data.length === 1 ? publications.data[0]! : null;
  });
  const gateDecision = { runId, nodeId: gate.nodeId, claimId: gate.claimId,
    claimEpoch: gate.claimEpoch, gateRequestId: gate.gateRequestId,
    decision: "approve" as const };
  const decided = await client.decideWorkflowHumanGate(
    gateDecision, "slice7-gate-decision");
  assert.equal(decided.disposition, "recorded");
  const workerPidsBeforeKill = workerPids();
  assert.ok(workerPidsBeforeKill.length > 0);
  for (const pid of workerPidsBeforeKill) process.kill(pid, "SIGKILL");
  await waitFor(() => managedPids().length === 0 && !portOpen(3210));
  app.kill("SIGKILL");
  await waitForExit(app);
  await waitFor(() => managedPids().length === 0 && !portOpen(3210));
  assert.equal(samples.length, 1);

  app = startApp();
  const restartedAuthority = await waitForControlAuthority();
  await waitFor(() => portOpen(3210) || null);
  const restartedClient = controlClient(restartedAuthority);
  const replayedDecision = await restartedClient.decideWorkflowHumanGate(
    gateDecision, "slice7-gate-decision");
  assert.equal(replayedDecision.disposition, "replay");
  const terminal = await waitFor(async () => {
    const value = await restartedClient.getRun(runId);
    return value.run.status === "completed" ? value : null;
  });
  assert.equal(terminal.run.status, "completed");
  assert.deepEqual((await restartedClient.listWorkflowHumanGates(runId)).data, []);
  assert.equal(samples.length, 2);
  assert.notEqual(samples[0]!.body, samples[1]!.body);
  assert.equal(attemptCount(runId), 2);
  const clientEvents = [];
  for await (const event of streamRunEvents(restartedClient, { runId, view: "client" }))
    clientEvents.push(event);
  const clientEventTypes = clientEvents.map((event) => event.type);
  assert.ok(clientEventTypes.includes("run.started"));
  assert.equal(clientEventTypes.filter((type) => type === "run.completed").length, 1);
  assert.equal(clientEvents.at(-1)?.type, "run.completed");
  const events = await getText(restartedAuthority, `/api/v1/runs/${runId}/events?view=audit`);
  assert.equal((events.match(/event: run\.completed/gu) ?? []).length, 1);
  assert.equal((events.match(/event: workflow\.node\.terminal/gu) ?? []).length, 0);
  const liveBeforeGuiKill = managedPids();
  assert.ok(liveBeforeGuiKill.length >= 2);
  app.kill("SIGKILL");
  await waitForExit(app);
  await waitFor(() => managedPids().length === 0 && !portOpen(3210));
  console.log(JSON.stringify({ home, runId, samples: samples.length,
    attempts: attemptCount(runId), terminal: terminal.run.status,
    workerPidsBeforeKill, liveBeforeGuiKill,
    startDisposition: started.disposition, replayDisposition: replayed.disposition,
    gateDecision: decided.disposition,
    gateDecisionReplay: replayedDecision.disposition,
    workflowAdmission: workflowAdmissionEvidence(runId), clientEventTypes,
    sampleBodyDigests: samples.map((sample) => digester.sha256(sample.body)),
    guardianCleanup: true, uniqueTerminalEvent: true }));
  }
} finally {
  app.kill("SIGKILL");
  await Promise.allSettled([waitForExit(app),
    waitFor(() => (smokeMode === "launch"
      ? launchCleanupComplete()
      : managedPids().length === 0 && !portOpen(3210)) || null)]);
  provider.close();
}

function startApp() {
  const child = spawn(appBinary, [], { env: appEnvironment, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const append = (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-32_768); };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  Object.defineProperty(child, "diagnosticOutput", { get: () => output });
  return child as ChildProcess & { diagnosticOutput: string };
}

async function waitForControlAuthority() {
  return waitFor(() => {
    for (const line of processLines()) {
      if (!line.includes("control-api.mjs") || !line.includes(home)) continue;
      const sessionToken = environmentValue(line, "CREWON_CONTROL_SESSION_TOKEN");
      const csrfToken = environmentValue(line, "CREWON_CONTROL_CSRF_TOKEN");
      if (sessionToken && csrfToken) return { sessionToken, csrfToken };
    }
    return null;
  });
}

function workerPids() {
  return processPids(/runtime-worker\.mjs/u);
}

function managedPids() {
  return processPids(/(control-api|runtime-worker)\.mjs|crewon-process-guardian/u);
}

function processPids(pattern: RegExp) {
  return processLines().filter((line) => line.includes(home) && pattern.test(line))
    .map((line) => Number(line.trim().split(/\s+/u)[0]));
}

function processLines() {
  return execFileSync("ps", ["eww", "-ax", "-o", "pid=,command="], { encoding: "utf8" }).split("\n");
}

function launchCleanupComplete() {
  if (portOpen(3210) || portOpen(6176)) return false;
  if (process.platform !== "win32") return true;
  assert.ok(installRoot, "CREWON_PACKAGED_INSTALL_ROOT is required on Windows");
  return windowsPackagedProcessSnapshot().length === 0;
}

function windowsPackagedProcessSnapshot() {
  const command = "$ErrorActionPreference = 'Stop'; " +
    "$rows = @(Get-CimInstance Win32_Process | " +
    "Select-Object ProcessId,Name,ExecutablePath,CommandLine); " +
    "ConvertTo-Json -Compress -Depth 3 -InputObject $rows";
  const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive",
    "-Command", command], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return findOwnedPackagedWindowsProcesses({
    appBinary, installRoot, processes: JSON.parse(output),
  });
}

function environmentValue(line: string, name: string) {
  const match = new RegExp(`(?:^| )${name}=([^ ]+)`, "u").exec(line);
  return match?.[1] ?? null;
}

async function post(authority: { sessionToken: string; csrfToken: string }, path: string,
  idempotencyKey: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:3210${path}`, { method: "POST",
    headers: headers(authority, { "x-csrf-token": authority.csrfToken,
      "idempotency-key": idempotencyKey, "content-type": "application/json" }),
    body: JSON.stringify(body) });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value;
}

async function getText(authority: { sessionToken: string; csrfToken: string }, path: string) {
  const response = await fetch(`http://127.0.0.1:3210${path}`, { headers: headers(authority) });
  assert.ok(response.ok); return response.text();
}

function headers(authority: { sessionToken: string }, extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${authority.sessionToken}`, origin: "http://tauri.localhost", ...extra };
}

function controlClient(authority: { sessionToken: string; csrfToken: string }) {
  return new ControlApiClient({ baseUrl: "http://127.0.0.1:3210",
    accessToken: authority.sessionToken, csrfToken: authority.csrfToken,
    origin: "http://tauri.localhost" });
}

async function waitFor<T>(probe: () => T | null | Promise<T | null>): Promise<T> {
  let lastError: unknown;
  for (let index = 0; index < 600; index += 1) {
    try { const value = await probe(); if (value) return value; } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`slice7_wait_timeout:${app.diagnosticOutput}`, { cause: lastError });
}

function waitForExit(child: ChildProcess) {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function portOpen(port: number) {
  const probe = "const net=require('node:net');const socket=net.createConnection({host:'127.0.0.1',port:Number(process.argv[1])},()=>{socket.destroy();process.exit(0)});socket.setTimeout(250,()=>{socket.destroy();process.exit(1)});socket.on('error',()=>process.exit(1));";
  try {
    execFileSync(process.execPath, ["-e", probe, String(port)], { timeout: 1_000 });
    return true;
  } catch { return false; }
}

function attemptCount(runId: string) {
  return attemptCountWhere(runId, "");
}

function completedAttemptCount(runId: string) {
  return attemptCountWhere(runId, " AND status='completed'");
}

function workflowAdmissionEvidence(runId: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const receipts = Number(database.prepare(
      "SELECT count(*) count FROM workflow_run_admission_receipts WHERE run_id=?").get(runId).count);
    const runs = Number(database.prepare(
      "SELECT count(DISTINCT run_id) count FROM run_events WHERE run_id=?").get(runId).count);
    return { receipts, runs };
  } finally { database.close(); }
}

function attemptCountWhere(runId: string, suffix: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try { return Number(database.prepare(`SELECT count(*) count FROM run_attempts WHERE run_id=?${suffix}`).get(runId).count); }
  finally { database.close(); }
}

function agentSource(agentVersionId: string) {
  return { schemaVersion: "crewon.agent-version-source.v0" as const, agentVersionId,
    runtimeGeneration: "ts-v0", policySnapshotId: "standalone-policy-v0",
    instructions: agentVersionId, model: { adapterName: "direct-responses",
      adapterVersion: "1", modelId: "slice7-model", contextWindowTokens: 128_000,
      autoCompactAtTokens: 96_000 }, execution: { streamMaxRetries: 2, maxToolRounds: 16 },
    resources: { workspaceRequired: false, governedContextDigest: null }, tools: [] };
}

function schema() {
  return { type: "object" as const, properties: {}, required: [], additionalProperties: false as const };
}
function workflow() {
  return { schemaVersion: "crewon.workflow-version-source.v0", workflowId: "slice7-workflow",
    workflowVersionId: "slice7-workflow-v1", name: "Slice 7", description: "Packaged recovery",
    inputSchema: schema(), outputSchema: schema(), entryNodeIds: ["agent"], outputNodeIds: ["verification"],
    nodes: [{ nodeId: "agent", title: "Agent", instruction: "Return {}", kind: "agent",
      agentVersionId: "workflow-agent", dependsOn: [], inputSchema: schema(), outputSchema: schema() },
    { nodeId: "gate", title: "Human Gate", instruction: "Approve", kind: "humanGate",
      approvalPolicyId: "slice7-approval", dependsOn: ["agent"],
      inputSchema: schema(), outputSchema: schema() },
    { nodeId: "verification", title: "Verification", instruction: "Verify {}", kind: "verification",
      verifierAgentVersionId: "workflow-verifier", dependsOn: ["gate"],
      inputSchema: schema(), outputSchema: schema() }] };
}
