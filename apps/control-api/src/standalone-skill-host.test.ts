import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import {
  createSyntheticRecordingExport,
  SYNTHETIC_RECORDING_EVIDENCE_SVG,
} from "../../../packages/contracts/src/recording-export.fixture.ts";
import { createStandaloneControlApi } from "./standalone-composition.ts";
test("F03 standalone registers a durable authenticated Skill host and reloads recording evidence after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crewon-skill-host-"));
  const config = {
    databasePath: join(dir, "host.sqlite"),
    actor: { principalId: "p", actorId: "a", tenantId: "t", spaceId: "s" },
    defaultAgentVersionId: "agent",
    sessionToken: "skill-test-session-32-bytes-minimum",
    csrfToken: "skill-test-csrf-32-bytes-minimum",
    allowedOrigins: ["http://127.0.0.1:5175"],
    heartbeatIntervalMs: null,
    outboxScanIntervalMs: null,
    automationScanIntervalMs: null,
    artifactEncryptionKeyId: "test-key",
  };
  const headers = {
    "authorization": `Bearer ${config.sessionToken}`,
    "x-csrf-token": config.csrfToken,
    "origin": config.allowedOrigins[0]!,
  };
  let runtime = createStandaloneControlApi({
    ...config,
    artifactStore: new InMemoryArtifactStore(),
  });
  try {
    assert.equal(
      (await runtime.app.inject({ method: "GET", url: "/api/v1/skills" }))
        .statusCode,
      401,
    );
    const recording = await createSyntheticRecordingExport();
    const evidence = [
      {
        evidenceId: recording.evidence[0]!.evidenceId,
        mediaType: "image/svg+xml",
        dataBase64: Buffer.from(SYNTHETIC_RECORDING_EVIDENCE_SVG).toString(
          "base64",
        ),
      },
    ];
    const imported = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/skills",
      headers: { ...headers, "idempotency-key": "source-import-1" },
      payload: { recording, evidence, provenance: "contract-fixture" },
    });
    assert.equal(imported.statusCode, 200, imported.body);
    const skill = imported.json();
    assert.ok(skill.skillId);
    assert.equal(skill.source.provenance, "contract-fixture");
    const replayImport = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/skills",
      headers: { ...headers, "idempotency-key": "source-import-1" },
      payload: { recording, evidence, provenance: "contract-fixture" },
    });
    assert.equal(replayImport.json().skillId, skill.skillId);
    const changedProvenance = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/skills",
      headers: { ...headers, "idempotency-key": "source-import-1" },
      payload: { recording, evidence },
    });
    assert.equal(changedProvenance.statusCode, 409);
    const elevated = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/skills",
      headers,
      payload: { recording, evidence, provenance: "recording" },
    });
    assert.equal(elevated.statusCode, 400);
    const listing = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/skills",
      headers,
    });
    assert.equal(listing.json().skills[0].skillId, skill.skillId);
    const sealed = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/skills/${skill.skillId}/versions`,
      headers,
      payload: { expectedRevision: 1 },
    });
    assert.equal(sealed.statusCode, 200, sealed.body);
    await runtime.app.close();
    runtime = createStandaloneControlApi({
      ...config,
      artifactStore: new InMemoryArtifactStore(),
    });
    const detail = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/skills/${skill.skillId}`,
      headers,
    });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(
      detail.json().versions[0].ref.contentDigest,
      sealed.json().ref.contentDigest,
    );
    const bytes = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/skills/${skill.skillId}/evidence/${recording.evidence[0]!.evidenceId}`,
      headers,
    });
    assert.equal(bytes.statusCode, 200, bytes.body);
    assert.equal(bytes.json().evidence.dataBase64, evidence[0]!.dataBase64);
    const rejected = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/skills/${skill.skillId}/activate`,
      headers,
      payload: { expectedRevision: 1, version: sealed.json().ref },
    });
    assert.equal(rejected.statusCode, 409);
  } finally {
    await runtime.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
