import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  ApplicationError,
  type SkillEvidenceUpload,
  type SkillRecordingStore,
  type SkillScope,
} from "@crewon/application";
import {
  RECORDING_BUDGETS,
  validateRecordingExport,
  type RecordingExport,
} from "@crewon/contracts/recording";
import type { SkillRecordingSource } from "@crewon/domain";

const MAX_EXPORTS_PER_SCOPE = 20;
const MAX_EVIDENCE_COUNT = RECORDING_BUDGETS.maxSteps * 2;
const scopeWhere = "tenant_id = ? AND space_id = ? AND owner_actor_id = ?";
const recordingWhere = `${scopeWhere} AND recording_id = ? AND revision = ?`;
type ImportedRow = {
  content_digest: string;
  json_bytes: number;
  export_json: string | null;
};
type EvidenceRow = {
  evidence_id: string;
  media_type: string;
  content_digest: string;
  byte_length: number;
  actual_bytes: number;
  content: Uint8Array | null;
};
type EvidenceBytes = {
  evidenceId: string;
  mediaType: SkillEvidenceUpload["mediaType"];
  content: Buffer;
  contentDigest: string;
};
type Snapshot = { recording: ImportedRow; evidence: EvidenceRow[] };

/** Authenticated import scope owns this archive; a C01 ownerId is provenance only. */
export class SqliteSkillRecordingStore implements SkillRecordingStore {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(path: string) {
    if (typeof path !== "string" || !path.length || path.includes("\0"))
      invalid("skill_recording_path_invalid");
    this.#database = new DatabaseSync(path);
    try {
      this.#database.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS skill_imported_recordings (
          tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, owner_actor_id TEXT NOT NULL,
          recording_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1),
          content_digest TEXT NOT NULL, export_json TEXT NOT NULL CHECK(json_valid(export_json)),
          PRIMARY KEY (tenant_id, space_id, owner_actor_id, recording_id, revision)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS skill_recording_evidence (
          tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, owner_actor_id TEXT NOT NULL,
          recording_id TEXT NOT NULL, revision INTEGER NOT NULL,
          evidence_id TEXT NOT NULL, media_type TEXT NOT NULL, content_digest TEXT NOT NULL,
          byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 16384),
          content BLOB NOT NULL CHECK(length(content) BETWEEN 1 AND 16384),
          PRIMARY KEY (tenant_id, space_id, owner_actor_id, recording_id, revision, evidence_id),
          FOREIGN KEY (tenant_id, space_id, owner_actor_id, recording_id, revision)
            REFERENCES skill_imported_recordings(tenant_id, space_id, owner_actor_id, recording_id, revision)
        ) STRICT;
        COMMIT;
      `);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  async saveImportedRecording(
    scope: SkillScope,
    input: RecordingExport,
    evidence: readonly SkillEvidenceUpload[],
  ): Promise<void> {
    const scoped = checkedScope(scope);
    // Freeze uploads before the asynchronous contract digest check.
    const uploads = parseUploads(evidence);
    const recording = await validateRecordingExport(input);
    verifyEvidence(recording, uploads);
    const json = JSON.stringify(recording);
    const source: SkillRecordingSource = {
      recordingId: recording.recordingId,
      revision: recording.revision,
      contentDigest: recording.contentDigest,
      provenance: "recording",
    };
    this.#transaction("write", () => {
      const existing = this.#recordingRow(scoped, source);
      if (existing) {
        if (
          existing.content_digest !== recording.contentDigest ||
          existing.export_json !== json
        )
          conflict("skill_recording_conflict");
        verifyEvidence(
          recording,
          decodeEvidenceRows(this.#evidenceRows(scoped, source)),
        );
        return;
      }
      const count = this.#database
        .prepare(
          `SELECT count(*) AS count FROM skill_imported_recordings WHERE ${scopeWhere}`,
        )
        .get(...scopeArgs(scoped)) as { count: number };
      if (count.count >= MAX_EXPORTS_PER_SCOPE)
        conflict("skill_recording_limit");
      this.#database
        .prepare(
          `INSERT INTO skill_imported_recordings
        (tenant_id, space_id, owner_actor_id, recording_id, revision, content_digest, export_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(...recordingArgs(scoped, source), recording.contentDigest, json);
      const insert = this.#database
        .prepare(`INSERT INTO skill_recording_evidence
        (tenant_id, space_id, owner_actor_id, recording_id, revision, evidence_id, media_type, content_digest, byte_length, content)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const upload of uploads)
        insert.run(
          ...recordingArgs(scoped, source),
          upload.evidenceId,
          upload.mediaType,
          upload.contentDigest,
          upload.content.length,
          upload.content,
        );
    });
  }

  async readImportedRecording(
    scope: SkillScope,
    source: SkillRecordingSource,
  ): Promise<RecordingExport | null> {
    return (await this.#read(scope, source))?.recording ?? null;
  }

  async readRecordingEvidence(
    scope: SkillScope,
    source: SkillRecordingSource,
    evidenceId: string,
  ): Promise<SkillEvidenceUpload | null> {
    id(evidenceId);
    const imported = await this.#read(scope, source);
    const evidence = imported?.evidence.find(
      (item) => item.evidenceId === evidenceId,
    );
    return evidence
      ? {
          evidenceId: evidence.evidenceId,
          mediaType: evidence.mediaType,
          dataBase64: evidence.content.toString("base64"),
        }
      : null;
  }

  async #read(
    scope: SkillScope,
    source: SkillRecordingSource,
  ): Promise<{ recording: RecordingExport; evidence: EvidenceBytes[] } | null> {
    const scoped = checkedScope(scope);
    const ref = checkedSource(source);
    // Capture one consistent database snapshot before asynchronous digest validation.
    const snapshot = this.#transaction<Snapshot | null>("read", () => {
      const recording = this.#recordingRow(scoped, ref);
      return recording
        ? { recording, evidence: this.#evidenceRows(scoped, ref) }
        : null;
    });
    if (!snapshot) return null;
    if (snapshot.recording.content_digest !== ref.contentDigest)
      conflict("skill_recording_digest_mismatch");
    const json = snapshot.recording.export_json;
    if (
      json === null ||
      snapshot.recording.json_bytes > RECORDING_BUDGETS.maxTotalBytes
    )
      corrupt();
    const recording = await validateRecordingExport(JSON.parse(json));
    if (
      recording.recordingId !== ref.recordingId ||
      recording.revision !== ref.revision ||
      recording.contentDigest !== ref.contentDigest
    )
      corrupt();
    const evidence = decodeEvidenceRows(snapshot.evidence);
    verifyEvidence(recording, evidence);
    return { recording, evidence };
  }

  #recordingRow(
    scope: SkillScope,
    source: SkillRecordingSource,
  ): ImportedRow | null {
    return (
      (this.#database
        .prepare(
          `SELECT content_digest, length(CAST(export_json AS BLOB)) AS json_bytes,
      CASE WHEN length(CAST(export_json AS BLOB)) <= ? THEN export_json ELSE NULL END AS export_json
      FROM skill_imported_recordings WHERE ${recordingWhere}`,
        )
        .get(
          RECORDING_BUDGETS.maxTotalBytes,
          ...recordingArgs(scope, source),
        ) as ImportedRow | undefined) ?? null
    );
  }

  #evidenceRows(
    scope: SkillScope,
    source: SkillRecordingSource,
  ): EvidenceRow[] {
    const totals = this.#database
      .prepare(
        `SELECT count(*) AS count, coalesce(sum(length(content)), 0) AS bytes
        FROM skill_recording_evidence WHERE ${recordingWhere}`,
      )
      .get(...recordingArgs(scope, source)) as { count: number; bytes: number };
    if (
      totals.count > MAX_EVIDENCE_COUNT ||
      totals.bytes > RECORDING_BUDGETS.maxTotalBytes
    )
      corrupt();
    const rows = this.#database
      .prepare(
        `SELECT evidence_id, media_type, content_digest, byte_length, length(content) AS actual_bytes,
      CASE WHEN length(content) <= ? THEN content ELSE NULL END AS content
      FROM skill_recording_evidence WHERE ${recordingWhere} ORDER BY evidence_id LIMIT ?`,
      )
      .all(
        RECORDING_BUDGETS.maxEvidenceBytes,
        ...recordingArgs(scope, source),
        MAX_EVIDENCE_COUNT + 1,
      ) as EvidenceRow[];
    if (rows.length > MAX_EVIDENCE_COUNT) corrupt();
    return rows;
  }

  #transaction<T>(mode: "read" | "write", operation: () => T): T {
    if (this.#closed)
      throw new ApplicationError("internal", "skill_recording_store_closed");
    this.#database.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}

function parseUploads(value: readonly SkillEvidenceUpload[]): EvidenceBytes[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_COUNT)
    invalid("skill_recording_evidence_invalid");
  const seen = new Set<string>();
  const parsed: EvidenceBytes[] = [];
  let totalBytes = 0;
  for (const item of value) {
    exactShape(item, ["evidenceId", "mediaType", "dataBase64"]);
    id(item.evidenceId);
    if (seen.has(item.evidenceId))
      invalid("skill_recording_evidence_duplicate");
    seen.add(item.evidenceId);
    if (item.mediaType !== "image/png" && item.mediaType !== "image/svg+xml")
      invalid("skill_recording_evidence_type_invalid");
    const encoded = item.dataBase64;
    if (
      typeof encoded !== "string" ||
      !encoded.length ||
      encoded.length > Math.ceil(RECORDING_BUDGETS.maxEvidenceBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        encoded,
      )
    )
      invalid("skill_recording_evidence_base64_invalid");
    const content = Buffer.from(encoded, "base64");
    if (content.toString("base64") !== encoded)
      invalid("skill_recording_evidence_base64_invalid");
    if (
      content.length < 1 ||
      content.length > RECORDING_BUDGETS.maxEvidenceBytes
    )
      invalid("skill_recording_evidence_budget_exceeded");
    totalBytes += content.length;
    if (totalBytes > RECORDING_BUDGETS.maxTotalBytes)
      invalid("skill_recording_evidence_budget_exceeded");
    parsed.push({
      evidenceId: item.evidenceId,
      mediaType: item.mediaType,
      content,
      contentDigest: digest(content),
    });
  }
  return parsed;
}

function decodeEvidenceRows(rows: EvidenceRow[]): EvidenceBytes[] {
  return rows.map((row) => {
    if (
      row.content === null ||
      !(row.content instanceof Uint8Array) ||
      row.actual_bytes !== row.byte_length ||
      row.content.length !== row.byte_length ||
      row.byte_length < 1 ||
      row.byte_length > RECORDING_BUDGETS.maxEvidenceBytes
    )
      corrupt();
    if (row.media_type !== "image/png" && row.media_type !== "image/svg+xml")
      corrupt();
    const content = Buffer.from(row.content);
    if (digest(content) !== row.content_digest) corrupt();
    return {
      evidenceId: row.evidence_id,
      mediaType: row.media_type,
      content,
      contentDigest: row.content_digest,
    };
  });
}

function verifyEvidence(
  recording: RecordingExport,
  evidence: readonly EvidenceBytes[],
): void {
  if (recording.evidence.length !== evidence.length)
    invalid("skill_recording_evidence_incomplete");
  const byId = new Map(evidence.map((item) => [item.evidenceId, item]));
  if (byId.size !== evidence.length)
    invalid("skill_recording_evidence_duplicate");
  let totalBytes = Buffer.byteLength(JSON.stringify(recording));
  for (const expected of recording.evidence) {
    const actual = byId.get(expected.evidenceId);
    if (!actual) invalid("skill_recording_evidence_incomplete");
    if (actual.mediaType !== expected.mediaType)
      invalid("skill_recording_evidence_type_mismatch");
    if (actual.content.length !== expected.byteLength)
      invalid("skill_recording_evidence_length_mismatch");
    if (actual.contentDigest !== expected.contentDigest)
      invalid("skill_recording_evidence_digest_mismatch");
    totalBytes += actual.content.length;
  }
  if (totalBytes > RECORDING_BUDGETS.maxTotalBytes)
    invalid("skill_recording_evidence_budget_exceeded");
}

function checkedScope(scope: SkillScope): SkillScope {
  exactShape(scope, ["tenantId", "spaceId", "ownerActorId"]);
  for (const value of [scope.tenantId, scope.spaceId, scope.ownerActorId]) {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.trim() !== value ||
      Buffer.byteLength(value) > 512 ||
      /[\u0000-\u001f\u007f]/u.test(value)
    )
      invalid("skill_recording_scope_invalid");
  }
  return { ...scope };
}
function checkedSource(source: SkillRecordingSource): SkillRecordingSource {
  exactShape(source, [
    "recordingId",
    "revision",
    "contentDigest",
    "provenance",
  ]);
  id(source.recordingId);
  if (
    !Number.isSafeInteger(source.revision) ||
    source.revision < 1 ||
    typeof source.contentDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(source.contentDigest) ||
    !["recording", "contract-fixture"].includes(source.provenance)
  )
    invalid("skill_recording_source_invalid");
  return { ...source };
}
function scopeArgs(scope: SkillScope): [string, string, string] {
  return [scope.tenantId, scope.spaceId, scope.ownerActorId];
}
function recordingArgs(
  scope: SkillScope,
  source: SkillRecordingSource,
): [string, string, string, string, number] {
  return [...scopeArgs(scope), source.recordingId, source.revision];
}
function id(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  )
    invalid("skill_recording_id_invalid");
}
function exactShape(value: unknown, keys: readonly string[]): void {
  if (
    value === null ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid("skill_recording_shape_invalid");
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some(
      (key) =>
        typeof key !== "string" ||
        !keys.includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"),
    )
  )
    invalid("skill_recording_shape_invalid");
}
function digest(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function invalid(code: string): never {
  throw new ApplicationError("validation", code);
}
function conflict(code: string): never {
  throw new ApplicationError("conflict", code);
}
function corrupt(): never {
  throw new ApplicationError("internal", "skill_recording_store_corrupt");
}
