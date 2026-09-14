/** Imports a committed F02 capture verbatim; no browser or model is simulated here. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createStandaloneControlApi } from "../../../../apps/control-api/src/standalone-composition.ts";
import { InMemoryArtifactStore } from "../../../../packages/artifacts/src/index.ts";
import { renderSkillDraftGenerationPrompt } from "../../../../packages/application/src/skill-draft-generation.ts";
const path = resolve(process.argv[2]);
const recording = JSON.parse(readFileSync(path, "utf8"));
const evidence = recording.evidence.map((item) => {
  assert.match(item.evidenceId, /^[a-zA-Z0-9_-]+$/);
  assert.ok(["image/png", "image/svg+xml"].includes(item.mediaType));
  return {
    evidenceId: item.evidenceId,
    mediaType: item.mediaType,
    dataBase64: readFileSync(
      join(
        dirname(path),
        "evidence",
        `${item.evidenceId}.${item.mediaType === "image/png" ? "png" : "svg"}`,
      ),
    ).toString("base64"),
  };
});
const dir = mkdtempSync(join(tmpdir(), "crewon-f03-f02-import-"));
const config = {
  databasePath: join(dir, "control.sqlite"),
  actor: { principalId: "p", actorId: "a", tenantId: "t", spaceId: "s" },
  defaultAgentVersionId: "unneeded-for-import",
  sessionToken: randomBytes(32).toString("hex"),
  csrfToken: randomBytes(32).toString("hex"),
  allowedOrigins: ["http://127.0.0.1:43315"],
  heartbeatIntervalMs: null,
  outboxScanIntervalMs: null,
  automationScanIntervalMs: null,
  artifactEncryptionKeyId: "acceptance",
};
let runtime = createStandaloneControlApi({
  ...config,
  artifactStore: new InMemoryArtifactStore(),
});
try {
  const headers = {
    "authorization": `Bearer ${config.sessionToken}`,
    "x-csrf-token": config.csrfToken,
    "origin": config.allowedOrigins[0],
  };
  const imported = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/skills",
    headers: { ...headers, "idempotency-key": "actual-f02-capture" },
    payload: { recording, evidence },
  });
  assert.equal(imported.statusCode, 200, imported.body);
  const skill = imported.json();
  assert.equal(skill.source.contentDigest, recording.contentDigest);
  assert.equal(skill.source.provenance, "recording");
  const promptBytes = Buffer.byteLength(
    renderSkillDraftGenerationPrompt(skill.draft),
  );
  await runtime.app.close();
  runtime = createStandaloneControlApi({
    ...config,
    artifactStore: new InMemoryArtifactStore(),
  });
  const source = await runtime.app.inject({
    method: "GET",
    url: `/api/v1/skills/${skill.skillId}/recording`,
    headers,
  });
  assert.equal(source.statusCode, 200, source.body);
  assert.deepEqual(source.json().recording, recording);
  for (const item of evidence) {
    const stored = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/skills/${skill.skillId}/evidence/${item.evidenceId}`,
      headers,
    });
    assert.equal(stored.statusCode, 200);
    assert.deepEqual(stored.json().evidence, item);
  }
  const result = {
    checkedAt: new Date().toISOString(),
    sourceCommit: "aa81fecb0",
    recordingId: recording.recordingId,
    recordingRevision: recording.revision,
    contentDigest: recording.contentDigest,
    steps: recording.steps.length,
    evidence: evidence.length,
    pngEvidence: evidence.filter((e) => e.mediaType === "image/png").length,
    provenance: skill.source.provenance,
    promptBytes,
    sourceAndEvidenceUnchangedAfterRestart: true,
    limitations: [
      "F02 supplied actual capture from an automated synthetic website session",
      "This check imports and persists verbatim; it does not execute browser actions or call a model",
    ],
  };
  writeFileSync(
    join(dir, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify({ ...result, result: join(dir, "result.json") }));
} finally {
  await runtime.app.close();
}
