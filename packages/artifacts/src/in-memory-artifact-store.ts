import { createHash } from "node:crypto";

import {
  ArtifactStoreError,
  type ArtifactContent,
  type ArtifactLocator,
  type ArtifactStorePort,
  type PutArtifactInput,
  type PutArtifactResult,
} from "@crewon/application";
import { parseArtifactRecord, type ArtifactRecord } from "@crewon/domain";

type StoredArtifact = Readonly<{
  record: ArtifactRecord;
  content: Uint8Array;
  fingerprint: string;
}>;

/** Process-local adapter for deterministic tests; it is never a durable deployment authority. */
export class InMemoryArtifactStore implements ArtifactStorePort {
  readonly #artifacts = new Map<string, StoredArtifact>();
  readonly #idempotency = new Map<string, string>();
  #closed = false;

  async put(input: PutArtifactInput): Promise<PutArtifactResult> {
    this.#assertOpen();
    const record = parseArtifactRecord(input.record);
    const content = new Uint8Array(input.content);
    validateContent(record, content);
    const key = idempotencyKey(record.tenantId, input.idempotencyKey);
    const fingerprint = semanticFingerprint(record);
    const priorId = this.#idempotency.get(key);
    if (priorId !== undefined) {
      const prior = this.#artifacts.get(scopedKey(record.tenantId, priorId));
      if (prior === undefined || prior.fingerprint !== fingerprint) {
        throw new ArtifactStoreError("artifact_idempotency_conflict");
      }
      return {
        disposition: "replayed",
        record: structuredClone(prior.record),
      };
    }
    const artifactKey = scopedKey(record.tenantId, record.artifactId);
    if (this.#artifacts.has(artifactKey)) {
      throw new ArtifactStoreError("artifact_id_conflict");
    }
    this.#idempotency.set(key, record.artifactId);
    this.#artifacts.set(artifactKey, {
      record: structuredClone(record),
      content,
      fingerprint,
    });
    return { disposition: "created", record: structuredClone(record) };
  }

  async get(locator: ArtifactLocator): Promise<ArtifactRecord | null> {
    this.#assertOpen();
    const stored = this.#artifacts.get(
      scopedKey(locator.tenantId, locator.artifactId),
    );
    return stored === undefined ? null : structuredClone(stored.record);
  }

  async read(locator: ArtifactLocator): Promise<ArtifactContent | null> {
    this.#assertOpen();
    const stored = this.#artifacts.get(
      scopedKey(locator.tenantId, locator.artifactId),
    );
    return stored === undefined
      ? null
      : {
          record: structuredClone(stored.record),
          content: new Uint8Array(stored.content),
        };
  }

  async close(): Promise<void> {
    this.#artifacts.clear();
    this.#idempotency.clear();
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ArtifactStoreError("artifact_store_closed");
    }
  }
}

function validateContent(record: ArtifactRecord, content: Uint8Array): void {
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  if (
    content.byteLength !== record.byteLength ||
    digest !== record.contentDigest
  ) {
    throw new ArtifactStoreError("artifact_content_mismatch");
  }
}

function semanticFingerprint(record: ArtifactRecord): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        tenantId: record.tenantId,
        spaceId: record.spaceId,
        ownerActorId: record.ownerActorId,
        kind: record.kind,
        mediaType: record.mediaType,
        sensitivity: record.sensitivity,
        source: record.source,
        contentDigest: record.contentDigest,
        byteLength: record.byteLength,
        retentionKind: record.retention.kind,
      }),
    )
    .digest("hex");
}

function scopedKey(tenantId: string, value: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(tenantId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  ) {
    throw new ArtifactStoreError("artifact_locator_invalid");
  }
  return `${tenantId}\0${value}`;
}

function idempotencyKey(tenantId: string, value: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(tenantId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,1023}$/u.test(value)
  ) {
    throw new ArtifactStoreError("artifact_idempotency_key_invalid");
  }
  return `${tenantId}\0${value}`;
}
