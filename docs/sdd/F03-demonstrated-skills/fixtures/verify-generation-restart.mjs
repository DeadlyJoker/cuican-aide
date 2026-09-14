/** Read/replay acceptance in a separate Control process; no Worker or model transport is started. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStandaloneControlApi } from "../../../../apps/control-api/src/standalone-composition.ts";
import { InMemoryArtifactStore } from "../../../../packages/artifacts/src/index.ts";
const dataDirectory = resolve(process.argv[2]);
const original = JSON.parse(
  readFileSync(join(dataDirectory, "result.json"), "utf8"),
);
const db = new DatabaseSync(join(dataDirectory, "control.sqlite"));
const generation = JSON.parse(
  db
    .prepare(
      "SELECT record_json FROM skill_draft_generations WHERE json_extract(record_json,'$.runId')=?",
    )
    .get(original.runId).record_json,
);
const before = db
  .prepare(
    "SELECT count(*) AS count FROM model_call_observations WHERE run_id=?",
  )
  .get(original.runId).count;
const config = {
  databasePath: join(dataDirectory, "control.sqlite"),
  actor: {
    principalId: "standalone-principal",
    actorId: "standalone-actor",
    tenantId: "standalone-tenant",
    spaceId: "standalone-space",
  },
  defaultAgentVersionId: "f03-real-generation-acceptance",
  generationAgentVersionId: original.agentVersionId,
  sessionToken: randomBytes(32).toString("hex"),
  csrfToken: randomBytes(32).toString("hex"),
  allowedOrigins: ["http://127.0.0.1:43315"],
  heartbeatIntervalMs: null,
  outboxScanIntervalMs: null,
  automationScanIntervalMs: null,
  artifactEncryptionKeyId: "acceptance-restart",
  artifactStore: new InMemoryArtifactStore(),
};
const runtime = createStandaloneControlApi(config);
try {
  const headers = {
    "authorization": `Bearer ${config.sessionToken}`,
    "x-csrf-token": config.csrfToken,
    "origin": config.allowedOrigins[0],
  };
  const url = `/api/v1/skills/${generation.skillId}/generations/${generation.generationId}`;
  const read = await runtime.app.inject({ method: "GET", url, headers });
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().runId, original.runId);
  assert.equal(read.json().verification, "real");
  const collect = await runtime.app.inject({
    method: "POST",
    url: `${url}/collect`,
    headers,
    payload: {},
  });
  assert.equal(collect.statusCode, 200);
  assert.deepEqual(collect.json().candidate, original.candidate);
  const replay = await runtime.app.inject({
    method: "POST",
    url: `${url}/apply`,
    headers,
    payload: { expectedSkillRevision: generation.expectedSkillRevision },
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().appliedRevision, original.appliedRevision);
  const skill = await runtime.app.inject({
    method: "GET",
    url: `/api/v1/skills/${generation.skillId}`,
    headers,
  });
  assert.equal(skill.statusCode, 200);
  assert.equal(skill.json().skill.source.provenance, "contract-fixture");
  assert.deepEqual(skill.json().skill.activatedVersionIds, []);
  const after = db
    .prepare(
      "SELECT count(*) AS count FROM model_call_observations WHERE run_id=?",
    )
    .get(original.runId).count;
  assert.equal(after, before);
  const evidence = {
    checkedAt: new Date().toISOString(),
    runId: original.runId,
    sourceProvenance: skill.json().skill.source.provenance,
    appliedRevision: replay.json().appliedRevision,
    verification: read.json().verification,
    modelCallsBefore: before,
    modelCallsAfter: after,
    readStatus: read.statusCode,
    collectStatus: collect.statusCode,
    applyReplayStatus: replay.statusCode,
    limits: [
      "New Control process, same isolated SQLite; no Worker started",
      "HTTP completion recovery, not an interrupted provider stream or browser reconnect",
    ],
  };
  writeFileSync(
    join(dataDirectory, "restart.json"),
    JSON.stringify(evidence, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify(evidence));
} finally {
  await runtime.app.close();
  db.close();
}
