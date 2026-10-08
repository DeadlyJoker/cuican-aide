import { createHash } from "node:crypto";
import { extensionCanonicalJson } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { ProjectSourceUploadApplicationService } from "./project-source-upload-application-service.ts";
import {
  assertSourceUploadActive,
  assertSourceUploadCurrent,
  captureSourceUploadState,
} from "./project-source-upload-validation.ts";
import type {
  ProjectSourceUploadApplicationDependencies,
  ProjectSourceUploadCommitAuthority,
  ProjectSourceUploadMutationResult,
  ProjectSourceUploadParsedFile,
  ProjectSourceUploadPreparedSource,
  ProjectSourceUploadState,
  ProjectSourceUploadStore,
} from "./project-source-upload-port.ts";
import type { CreativeProjectOwnerScope } from "./creative-project-store-port.ts";
export const uploadActor = {
  tenantId: "tenant",
  spaceId: "space",
  principalId: "principal",
  actorId: "ui",
};
export const uploadSha = (value: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
type Input<K extends keyof ProjectSourceUploadStore> =
  ProjectSourceUploadStore[K] extends (...args: infer A) => unknown
    ? A[0]
    : never;
const key = (owner: CreativeProjectOwnerScope) => extensionCanonicalJson(owner);
const actorOwner = (actor: typeof uploadActor) => ({
  tenantId: actor.tenantId,
  spaceId: actor.spaceId,
  principalId: actor.principalId,
});
/** Application contract fixture only. Actual SQL/CAS/manifest defenses belong to Store integration tests. */
export class MemorySourceUploads implements ProjectSourceUploadStore {
  readonly storageRealmId = "persistent-host-realm";
  readonly states = new Map<string, ProjectSourceUploadState>();
  readonly payloads = new Map<string, Map<number, Uint8Array>>();
  readonly prepared = new Map<string, ProjectSourceUploadPreparedSource>();
  readonly receipts = new Map<
    string,
    { requestDigest: string; result: ProjectSourceUploadMutationResult }
  >();
  readonly calls: string[] = [];
  before: ((method: string) => Promise<void>) | null = null;
  afterCommit: (() => void) | null = null;
  async #enter(method: string, a: ProjectSourceUploadCommitAuthority) {
    this.calls.push(method);
    await this.before?.(method);
    await assertSourceUploadCurrent(a);
  }
  #find(owner: CreativeProjectOwnerScope, uploadId: string) {
    const state = this.states.get(uploadId);
    return state && key(state.initial.owner) === key(owner) ? state : null;
  }
  #owned(input: { actor: typeof uploadActor; uploadId: string }) {
    const s = this.#find(actorOwner(input.actor), input.uploadId);
    if (!s) fail("project_source_upload_not_found");
    return s;
  }
  #cas(s: ProjectSourceUploadState, input: { expectedRevision: number }) {
    if (s.revision !== input.expectedRevision)
      fail("project_source_upload_revision_conflict");
  }
  #commit(s: ProjectSourceUploadState, a: ProjectSourceUploadCommitAuthority) {
    assertSourceUploadActive(a);
    const state = captureSourceUploadState(s);
    this.states.set(state.initial.uploadId, state);
    this.afterCommit?.();
    return Object.freeze({ disposition: "committed" as const, state });
  }
  #replay(state: ProjectSourceUploadState) {
    return Object.freeze({ disposition: "replayed" as const, state });
  }
  async loadBeginReceipt(
    input: Input<"loadBeginReceipt">,
    a: ProjectSourceUploadCommitAuthority,
  ) {
    await this.#enter("loadBeginReceipt", a);
    const row = this.receipts.get(
      key(actorOwner(input.actor)) + input.receipt.idempotencyKey,
    );
    if (!row) return null;
    if (row.requestDigest !== input.receipt.requestDigest)
      fail("project_source_upload_idempotency_conflict");
    return this.#replay(row.result.state);
  }
  async begin(input: Input<"begin">, a: ProjectSourceUploadCommitAuthority) {
    await this.#enter("begin", a);
    const receiptKey =
        key(actorOwner(input.actor)) + input.receipt.idempotencyKey,
      row = this.receipts.get(receiptKey);
    if (row) {
      if (row.requestDigest !== input.receipt.requestDigest)
        fail("project_source_upload_idempotency_conflict");
      return this.#replay(row.result.state);
    }
    const result = this.#commit(
      {
        initial: input.initial,
        revision: 1,
        phase: "receiving",
        updatedAt: input.initial.createdAt,
        parts: [],
        sealed: null,
        claim: null,
        prepared: null,
        failureCode: null,
      },
      a,
    );
    this.payloads.set(input.initial.uploadId, new Map());
    this.receipts.set(receiptKey, {
      requestDigest: input.receipt.requestDigest,
      result,
    });
    return result;
  }
  async load(input: Input<"load">, a: ProjectSourceUploadCommitAuthority) {
    await this.#enter("load", a);
    return this.#find(input.owner, input.uploadId);
  }
  async writePart(
    input: Input<"writePart">,
    a: ProjectSourceUploadCommitAuthority,
  ) {
    await this.#enter("writePart", a);
    const s = this.#owned(input),
      original = s.parts.find((p) => p.index === input.part.index);
    if (original) {
      if (
        extensionCanonicalJson(original) !==
          extensionCanonicalJson(input.part) ||
        uploadSha(input.bytes) !== original.rawDigest
      )
        fail("project_source_upload_part_conflict");
      return this.#replay(s);
    }
    this.#cas(s, input);
    if (s.phase !== "receiving") fail("project_source_upload_phase_conflict");
    if (uploadSha(input.bytes) !== input.part.rawDigest)
      fail("project_source_upload_part_digest_mismatch");
    this.payloads
      .get(input.uploadId)!
      .set(input.part.index, new Uint8Array(input.bytes));
    return this.#commit(
      {
        ...s,
        revision: s.revision + 1,
        updatedAt: input.at,
        parts: [...s.parts, input.part].sort((l, r) => l.index - r.index),
      },
      a,
    );
  }
  #raw(s: ProjectSourceUploadState) {
    const bytes = new Uint8Array(s.initial.byteLength);
    for (const p of s.parts) {
      const raw = this.payloads.get(s.initial.uploadId)?.get(p.index);
      if (!raw || raw.length !== p.byteLength || uploadSha(raw) !== p.rawDigest)
        fail("project_source_upload_raw_integrity_failure");
      bytes.set(raw, p.byteOffset);
    }
    return bytes;
  }
  async sealRaw(
    input: Input<"sealRaw">,
    a: ProjectSourceUploadCommitAuthority,
  ) {
    await this.#enter("sealRaw", a);
    const s = this.#owned(input);
    if (s.sealed) return this.#replay(s);
    this.#cas(s, input);
    if (s.parts.length !== s.initial.partCount)
      fail("project_source_upload_parts_missing");
    if (uploadSha(this.#raw(s)) !== s.initial.fileDigest)
      fail("project_source_upload_file_digest_mismatch");
    return this.#commit(
      {
        ...s,
        revision: s.revision + 1,
        phase: "raw-sealed",
        updatedAt: input.at,
        sealed: {
          uploadDigest: uploadSha(
            extensionCanonicalJson({ initial: s.initial, parts: s.parts }),
          ),
          sealedAt: input.at,
        },
      },
      a,
    );
  }
  async claimPreparation(
    input: Input<"claimPreparation">,
    a: ProjectSourceUploadCommitAuthority,
  ) {
    await this.#enter("claimPreparation", a);
    const s = this.#owned(input);
    if (
      s.phase === "ready" ||
      (s.phase === "preparing" && s.claim!.expiresAt > input.at)
    )
      return { disposition: "existing" as const, state: s };
    this.#cas(s, input);
    if (s.phase !== "raw-sealed" && s.phase !== "preparing")
      fail("project_source_upload_phase_conflict");
    return {
      disposition: "claimed" as const,
      state: this.#commit(
        {
          ...s,
          revision: s.revision + 1,
          phase: "preparing",
          updatedAt: input.at,
          claim: input.claim,
        },
        a,
      ).state,
    };
  }
  async loadRawBytes(
    input: Input<"loadRawBytes">,
    a: ProjectSourceUploadCommitAuthority,
  ) {
    await this.#enter("loadRawBytes", a);
    const s = this.#find(input.owner, input.uploadId);
    if (
      !s ||
      s.phase !== "preparing" ||
      s.sealed!.uploadDigest !== input.uploadDigest ||
      s.claim!.claimId !== input.claimId
    )
      fail("project_source_upload_claim_mismatch");
    return this.#raw(s);
  }
  async completePreparation(
    input: Input<"completePreparation">,
    a: ProjectSourceUploadCommitAuthority,
  ) {
    await this.#enter("completePreparation", a);
    const s = this.#owned(input);
    this.#cas(s, input);
    if (
      s.phase !== "preparing" ||
      s.claim!.claimId !== input.claimId ||
      s.claim!.expiresAt <= input.at
    )
      fail("project_source_upload_claim_mismatch");
    const parsed = input.parsed,
      pointer = {
        version: "crewon.project-source-upload-prepared.v1" as const,
        storageRealmId: this.storageRealmId,
        uploadId: input.uploadId,
        uploadDigest: s.sealed!.uploadDigest,
        preparedDigest: uploadSha("prepared:" + parsed.digest),
        normalizationParserVersion: s.claim!.normalizationParserVersion,
      };
    const manifest = {
      pointer,
      digest: parsed.digest,
      normalizedByteLength: new TextEncoder().encode(
        parsed.chunks.map((c) => c.content).join(""),
      ).length,
      characterLength: parsed.characterLength,
      chunkCount: parsed.chunks.length,
      chapterCount: parsed.chapters.length,
      chunkManifestDigest: uploadSha("chunks:" + parsed.digest),
      chapterManifestDigest: uploadSha("chapters:" + parsed.digest),
      preparedAt: input.at,
    };
    assertSourceUploadActive(a);
    this.prepared.set(input.uploadId, {
      ...parsed,
      owner: s.initial.owner,
      uploadId: input.uploadId,
      provenance: pointer,
    });
    return this.#commit(
      {
        ...s,
        revision: s.revision + 1,
        phase: "ready",
        updatedAt: input.at,
        prepared: manifest,
      },
      a,
    );
  }
  async rejectPreparation(
    input: Input<"rejectPreparation">,
    a: ProjectSourceUploadCommitAuthority,
  ) {
    await this.#enter("rejectPreparation", a);
    const s = this.#owned(input);
    this.#cas(s, input);
    if (s.phase !== "preparing" || s.claim!.claimId !== input.claimId)
      fail("project_source_upload_claim_mismatch");
    return this.#commit(
      {
        ...s,
        revision: s.revision + 1,
        phase: "rejected",
        updatedAt: input.at,
        failureCode: input.failureCode,
      },
      a,
    );
  }
  async cancel(input: Input<"cancel">, a: ProjectSourceUploadCommitAuthority) {
    await this.#enter("cancel", a);
    const s = this.#owned(input);
    if (s.phase === "cancelled") return this.#replay(s);
    this.#cas(s, input);
    if (["ready", "rejected", "expired"].includes(s.phase))
      fail("project_source_upload_phase_conflict");
    return this.#commit(
      {
        ...s,
        revision: s.revision + 1,
        phase: "cancelled",
        updatedAt: input.at,
      },
      a,
    );
  }
  async loadPrepared(
    input: Input<"loadPrepared">,
    a: ProjectSourceUploadCommitAuthority,
  ) {
    await this.#enter("loadPrepared", a);
    const s = this.#find(input.owner, input.uploadId);
    if (!s || s.phase !== "ready" || s.initial.fileDigest !== input.fileDigest)
      return null;
    return this.prepared.get(input.uploadId) ?? null;
  }
}
function fail(code: string): never {
  throw new ApplicationError("conflict", code);
}
export function sourceUploadFixture() {
  const store = new MemorySourceUploads();
  const flags = {
    active: true,
    now: "2026-10-08T00:00:00.000Z",
    ids: 0,
    claims: 0,
    parses: 0,
    permissionActions: [] as string[],
    denyAction: null as string | null,
    parser: null as
      | ((input: {
          fileName: string;
          format: "txt" | "md" | "html";
          bytes: Uint8Array;
        }) => Promise<ProjectSourceUploadParsedFile>)
      | null,
  };
  const dependencies: ProjectSourceUploadApplicationDependencies = {
    store,
    authorization: {
      async authorize(permission) {
        flags.permissionActions.push(permission.action);
        return flags.active && flags.denyAction !== permission.action
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "denied" };
      },
      assertActive() {
        if (!flags.active)
          throw new ApplicationError("authorization", "withdrawn");
      },
    },
    bytes: {
      capture(raw, options) {
        if (!(raw instanceof Uint8Array)) throw new Error("bad_bytes");
        const bytes = new Uint8Array(raw);
        if (
          bytes.length > options.maximumBytes ||
          (options.expectedBytes !== null &&
            bytes.length !== options.expectedBytes)
        )
          throw new Error("bad_bytes");
        return bytes;
      },
      sha256: uploadSha,
    },
    parser: {
      normalizationParserVersion: "source-normalization-v1",
      async parse(input) {
        flags.parses++;
        if (flags.parser) return flags.parser(input);
        return simpleParsed(input);
      },
    },
    clock: { now: () => flags.now },
    digester: { sha256: uploadSha },
    ids: {
      nextUploadId: () => `upload-${++flags.ids}`,
      nextClaimId: () => `claim-${++flags.claims}`,
    },
    preparationClaimTtlMs: 30_000,
  };
  const service = new ProjectSourceUploadApplicationService(dependencies);
  return { store, flags, dependencies, service };
}
export function simpleParsed(input: {
  fileName: string;
  format: "txt" | "md" | "html";
  bytes: Uint8Array;
}): ProjectSourceUploadParsedFile {
  const text = new TextDecoder("utf-8", { fatal: true })
      .decode(input.bytes)
      .replace(/\r\n?/gu, "\n"),
    chunks: ProjectSourceUploadParsedFile["chunks"][number][] = [];
  let offset = 0;
  // Existing media parser owns actual encoding/HTML behavior. This fixture only returns valid canonical data.
  for (let i = 0; i < text.length; ) {
    let content = text.slice(i, i + 4096);
    if (/[\uD800-\uDBFF]$/u.test(content)) content = content.slice(0, -1);
    while (new TextEncoder().encode(content).length > 4096) {
      content = content.slice(0, -1);
      if (/[\uD800-\uDBFF]$/u.test(content)) content = content.slice(0, -1);
    }
    chunks.push({
      index: chunks.length,
      startOffset: offset,
      content,
      digest: uploadSha(content),
    });
    offset += [...content].length;
    i += content.length;
  }
  return {
    fileName: input.fileName,
    format: input.format,
    byteLength: input.bytes.length,
    fileDigest: uploadSha(input.bytes),
    digest: uploadSha(text),
    characterLength: offset,
    chunks,
    chapters: [
      {
        chapterId: "chapter-000001",
        title: "正文",
        startOffset: 0,
        endOffset: offset,
      },
    ],
  };
}
export async function beginAndWrite(
  f: ReturnType<typeof sourceUploadFixture>,
  bytes = new TextEncoder().encode("第一章\r\n😀初见"),
) {
  const command = {
    idempotencyKey: "initial-book",
    fileName: "原文.txt",
    format: "txt" as const,
    byteLength: bytes.length,
    fileDigest: uploadSha(bytes),
  };
  let state = (await f.service.begin(uploadActor, command)).state;
  for (
    let index = 0, offset = 0;
    offset < bytes.length;
    index++, offset += 65536
  ) {
    const part = bytes.slice(offset, Math.min(bytes.length, offset + 65536));
    state = (
      await f.service.writePart(uploadActor, {
        uploadId: state.initial.uploadId,
        expectedRevision: state.revision,
        index,
        byteOffset: offset,
        rawDigest: uploadSha(part),
        bytes: part,
      })
    ).state;
  }
  return { command, state, bytes };
}
