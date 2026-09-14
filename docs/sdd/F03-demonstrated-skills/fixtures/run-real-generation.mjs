/** Explicit manual acceptance: authorized credentials stay in process memory; all data is isolated. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { createControlDevEnvironment } from "../../../../scripts/crewon-control-web-dev.mjs";
import {
  createSyntheticRecordingExport,
  SYNTHETIC_RECORDING_EVIDENCE_SVG,
} from "../../../../packages/contracts/src/recording-export.fixture.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const envFile = process.argv[2];
assert.ok(envFile, "Pass the explicitly authorized credential env file path.");
process.loadEnvFile(resolve(envFile));
const apiKey = process.env.AICUICAN_API_KEY?.trim();
assert.ok(apiKey, "Authorized provider credential unavailable");
const dataDirectory = mkdtempSync(
  join(tmpdir(), "crewon-f03-real-generation-"),
);
mkdirSync(join(dataDirectory, "artifacts"), { mode: 0o700 });
writeFileSync(join(dataDirectory, "artifact-encryption.key"), randomBytes(32), {
  mode: 0o600,
});
const environment = createControlDevEnvironment({
  agentVersionId: "f03-real-generation-acceptance",
  apiKey,
  baseEnvironment: { PATH: process.env.PATH },
  controlPort: 43310,
  csrfToken: randomBytes(32).toString("hex"),
  dataDirectory,
  modelId: "gpt-5.5",
  probePort: 43311,
  probeToken: randomBytes(32).toString("hex"),
  providerBaseUrl: "https://api.aicuican.com/v1",
  providerId: "aicuican",
  runtimeGeneration: "f03-real-generation-acceptance-v1",
  sessionToken: randomBytes(32).toString("hex"),
  uiOrigin: "http://127.0.0.1:43315",
});
environment.CREWON_RESPONSES_STREAM_MAX_RETRIES = "0";
const secrets = [
  apiKey,
  environment.CREWON_CONTROL_SESSION_TOKEN,
  environment.CREWON_CONTROL_CSRF_TOKEN,
  environment.CREWON_PROVIDER_PROBE_TOKEN,
];
const redact = (value) =>
  secrets.reduce(
    (text, secret) => text.replaceAll(secret, "[redacted]"),
    String(value),
  );
const children = [];
let logs = "";
const recordLog = (data) => {
  logs = (logs + redact(data)).slice(-64 * 1024);
};
const headers = {
  "authorization": `Bearer ${environment.CREWON_CONTROL_SESSION_TOKEN}`,
  "x-csrf-token": environment.CREWON_CONTROL_CSRF_TOKEN,
  "origin": environment.CREWON_CONTROL_ORIGIN,
  "content-type": "application/json",
};
async function request(path, body, id) {
  const response = await fetch(`http://127.0.0.1:43310${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...headers, ...(id ? { "idempotency-key": id } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const value = await response.json();
  assert.ok(
    response.ok,
    redact(`${path} ${response.status} ${JSON.stringify(value)}`),
  );
  return value;
}
function start(name, path, keepAlive = false) {
  const args = keepAlive
    ? [
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(path)}); process.stdin.resume();`,
      ]
    : [path];
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout.on("data", recordLog);
  child.stderr.on("data", recordLog);
  child.on("error", (error) => recordLog(`${name}: ${error.message}`));
}
try {
  const released = spawnSync(
    process.execPath,
    [join(root, "apps/runtime-worker/src/release-main.ts")],
    { cwd: root, env: environment, encoding: "utf8", timeout: 30_000 },
  );
  recordLog(released.stdout);
  recordLog(released.stderr);
  assert.equal(
    released.status,
    0,
    "Isolated release failed; inspect redacted runtime.log.",
  );
  const db = new DatabaseSync(join(dataDirectory, "control.sqlite"));
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all();
  const assetTable = rows.find((row) => row.name === "agent_versions");
  assert.ok(assetTable, "Published AgentVersion table unavailable");
  // Release validation happens before any provider request; the role must be immutable and text-only.
  const columns = db
    .prepare("PRAGMA table_info(agent_versions)")
    .all()
    .map((row) => row.name);
  assert.ok(
    columns.includes("asset_json"),
    "Published AgentVersion definition unavailable",
  );
  const asset = db
    .prepare("SELECT asset_json FROM agent_versions WHERE agent_version_id = ?")
    .get(environment.CREWON_SKILL_GENERATION_AGENT_VERSION_ID);
  const version = JSON.parse(JSON.parse(asset.asset_json).definitionJson);
  assert.deepEqual(version.tools, []);
  assert.equal(version.execution.maxToolRounds, 0);
  db.close();
  start("Control", join(root, "apps/control-api/src/main.ts"));
  start("Worker", join(root, "apps/runtime-worker/src/main.ts"), true);
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      await request("/api/v1/skills");
      ready = true;
      break;
    } catch {
      await delay(250);
    }
  }
  assert.ok(ready, "Isolated Control not ready");
  const recording = await createSyntheticRecordingExport();
  const skill = await request(
    "/api/v1/skills",
    {
      recording,
      provenance: "contract-fixture",
      evidence: [
        {
          evidenceId: recording.evidence[0].evidenceId,
          mediaType: "image/svg+xml",
          dataBase64: Buffer.from(SYNTHETIC_RECORDING_EVIDENCE_SVG).toString(
            "base64",
          ),
        },
      ],
    },
    "real-model-fixture-import",
  );
  const { thread } = await request(
    "/api/v1/threads",
    { title: "F03 synthetic recording / real model acceptance" },
    "real-model-thread",
  );
  const generation = await request(
    `/api/v1/skills/${skill.skillId}/generations`,
    {
      generationId: "real-model-generation",
      threadId: thread.threadId,
      expectedThreadRevision: thread.revision,
      agentVersionId: null,
      expectedSkillRevision: skill.revision,
    },
  );
  console.log(
    JSON.stringify({
      phase: "generation-started",
      runId: generation.runId,
      dataDirectory,
    }),
  );
  let current = generation;
  for (let i = 0; i < 180; i++) {
    current = await request(
      `/api/v1/skills/${skill.skillId}/generations/${generation.generationId}`,
    );
    if (
      ["completed", "failed", "cancelled", "needsHuman"].includes(
        current.status,
      )
    )
      break;
    await delay(1000);
  }
  assert.equal(
    current.status,
    "completed",
    `Generation ended ${current.status}`,
  );
  const collected = await request(
    `/api/v1/skills/${skill.skillId}/generations/${generation.generationId}/collect`,
    {},
  );
  assert.equal(collected.verification, "real");
  assert.equal(collected.outcome, "candidate");
  const applied = await request(
    `/api/v1/skills/${skill.skillId}/generations/${generation.generationId}/apply`,
    { expectedSkillRevision: skill.revision },
  );
  assert.equal(applied.appliedRevision, skill.revision + 1);
  const detail = await request(`/api/v1/skills/${skill.skillId}`);
  assert.equal(detail.skill.source.provenance, "contract-fixture");
  assert.deepEqual(detail.skill.activatedVersionIds, []);
  const evidenceDb = new DatabaseSync(join(dataDirectory, "control.sqlite"));
  const toolReceipts = evidenceDb
    .prepare(
      "SELECT count(*) AS count FROM tool_execution_receipts WHERE run_id = ?",
    )
    .get(generation.runId).count;
  const modelCalls = evidenceDb
    .prepare(
      "SELECT record_json FROM model_call_observations WHERE run_id = ? ORDER BY call_order",
    )
    .all(generation.runId)
    .map((row) => JSON.parse(row.record_json));
  assert.equal(toolReceipts, 0);
  assert.ok(modelCalls.length > 0);
  evidenceDb.close();
  const result = {
    toolReceipts,
    modelCalls,
    checkedAt: new Date().toISOString(),
    input: "explicit synthetic C01 recording; no real browser capture",
    provider: "https://api.aicuican.com/v1",
    model: "gpt-5.5",
    agentVersionId: version.agentVersionId,
    contentDigest: version.contentDigest,
    tools: version.tools,
    maxToolRounds: version.execution.maxToolRounds,
    runId: generation.runId,
    status: current.status,
    verification: collected.verification,
    outcome: collected.outcome,
    appliedRevision: applied.appliedRevision,
    candidate: collected.candidate,
    limitations: [
      "No real browser recording or C05 execution",
      "No F01 delivery",
      "No activation",
      "No reconnect acceptance",
    ],
  };
  writeFileSync(
    join(dataDirectory, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      phase: "passed",
      result: join(dataDirectory, "result.json"),
    }),
  );
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill("SIGTERM");
  await delay(500);
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  writeFileSync(join(dataDirectory, "runtime.log"), logs, { mode: 0o600 });
  console.log(JSON.stringify({ isolatedDataDirectory: dataDirectory }));
}
