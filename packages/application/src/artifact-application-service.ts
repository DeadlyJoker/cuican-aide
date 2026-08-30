import { createArtifactRecord, type ArtifactRecord } from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type {
  ArtifactContent,
  ArtifactStorePort,
} from "./artifact-store-port.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import { canonicalJson } from "./canonical-json.ts";

export type ToolOutputArtifactInput = Readonly<{
  tenantId: string;
  spaceId: string;
  ownerActorId: string;
  runId: string;
  stepId: string;
  attemptId: string;
  callId: string;
  output: string;
  idempotencyKey: string;
  maxArtifactBytes: number;
}>;

type ToolOutputArtifactIdentity = Readonly<{
  tenantId: string;
  spaceId: string;
  ownerActorId: string;
  artifactId: string;
  runId: string;
  stepId: string;
  attemptId: string;
  callId: string;
}>;

export type ToolOutputArtifactLocator = ToolOutputArtifactIdentity &
  (
    | Readonly<{ verification: "content"; output: string }>
    | Readonly<{ verification: "provenance" }>
  );

/** Creates and verifies authoritative Artifact references for Tool outputs. */
export interface ToolOutputArtifactPort {
  persistToolOutput(input: ToolOutputArtifactInput): Promise<ArtifactRecord>;
  requireToolOutputReference(
    locator: ToolOutputArtifactLocator,
  ): Promise<ArtifactRecord>;
}

/** Owns Tool-output Artifact creation and authorized reads without exposing blob paths. */
export class ArtifactApplicationService implements ToolOutputArtifactPort {
  readonly #store: ArtifactStorePort;
  readonly #authorization: AuthorizationPort;
  readonly #clock: ApplicationClock;
  readonly #ids: ApplicationIdGenerator;
  readonly #digester: ContentDigester;
  readonly #encryptionKeyId: string;
  readonly #retentionMs: number;

  constructor(config: {
    store: ArtifactStorePort;
    authorization: AuthorizationPort;
    clock: ApplicationClock;
    ids: ApplicationIdGenerator;
    digester: ContentDigester;
    encryptionKeyId: string;
    retentionMs?: number;
  }) {
    requireOpaqueId(config.encryptionKeyId, "artifact_encryption_key_invalid");
    const retentionMs = config.retentionMs ?? 30 * 24 * 60 * 60 * 1_000;
    if (
      !Number.isSafeInteger(retentionMs) ||
      retentionMs < 60_000 ||
      retentionMs > 365 * 24 * 60 * 60 * 1_000
    ) {
      throw new ApplicationError("validation", "artifact_retention_invalid");
    }
    this.#store = config.store;
    this.#authorization = config.authorization;
    this.#clock = config.clock;
    this.#ids = config.ids;
    this.#digester = config.digester;
    this.#encryptionKeyId = config.encryptionKeyId;
    this.#retentionMs = retentionMs;
  }

  async persistToolOutput(
    input: ToolOutputArtifactInput,
  ): Promise<ArtifactRecord> {
    validateToolOutputInput(input);
    const content = new TextEncoder().encode(input.output);
    if (content.byteLength > input.maxArtifactBytes) {
      throw new ApplicationError("validation", "artifact_content_too_large");
    }
    const createdAt = this.#clock.now();
    const createdAtMs = Date.parse(createdAt);
    if (!Number.isFinite(createdAtMs)) {
      throw new ApplicationError("internal", "artifact_clock_invalid");
    }
    const record = createArtifactRecord({
      schemaVersion: "crewon.artifact.v0",
      artifactId: this.#ids.nextId("artifact"),
      tenantId: input.tenantId,
      spaceId: input.spaceId,
      ownerActorId: input.ownerActorId,
      kind: "toolOutput",
      mediaType: "text/plain",
      sensitivity: "workspaceSensitive",
      source: {
        kind: "toolOutput",
        runId: input.runId,
        stepId: input.stepId,
        attemptId: input.attemptId,
        callId: input.callId,
      },
      contentDigest: this.#digester.sha256(input.output),
      byteLength: content.byteLength,
      retention: {
        kind: "run",
        expiresAt: new Date(createdAtMs + this.#retentionMs).toISOString(),
      },
      encryption: { scheme: "aes256gcm", keyId: this.#encryptionKeyId },
      scan: { status: "notRequired", scannedAt: null, scanner: null },
      createdAt,
    });
    const result = await this.#store.put({
      record,
      content,
      idempotencyKey: input.idempotencyKey,
    });
    if (!sameToolOutputSemantics(result.record, record)) {
      throw new ApplicationError("internal", "artifact_store_result_invalid");
    }
    return result.record;
  }

  async requireToolOutputReference(
    locator: ToolOutputArtifactLocator,
  ): Promise<ArtifactRecord> {
    validateToolOutputLocator(locator);
    const record = await this.#store.get(locator);
    if (
      record === null ||
      record.spaceId !== locator.spaceId ||
      record.ownerActorId !== locator.ownerActorId ||
      record.kind !== "toolOutput" ||
      record.source.runId !== locator.runId ||
      record.source.stepId !== locator.stepId ||
      record.source.attemptId !== locator.attemptId ||
      record.source.callId !== locator.callId ||
      record.scan.status === "blocked" ||
      this.#expired(record) ||
      (locator.verification === "content" &&
        (record.byteLength !==
          new TextEncoder().encode(locator.output).byteLength ||
          record.contentDigest !== this.#digester.sha256(locator.output)))
    ) {
      throw new ApplicationError("notFound", "artifact_not_found");
    }
    return record;
  }

  async getArtifact(
    actor: ActorContext,
    artifactId: string,
  ): Promise<ArtifactRecord> {
    return this.#authorizedArtifactMetadata(actor, artifactId, "metadata");
  }

  async readArtifact(
    actor: ActorContext,
    artifactId: string,
  ): Promise<ArtifactContent> {
    const record = await this.#authorizedArtifactMetadata(
      actor,
      artifactId,
      "content",
    );
    const stored = await this.#store.read({
      tenantId: actor.tenantId,
      artifactId,
    });
    if (
      stored === null ||
      !sameArtifactRecord(stored.record, record) ||
      !contentMatchesRecord(stored.content, record, this.#digester)
    ) {
      throw new ApplicationError("internal", "artifact_store_result_invalid");
    }
    return {
      record: structuredClone(stored.record),
      content: new Uint8Array(stored.content),
    };
  }

