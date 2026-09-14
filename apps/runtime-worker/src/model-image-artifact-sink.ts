import { createHash } from "node:crypto";
import type { ResponsesImageSink } from "@crewon/agent-responses";
import type { ArtifactStorePort, RunStore } from "@crewon/application";
import { createArtifactRecord } from "@crewon/domain";

/** The trusted Run store supplies ownership; provider fields never choose access scope. */
export class ModelImageArtifactSink implements ResponsesImageSink {
  readonly #artifacts: ArtifactStorePort;
  readonly #keyId: string;
  readonly #tenantId: string;
  #runs: Pick<RunStore, "loadRun"> | undefined;

  constructor(config: {
    artifacts: ArtifactStorePort;
    keyId: string;
    tenantId: string;
  }) {
    this.#artifacts = config.artifacts;
    this.#keyId = config.keyId;
    this.#tenantId = config.tenantId;
  }

  bindRunStore(runs: Pick<RunStore, "loadRun">): void {
    if (this.#runs !== undefined && this.#runs !== runs) {
      throw new Error("model_image_authority_already_bound");
    }
    this.#runs = runs;
  }

  async persist(
    input: Parameters<ResponsesImageSink["persist"]>[0],
    signal: AbortSignal,
  ): Promise<{ artifactRef: string }> {
    signal.throwIfAborted();
    if (this.#runs === undefined)
      throw new Error("model_image_authority_unavailable");
    if (
      [input.runId, input.segmentId, input.itemId].some(
        (id) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(id),
      )
    ) {
      throw new Error("model_image_identity_invalid");
    }
    if (
      input.bytes.byteLength < 1 ||
      input.bytes.byteLength > 8 * 1024 * 1024
    ) {
      throw new Error("model_image_content_too_large");
    }
    const run = await this.#runs.loadRun({
      tenantId: this.#tenantId,
      runId: input.runId,
    });
    signal.throwIfAborted();
    if (
      run === null ||
      run.tenantId !== this.#tenantId ||
      run.runId !== input.runId ||
      run.status !== "running" ||
      run.cancelRequested
    ) {
      throw new Error("model_image_run_authority_invalid");
    }
    const createdAt = new Date().toISOString();
    const content = new Uint8Array(input.bytes);
    const identity = createHash("sha256")
      .update(JSON.stringify([run.tenantId, run.runId, input.itemId]))
      .digest("hex");
    const contentDigest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const existing = await this.#artifacts.get({
      tenantId: run.tenantId,
      artifactId: `artifact-${identity}`,
    });
    signal.throwIfAborted();
    if (existing !== null) {
      if (
        existing.tenantId !== run.tenantId ||
        existing.artifactId !== `artifact-${identity}` ||
        existing.kind !== "modelImage" ||
        existing.source.kind !== "modelImage" ||
        existing.source.runId !== run.runId ||
        existing.source.itemId !== input.itemId ||
        existing.spaceId !== run.spaceId ||
        existing.ownerActorId !== run.createdByActorId ||
        existing.mediaType !== input.mimeType ||
        existing.contentDigest !== contentDigest ||
        existing.byteLength !== content.byteLength ||
        existing.scan.status === "blocked" ||
        Date.parse(existing.retention.expiresAt) <= Date.now()
      ) {
        throw new Error("model_image_replay_conflict");
      }
      return { artifactRef: existing.artifactId };
    }
    const record = createArtifactRecord({
      schemaVersion: "crewon.artifact.v0",
      artifactId: `artifact-${identity}`,
      tenantId: run.tenantId,
      spaceId: run.spaceId,
      ownerActorId: run.createdByActorId,
      kind: "modelImage",
      mediaType: input.mimeType,
      sensitivity: "workspaceSensitive",
      source: {
        kind: "modelImage",
        runId: run.runId,
        segmentId: input.segmentId,
        itemId: input.itemId,
      },
      contentDigest,
      byteLength: content.byteLength,
      retention: {
        kind: "run",
        expiresAt: new Date(
          Date.parse(createdAt) + 30 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      },
      encryption: { scheme: "aes256gcm", keyId: this.#keyId },
      scan: { status: "notRequired", scannedAt: null, scanner: null },
      createdAt,
    });
    const idempotencyKey = `model-image:${identity}`;
    const result = await this.#artifacts.put({
      record,
      content,
      idempotencyKey,
    });
    signal.throwIfAborted();
    const saved = { record: createArtifactRecord(result.record) };
    if (
      saved.record.artifactId !== record.artifactId ||
      saved.record.scan.status === "blocked" ||
      saved.record.tenantId !== record.tenantId ||
      saved.record.spaceId !== record.spaceId ||
      saved.record.ownerActorId !== record.ownerActorId ||
      saved.record.kind !== record.kind ||
      saved.record.mediaType !== record.mediaType ||
      saved.record.contentDigest !== record.contentDigest ||
      saved.record.byteLength !== record.byteLength ||
      saved.record.source.kind !== "modelImage" ||
      saved.record.source.runId !== run.runId ||
      saved.record.source.itemId !== input.itemId
    ) {
      throw new Error("model_image_store_result_invalid");
    }
    return { artifactRef: saved.record.artifactId };
  }
}
