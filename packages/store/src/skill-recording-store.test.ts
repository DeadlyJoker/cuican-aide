import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { SkillEvidenceUpload, SkillScope } from "@crewon/application";
import {
  sealRecordingExport,
  type RecordingExport,
} from "@crewon/contracts/recording";
import type { SkillRecordingSource } from "@crewon/domain";
import {
  createSyntheticRecordingExport,
  SYNTHETIC_RECORDING_EVIDENCE_SVG,
} from "../../contracts/src/recording-export.fixture.ts";
import { SqliteSkillRecordingStore } from "./skill-recording-store.ts";

// Synthetic C01 fixture only; no browser/model execution or production activation evidence.
const scope: SkillScope = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  ownerActorId: "remote-actor-1",
};
const upload: SkillEvidenceUpload = {
  evidenceId: "synthetic-evidence-1",
  mediaType: "image/svg+xml",
  dataBase64: Buffer.from(SYNTHETIC_RECORDING_EVIDENCE_SVG).toString("base64"),
};
const sourceOf = (recording: RecordingExport): SkillRecordingSource => ({
  recordingId: recording.recordingId,
  revision: recording.revision,
  contentDigest: recording.contentDigest,
  provenance: "contract-fixture",
});
async function reseal(
  recording: RecordingExport,
  change: Partial<RecordingExport> = {},
): Promise<RecordingExport> {
  const { contentDigest: _digest, ...body } = { ...recording, ...change };
  return sealRecordingExport(body);
}
async function fixture(t: import("node:test").TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "crewon-skill-recording-"));
  const path = join(dir, "host.sqlite");
  const stores: SqliteSkillRecordingStore[] = [];
  const open = () => {
    const store = new SqliteSkillRecordingStore(path);
    stores.push(store);
    return store;
  };
  t.after(async () => {
    for (const store of stores) await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { path, open };
}

test("F03-R01 stores a complete synthetic recording and evidence, isolated by authenticated scope across reopen", async (t) => {
  const f = await fixture(t);
  const first = f.open();
  const second = f.open();
  const recording = await createSyntheticRecordingExport();
  const source = sourceOf(recording);
  assert.notEqual(
    recording.scope.ownerId,
    scope.ownerActorId,
    "local provenance never becomes the authenticated owner",
  );
  await first.saveImportedRecording(scope, recording, [upload]);
  assert.deepEqual(
    await second.readImportedRecording(scope, source),
    recording,
  );
  assert.deepEqual(
    await second.readRecordingEvidence(scope, source, upload.evidenceId),
    upload,
  );
  await first.close();
  await first.close();
  await second.close();
  const reopened = f.open();
  assert.deepEqual(
    await reopened.readImportedRecording(scope, source),
    recording,
  );
  assert.deepEqual(
    await reopened.readRecordingEvidence(scope, source, upload.evidenceId),
    upload,
  );
  assert.equal(
    await reopened.readRecordingEvidence(scope, source, "unknown-evidence"),
    null,
  );
  for (const other of [
    { tenantId: "tenant-2" },
    { spaceId: "space-2" },
    { ownerActorId: "actor-2" },
  ]) {
    const otherScope = { ...scope, ...other };
    assert.equal(
      await reopened.readImportedRecording(otherScope, source),
      null,
    );
    assert.equal(
      await reopened.readRecordingEvidence(
        otherScope,
        source,
        upload.evidenceId,
      ),
      null,
    );
    await reopened.saveImportedRecording(otherScope, recording, [upload]);
    assert.deepEqual(
      await reopened.readImportedRecording(otherScope, source),
      recording,
    );
  }
});

test("F03-R01 export identity is append-only and exact source digests are required", async (t) => {
  const f = await fixture(t);
  const store = f.open();
  const recording = await createSyntheticRecordingExport();
  const source = sourceOf(recording);
  await store.saveImportedRecording(scope, recording, [upload]);
  await store.saveImportedRecording(scope, recording, [upload]);
  const changed = await reseal(recording, {
    steps: recording.steps.map((step, i) =>
      i ? step : { ...step, note: "Changed observed purpose" },
    ),
  });
  await assert.rejects(store.saveImportedRecording(scope, changed, [upload]), {
    code: "skill_recording_conflict",
    category: "conflict",
  });
  await assert.rejects(
    store.readImportedRecording(scope, {
      ...source,
      contentDigest: `sha256:${"0".repeat(64)}`,
    }),
    { code: "skill_recording_digest_mismatch" },
  );
  await assert.rejects(
    store.readRecordingEvidence(
      scope,
      { ...source, contentDigest: `sha256:${"0".repeat(64)}` },
      upload.evidenceId,
    ),
    { code: "skill_recording_digest_mismatch" },
  );
  assert.equal(
    await store.readImportedRecording(scope, {
      ...source,
      revision: source.revision + 1,
    }),
    null,
  );
  const newer = await reseal(recording, { revision: recording.revision + 1 });
  await store.saveImportedRecording(scope, newer, [upload]);
  assert.deepEqual(await store.readImportedRecording(scope, source), recording);
});

test("F03-R01 rejects missing, duplicate, extra, wrong-type and tampered uploads without partial imports", async (t) => {
  const f = await fixture(t);
  const store = f.open();
  const recording = await createSyntheticRecordingExport();
  const source = sourceOf(recording);
  const mutations: readonly (readonly SkillEvidenceUpload[])[] = [
    [],
    [upload, upload],
    [upload, { ...upload, evidenceId: "extra" }],
    [{ ...upload, evidenceId: "extra" }],
    [{ ...upload, mediaType: "image/png" }],
    [
      {
        ...upload,
        dataBase64: Buffer.from("different bytes").toString("base64"),
      },
    ],
    [
      {
        ...upload,
        dataBase64: Buffer.from(
          SYNTHETIC_RECORDING_EVIDENCE_SVG.replace("white", "black"),
        ).toString("base64"),
      },
    ],
  ];
  for (const evidence of mutations) {
    await assert.rejects(
      store.saveImportedRecording(scope, recording, evidence),
    );
    assert.equal(await store.readImportedRecording(scope, source), null);
  }
  await assert.rejects(
    store.saveImportedRecording(
      scope,
      { ...recording, contentDigest: `sha256:${"0".repeat(64)}` },
      [upload],
    ),
    { code: "recording_export_digest_mismatch" },
  );
  const database = new DatabaseSync(f.path);
  try {
    assert.equal(
      database
        .prepare("SELECT count(*) AS count FROM skill_imported_recordings")
        .get()?.count,
      0,
    );
    assert.equal(
      database
        .prepare("SELECT count(*) AS count FROM skill_recording_evidence")
        .get()?.count,
      0,
    );
  } finally {
    database.close();
  }
  await store.saveImportedRecording(scope, recording, [upload]);
});

test("F03-R01 strict base64 rejects noncanonical encodings and all evidence remains within byte budgets", async (t) => {
  const f = await fixture(t);
  const store = f.open();
  const recording = await createSyntheticRecordingExport();
  for (const dataBase64 of [
    upload.dataBase64 + "\n",
    upload.dataBase64.slice(0, -1),
    "%%%%",
    "YQ",
    "YR==",
    "YQ===",
    "",
    Buffer.alloc(16 * 1024 + 1).toString("base64"),
  ]) {
    await assert.rejects(
      store.saveImportedRecording(scope, recording, [
        { ...upload, dataBase64 },
      ]),
      { category: "validation" },
    );
  }
  const chunk = Buffer.alloc(16 * 1024, 1);
  const digest =
    `sha256:${createHash("sha256").update(chunk).digest("hex")}` as const;
  const oversizedEvidence = Array.from({ length: 128 }, (_, i) => ({
    ...recording.evidence[0]!,
    evidenceId: i ? `evidence-${i}` : upload.evidenceId,
    byteLength: chunk.length,
    contentDigest: digest,
  }));
  await assert.rejects(
    store.saveImportedRecording(
      scope,
      { ...recording, evidence: oversizedEvidence },
      oversizedEvidence.map((e) => ({
        evidenceId: e.evidenceId,
        mediaType: e.mediaType,
        dataBase64: chunk.toString("base64"),
      })),
    ),
    { code: "recording_export_total_budget_exceeded" },
  );
  const atLimit = await reseal(recording, {
    evidence: [
      {
        ...recording.evidence[0]!,
        byteLength: chunk.length,
        contentDigest: digest,
      },
    ],
  });
  const largeUpload = { ...upload, dataBase64: chunk.toString("base64") };
  await store.saveImportedRecording(scope, atLimit, [largeUpload]);
  assert.equal(
    Buffer.from(
      (await store.readRecordingEvidence(
        scope,
        sourceOf(atLimit),
        upload.evidenceId,
      ))!.dataBase64,
      "base64",
    ).length,
    16 * 1024,
  );
});

test("F03-R01 refuses the 21st export per scope and preserves earlier user evidence across connections", async (t) => {
  const f = await fixture(t);
  const first = f.open();
  const second = f.open();
  const recording = await createSyntheticRecordingExport();
  const versions = [];
  for (let i = 0; i < 20; i++) {
    const next = await reseal(recording, { revision: recording.revision + i });
    versions.push(next);
    await (i % 2 ? second : first).saveImportedRecording(scope, next, [upload]);
  }
  await second.saveImportedRecording(scope, versions[0]!, [upload]);
  const overflow = await reseal(recording, {
    revision: recording.revision + 20,
  });
  await assert.rejects(
    second.saveImportedRecording(scope, overflow, [upload]),
    { code: "skill_recording_limit", category: "conflict" },
  );
  assert.equal(
    await first.readImportedRecording(scope, sourceOf(overflow)),
    null,
  );
  assert.deepEqual(
    await first.readRecordingEvidence(
      scope,
      sourceOf(versions[0]!),
      upload.evidenceId,
    ),
    upload,
  );
  await second.saveImportedRecording(
    { ...scope, ownerActorId: "another-owner" },
    overflow,
    [upload],
  );
});

test("F03-R01 reopened reads reject altered export JSON, BLOBs and missing evidence", async (t) => {
  for (const tamper of ["json", "bytes", "missing"] as const) {
    const f = await fixture(t);
    const first = f.open();
    const recording = await createSyntheticRecordingExport();
    await first.saveImportedRecording(scope, recording, [upload]);
    await first.close();
    const database = new DatabaseSync(f.path);
    try {
      if (tamper === "json")
        database
          .prepare("UPDATE skill_imported_recordings SET export_json = ?")
          .run(JSON.stringify({ ...recording, status: "paused" }));
      if (tamper === "bytes")
        database
          .prepare("UPDATE skill_recording_evidence SET content = ?")
          .run(
            Buffer.from(
              SYNTHETIC_RECORDING_EVIDENCE_SVG.replace("white", "black"),
            ),
          );
      if (tamper === "missing")
        database.exec("DELETE FROM skill_recording_evidence");
    } finally {
      database.close();
    }
    const reopened = f.open();
    await assert.rejects(
      reopened.readImportedRecording(scope, sourceOf(recording)),
    );
    await assert.rejects(
      reopened.readRecordingEvidence(
        scope,
        sourceOf(recording),
        upload.evidenceId,
      ),
    );
  }
});

test("F03-R01 database failure while writing evidence rolls back the entire import", async (t) => {
  const f = await fixture(t);
  const store = f.open();
  const original = await createSyntheticRecordingExport();
  const second = { ...upload, evidenceId: "synthetic-evidence-2" };
  const recording = await reseal(original, {
    evidence: [
      ...original.evidence,
      { ...original.evidence[0]!, evidenceId: second.evidenceId },
    ],
  });
  const database = new DatabaseSync(f.path);
  try {
    database.exec(`CREATE TRIGGER synthetic_evidence_failure BEFORE INSERT ON skill_recording_evidence
      WHEN NEW.evidence_id = 'synthetic-evidence-2' BEGIN SELECT RAISE(ABORT, 'synthetic_write_failure'); END`);
    await assert.rejects(
      store.saveImportedRecording(scope, recording, [upload, second]),
      /synthetic_write_failure/,
    );
    assert.equal(
      await store.readImportedRecording(scope, sourceOf(recording)),
      null,
    );
    assert.equal(
      database
        .prepare("SELECT count(*) AS count FROM skill_recording_evidence")
        .get()?.count,
      0,
    );
    database.exec("DROP TRIGGER synthetic_evidence_failure");
  } finally {
    database.close();
  }
  await store.saveImportedRecording(scope, recording, [upload, second]);
  assert.deepEqual(
    await store.readRecordingEvidence(
      scope,
      sourceOf(recording),
      second.evidenceId,
    ),
    second,
  );
});