  async #authorizedArtifactMetadata(
    actor: ActorContext,
    artifactId: string,
    access: "metadata" | "content",
  ): Promise<ArtifactRecord> {
    requireOpaqueId(artifactId, "artifact_id_invalid");
    const record = await this.#store.get({
      tenantId: actor.tenantId,
      artifactId,
    });
    if (
      record === null ||
      record.tenantId !== actor.tenantId ||
      record.spaceId !== actor.spaceId
    ) {
      throw new ApplicationError("notFound", "artifact_not_found");
    }
    if (record.artifactId !== artifactId) {
      throw new ApplicationError("internal", "artifact_store_result_invalid");
    }
    const decision = await this.#authorization.authorize({
      actor,
      action: "artifact:read",
      resource: {
        kind: "artifact",
        tenantId: record.tenantId,
        spaceId: record.spaceId,
        artifactId: record.artifactId,
        ownerActorId: record.ownerActorId,
        runId: record.source.runId,
      },
    });
    if (decision.outcome !== "allow") {
      throw new ApplicationError("authorization", decision.reasonCode);
    }
    if (this.#expired(record)) {
      throw new ApplicationError("notFound", "artifact_expired");
    }
    if (access === "content" && record.scan.status === "blocked") {
      throw new ApplicationError("notFound", "artifact_not_found");
    }
    return structuredClone(record);
  }

  #expired(record: ArtifactRecord): boolean {
    const now = Date.parse(this.#clock.now());
    if (!Number.isFinite(now)) {
      throw new ApplicationError("internal", "artifact_clock_invalid");
    }
    return Date.parse(record.retention.expiresAt) <= now;
  }
}

function sameArtifactRecord(
  actual: ArtifactRecord,
  expected: ArtifactRecord,
): boolean {
  try {
    return canonicalJson(actual) === canonicalJson(expected);
  } catch {
    return false;
  }
}

function contentMatchesRecord(
  content: Uint8Array,
  record: ArtifactRecord,
  digester: ContentDigester,
): boolean {
  if (content.byteLength !== record.byteLength) {
    return false;
  }
  try {
    const value = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(content);
    return digester.sha256(value) === record.contentDigest;
  } catch {
    return false;
  }
}

function sameToolOutputSemantics(
  actual: ArtifactRecord,
  requested: ArtifactRecord,
): boolean {
  return (
    actual.tenantId === requested.tenantId &&
    actual.spaceId === requested.spaceId &&
    actual.ownerActorId === requested.ownerActorId &&
    actual.kind === requested.kind &&
    actual.mediaType === requested.mediaType &&
    actual.sensitivity === requested.sensitivity &&
    actual.contentDigest === requested.contentDigest &&
    actual.byteLength === requested.byteLength &&
    actual.retention.kind === requested.retention.kind &&
    actual.encryption.scheme === requested.encryption.scheme &&
    actual.encryption.keyId === requested.encryption.keyId &&
    actual.source.kind === requested.source.kind &&
    actual.source.runId === requested.source.runId &&
    actual.source.stepId === requested.source.stepId &&
    actual.source.attemptId === requested.source.attemptId &&
    actual.source.callId === requested.source.callId
  );
}

function validateToolOutputInput(input: ToolOutputArtifactInput): void {
  for (const value of [
    input.tenantId,
    input.spaceId,
    input.ownerActorId,
    input.runId,
    input.stepId,
    input.attemptId,
    input.callId,
  ]) {
    requireOpaqueId(value, "artifact_input_invalid");
  }
  requireIdempotencyKey(input.idempotencyKey);
  if (
    typeof input.output !== "string" ||
    input.output.length === 0 ||
    !Number.isSafeInteger(input.maxArtifactBytes) ||
    input.maxArtifactBytes < 1 ||
    input.maxArtifactBytes > 1024 * 1024 * 1024
  ) {
    throw new ApplicationError("validation", "artifact_input_invalid");
  }
}

function requireIdempotencyKey(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,1023}$/u.test(value)
  ) {
    throw new ApplicationError(
      "validation",
      "artifact_idempotency_key_invalid",
    );
  }
}

function validateToolOutputLocator(locator: ToolOutputArtifactLocator): void {
  for (const value of [
    locator.tenantId,
    locator.spaceId,
    locator.ownerActorId,
    locator.artifactId,
    locator.runId,
    locator.stepId,
    locator.attemptId,
    locator.callId,
  ]) {
    requireOpaqueId(value, "artifact_locator_invalid");
  }
  if (
    (locator.verification !== "content" &&
      locator.verification !== "provenance") ||
    (locator.verification === "content" && typeof locator.output !== "string")
  ) {
    throw new ApplicationError("validation", "artifact_locator_invalid");
  }
}

function requireOpaqueId(
  value: unknown,
  code: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  ) {
    throw new ApplicationError("validation", code);
  }
}
