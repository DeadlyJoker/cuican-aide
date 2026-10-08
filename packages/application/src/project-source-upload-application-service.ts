import {
  creativeProjectDigest,
  creativeProjectOpaqueId,
  creativeProjectRevision,
  creativeProjectTimestamp,
  extensionCanonicalJson,
  validateCreativeProjectActor,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import { capturePreparedProjectSource } from "./project-source-preparation-port.ts";
import {
  PROJECT_SOURCE_UPLOAD_MAX_BYTES,
  PROJECT_SOURCE_UPLOAD_PART_BYTES,
  type ProjectSourceUploadAction,
  type ProjectSourceUploadApplicationDependencies,
  type ProjectSourceUploadCommitAuthority,
  type ProjectSourceUploadInitial,
  type ProjectSourceUploadMutationResult,
  type ProjectSourceUploadParsedFile,
  type ProjectSourceUploadState,
} from "./project-source-upload-port.ts";
import {
  assertSourceUploadActive,
  assertSourceUploadCurrent,
  captureSourceUploadAuthority,
  captureSourceUploadClaim,
  captureSourceUploadInitial,
  captureSourceUploadPart,
  captureSourceUploadPermission,
  captureSourceUploadPrepared,
  captureSourceUploadState,
  sourceUploadFields,
  sourceUploadInteger,
} from "./project-source-upload-validation.ts";

export type BeginProjectSourceUploadCommand = Readonly<{
  idempotencyKey: string;
  fileName: string;
  format: "txt" | "md" | "html";
  byteLength: number;
  fileDigest: string;
}>;
export type ProjectSourceUploadCommand = Readonly<{
  uploadId: string;
  expectedRevision: number;
}>;
export type WriteProjectSourceUploadPartCommand = ProjectSourceUploadCommand &
  Readonly<{
    index: number;
    byteOffset: number;
    rawDigest: string;
    bytes: Uint8Array;
  }>;
export type ProjectSourceUploadPreparationResult = Readonly<{
  disposition: "ready" | "pending" | "rejected";
  state: ProjectSourceUploadState;
}>;
const byteLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)!.get!;
const parsedFields = [
  "fileName",
  "format",
  "byteLength",
  "characterLength",
  "digest",
  "fileDigest",
  "chunks",
  "chapters",
];
const contentFailures = new Set([
  "project_source_import_binary_content",
  "project_source_import_control_content",
  "project_source_import_encoding_invalid",
  "project_source_import_unicode_invalid",
  "project_source_import_empty_text",
  "project_source_import_empty_file",
  "project_source_import_format_mismatch",
  "project_source_import_file_limit",
  "project_source_import_text_limit",
  "project_source_import_chapter_limit",
  "project_source_import_chapter_range_invalid",
  "project_source_import_chapter_title_limit",
  "project_source_import_html_depth_limit",
  "project_source_import_html_node_limit",
]);

/** Scope-owned uploads only. No product registration, project creation, model call or supplier dispatch. */
export class ProjectSourceUploadApplicationService {
  readonly #d: ProjectSourceUploadApplicationDependencies;
  constructor(input: ProjectSourceUploadApplicationDependencies) {
    const ttl = sourceUploadInteger(
      input.preparationClaimTtlMs,
      1_000,
      300_000,
    );
    const store = input.store;
    const methods = [
      "loadBeginReceipt",
      "begin",
      "load",
      "writePart",
      "sealRaw",
      "claimPreparation",
      "loadRawBytes",
      "completePreparation",
      "rejectPreparation",
      "cancel",
      "loadPrepared",
    ] as const;
    const captured = Object.fromEntries(
      methods.map((m) => [m, bound(store, m)]),
    ) as unknown as ProjectSourceUploadApplicationDependencies["store"];
    // The persisted realm is unavailable before explicit migration/first authorized schema read.
    Object.defineProperty(captured, "storageRealmId", {
      enumerable: true,
      get: () => store.storageRealmId,
    });
    const version = Object.getOwnPropertyDescriptor(
      input.parser,
      "normalizationParserVersion",
    );
    if (!version || !Object.hasOwn(version, "value"))
      fail("internal", "project_source_upload_dependency_invalid");
    this.#d = Object.freeze({
      store: Object.freeze(captured),
      authorization: Object.freeze({
        authorize: bound(input.authorization, "authorize"),
        assertActive: bound(input.authorization, "assertActive"),
      }),
      bytes: Object.freeze({
        capture: bound(input.bytes, "capture"),
        sha256: bound(input.bytes, "sha256"),
      }),
      parser: Object.freeze({
        normalizationParserVersion: creativeProjectOpaqueId(version.value),
        parse: bound(input.parser, "parse"),
      }),
      clock: Object.freeze({ now: bound(input.clock, "now") }),
      digester: Object.freeze({ sha256: bound(input.digester, "sha256") }),
      ids: Object.freeze({
        nextUploadId: bound(input.ids, "nextUploadId"),
        nextClaimId: bound(input.ids, "nextClaimId"),
      }),
      preparationClaimTtlMs: ttl,
    });
  }
  async begin(
    actorInput: ActorContext,
    input: BeginProjectSourceUploadCommand,
  ): Promise<ProjectSourceUploadMutationResult> {
    const actor = validateCreativeProjectActor(actorInput),
      v = sourceUploadFields(input, [
        "idempotencyKey",
        "fileName",
        "format",
        "byteLength",
        "fileDigest",
      ]);
    const idempotencyKey = creativeProjectOpaqueId(v.idempotencyKey),
      scope = owner(actor),
      fileDigest = creativeProjectDigest(v.fileDigest);
    const metadata = captureSourceUploadInitial({
      schemaVersion: "crewon.project-source-upload.v1",
      storageRealmId: "validation-realm",
      uploadId: "validation-upload",
      owner: scope,
      fileName: v.fileName,
      format: v.format,
      byteLength: v.byteLength,
      fileDigest,
      partBytes: PROJECT_SOURCE_UPLOAD_PART_BYTES,
      partCount: Math.ceil(
        sourceUploadInteger(v.byteLength, 1, PROJECT_SOURCE_UPLOAD_MAX_BYTES) /
          PROJECT_SOURCE_UPLOAD_PART_BYTES,
      ),
      requestDigest: fileDigest,
      createdByActorId: actor.actorId,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const command = {
      idempotencyKey,
      fileName: metadata.fileName,
      format: metadata.format,
      byteLength: metadata.byteLength,
      fileDigest,
    };
    const receipt = Object.freeze({
      idempotencyKey,
      requestDigest: creativeProjectDigest(
        this.#d.digester.sha256(
          extensionCanonicalJson({
            schemaVersion: "crewon.project-source-upload-begin.v1",
            owner: scope,
            command,
          }),
        ),
      ),
    });
    const authority = this.#authority(actor, "projectSourceUpload:begin", null);
    await assertSourceUploadCurrent(authority);
    const previous = await this.#d.store.loadBeginReceipt(
      { actor, receipt },
      authority,
    );
    if (previous !== null) {
      const result = this.#result(previous, actor, null);
      this.#assertBegin(result.state.initial, command, receipt.requestDigest);
      await assertSourceUploadCurrent(authority);
      return Object.freeze({ ...result, disposition: "replayed" });
    }
    const initial = captureSourceUploadInitial({
      ...metadata,
      storageRealmId: creativeProjectOpaqueId(this.#d.store.storageRealmId),
      uploadId: creativeProjectOpaqueId(this.#d.ids.nextUploadId()),
      requestDigest: receipt.requestDigest,
      createdAt: this.#now(),
    });
    await assertSourceUploadCurrent(authority);
    const result = this.#result(
      await this.#d.store.begin({ actor, receipt, initial }, authority),
      actor,
      null,
    );
    this.#assertBegin(result.state.initial, command, receipt.requestDigest);
    if (
      result.disposition === "committed" &&
      extensionCanonicalJson(result.state.initial) !==
        extensionCanonicalJson(initial)
    )
      fail("internal", "project_source_upload_store_result_invalid");
    return result;
  }
  async getStatus(
    actorInput: ActorContext,
    input: Readonly<{ uploadId: string }>,
  ): Promise<ProjectSourceUploadState> {
    const actor = validateCreativeProjectActor(actorInput),
      v = sourceUploadFields(input, ["uploadId"]),
      uploadId = creativeProjectOpaqueId(v.uploadId),
      a = this.#authority(actor, "projectSourceUpload:status", uploadId);
    await assertSourceUploadCurrent(a);
    const state = await this.#load(actor, uploadId, a);
    await assertSourceUploadCurrent(a);
    return state;
  }
  async writePart(
    actorInput: ActorContext,
    input: WriteProjectSourceUploadPartCommand,
  ): Promise<ProjectSourceUploadMutationResult> {
    const actor = validateCreativeProjectActor(actorInput),
      v = sourceUploadFields(input, [
        "uploadId",
        "expectedRevision",
        "index",
        "byteOffset",
        "rawDigest",
        "bytes",
      ]),
      uploadId = creativeProjectOpaqueId(v.uploadId),
      expectedRevision = creativeProjectRevision(v.expectedRevision);
    // Capture caller bytes synchronously, before policy/database awaits permit caller mutation.
    const bytes = this.#capture(
        v.bytes,
        PROJECT_SOURCE_UPLOAD_PART_BYTES,
        null,
      ),
      a = this.#authority(actor, "projectSourceUpload:write", uploadId);
    await assertSourceUploadCurrent(a);
    const state = await this.#load(actor, uploadId, a);
    const part = captureSourceUploadPart(
      {
        index: v.index,
        byteOffset: v.byteOffset,
        byteLength: this.#byteLength(bytes),
        rawDigest: v.rawDigest,
      },
      state.initial,
    );
    if (creativeProjectDigest(this.#d.bytes.sha256(bytes)) !== part.rawDigest)
      fail("validation", "project_source_upload_part_digest_mismatch");
    const result = this.#result(
      await this.#d.store.writePart(
        { actor, uploadId, expectedRevision, part, bytes, at: this.#now() },
        a,
      ),
      actor,
      uploadId,
    );
    const stored = result.state.parts.find((p) => p.index === part.index);
    if (
      !stored ||
      extensionCanonicalJson(stored) !== extensionCanonicalJson(part)
    )
      fail("internal", "project_source_upload_store_result_invalid");
    return result;
  }
  async cancel(
    actorInput: ActorContext,
    input: ProjectSourceUploadCommand,
  ): Promise<ProjectSourceUploadMutationResult> {
    const actor = validateCreativeProjectActor(actorInput),
      { uploadId, expectedRevision } = change(input),
      a = this.#authority(actor, "projectSourceUpload:cancel", uploadId);
    await assertSourceUploadCurrent(a);
    const result = this.#result(
      await this.#d.store.cancel(
        { actor, uploadId, expectedRevision, at: this.#now() },
        a,
      ),
      actor,
      uploadId,
    );
    if (result.state.phase !== "cancelled")
      fail("internal", "project_source_upload_store_result_invalid");
    return result;
  }
  async prepare(
    actorInput: ActorContext,
    input: ProjectSourceUploadCommand,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<ProjectSourceUploadPreparationResult> {
    const actor = validateCreativeProjectActor(actorInput),
      { uploadId, expectedRevision } = change(input),
      a = this.#authority(actor, "projectSourceUpload:prepare", uploadId);
    options.signal?.throwIfAborted();
    await assertSourceUploadCurrent(a);
    let state = await this.#load(actor, uploadId, a);
    if (state.phase === "ready" || state.phase === "rejected")
      return this.#preparationResult(state);
    if (state.phase === "cancelled" || state.phase === "expired")
      fail("conflict", "project_source_upload_terminal");
    const now = this.#now();
    if (state.phase === "preparing" && state.claim!.expiresAt > now)
      return this.#preparationResult(state);
    let claimRevision = expectedRevision;
    if (state.phase === "receiving") {
      options.signal?.throwIfAborted();
      const sealed = this.#result(
        await this.#d.store.sealRaw(
          { actor, uploadId, expectedRevision, at: now },
          a,
        ),
        actor,
        uploadId,
      );
      state = sealed.state;
      if (state.phase !== "raw-sealed")
        fail("internal", "project_source_upload_store_result_invalid");
      claimRevision = state.revision;
    }
    await assertSourceUploadCurrent(a);
    options.signal?.throwIfAborted();
    const claim = captureSourceUploadClaim({
      claimId: creativeProjectOpaqueId(this.#d.ids.nextClaimId()),
      normalizationParserVersion: this.#d.parser.normalizationParserVersion,
      expiresAt: new Date(
        Date.parse(now) + this.#d.preparationClaimTtlMs,
      ).toISOString(),
    });
    const outcome = sourceUploadFields(
      await this.#d.store.claimPreparation(
        { actor, uploadId, expectedRevision: claimRevision, claim, at: now },
        a,
      ),
      ["disposition", "state"],
    );
    state = this.#state(outcome.state, actor, uploadId);
    if (outcome.disposition === "existing")
      return this.#preparationResult(state);
    if (
      outcome.disposition !== "claimed" ||
      state.phase !== "preparing" ||
      !state.sealed ||
      !state.claim ||
      extensionCanonicalJson(state.claim) !== extensionCanonicalJson(claim)
    )
      fail("internal", "project_source_upload_store_result_invalid");
    options.signal?.throwIfAborted();
    await assertSourceUploadCurrent(a);
    const raw = await this.#d.store.loadRawBytes(
      {
        owner: owner(actor),
        uploadId,
        uploadDigest: state.sealed.uploadDigest,
        claimId: claim.claimId,
      },
      a,
    );
    const bytes = this.#capture(
      raw,
      PROJECT_SOURCE_UPLOAD_MAX_BYTES,
      state.initial.byteLength,
    );
    if (
      creativeProjectDigest(this.#d.bytes.sha256(bytes)) !==
      state.initial.fileDigest
    )
      fail("internal", "project_source_upload_raw_integrity_failure");
    let parsed: ProjectSourceUploadParsedFile;
    try {
      options.signal?.throwIfAborted();
      parsed = await this.#d.parser.parse({
        fileName: state.initial.fileName,
        format: state.initial.format,
        bytes,
      });
    } catch (error) {
      options.signal?.throwIfAborted();
      const code = parserFailure(error);
      if (code === null) throw error;
      const rejected = this.#result(
        await this.#d.store.rejectPreparation(
          {
            actor,
            uploadId,
            expectedRevision: state.revision,
            claimId: claim.claimId,
            failureCode: code,
            at: this.#now(),
          },
          a,
        ),
        actor,
        uploadId,
      );
      if (
        rejected.state.phase !== "rejected" ||
        rejected.state.failureCode !== code
      )
        fail("internal", "project_source_upload_store_result_invalid");
      return this.#preparationResult(rejected.state);
    }
    const recipe = this.#parsed(parsed, actor, state.initial);
    options.signal?.throwIfAborted();
    await assertSourceUploadCurrent(a);
    const ready = this.#result(
      await this.#d.store.completePreparation(
        {
          actor,
          uploadId,
          expectedRevision: state.revision,
          claimId: claim.claimId,
          parsed: recipe,
          at: this.#now(),
        },
        a,
      ),
      actor,
      uploadId,
    );
    if (
      ready.state.phase !== "ready" ||
      ready.state.prepared!.digest !== recipe.digest ||
      ready.state.prepared!.characterLength !== recipe.characterLength ||
      ready.state.prepared!.chunkCount !== recipe.chunks.length ||
      ready.state.prepared!.chapterCount !== recipe.chapters.length
    )
      fail("internal", "project_source_upload_store_result_invalid");
    return this.#preparationResult(ready.state);
  }
  /** Capture the existing independent PDP for a later host transaction; this grants nothing. */
  captureAdoptionAuthority(
    actorInput: ActorContext,
    input: Readonly<{
      uploadId: string;
      fileDigest: string;
      projectId: string | null;
    }>,
  ): ProjectSourceUploadCommitAuthority {
    const actor = validateCreativeProjectActor(actorInput),
      v = sourceUploadFields(input, ["uploadId", "fileDigest", "projectId"]),
      uploadId = creativeProjectOpaqueId(v.uploadId),
      projectId =
        v.projectId === null ? null : creativeProjectOpaqueId(v.projectId);
    creativeProjectDigest(v.fileDigest);
    return this.#authority(
      actor,
      "projectSourceUpload:adopt",
      uploadId,
      projectId,
    );
  }
  /** Host-only canonical recipe plus ledger pointer. Read authorization alone grants no adoption. */
  async getPreparedForAdoption(
    actorInput: ActorContext,
    input: Readonly<{
      uploadId: string;
      fileDigest: string;
      projectId: string | null;
    }>,
  ) {
    const actor = validateCreativeProjectActor(actorInput),
      v = sourceUploadFields(input, ["uploadId", "fileDigest", "projectId"]),
      uploadId = creativeProjectOpaqueId(v.uploadId),
      fileDigest = creativeProjectDigest(v.fileDigest),
      projectId =
        v.projectId === null ? null : creativeProjectOpaqueId(v.projectId),
      a = this.#authority(
        actor,
        "projectSourceUpload:adopt",
        uploadId,
        projectId,
      );
    await assertSourceUploadCurrent(a);
    const state = await this.#load(actor, uploadId, a);
    if (state.phase !== "ready" || state.initial.fileDigest !== fileDigest)
      fail("conflict", "project_source_upload_not_ready");
    const raw = await this.#d.store.loadPrepared(
      { owner: owner(actor), uploadId, fileDigest },
      a,
    );
    if (raw === null) fail("notFound", "project_source_upload_not_found");
    const result = captureSourceUploadPrepared(
      raw,
      { actor, uploadId, fileDigest, projectId },
      this.#d.digester,
    );
    if (
      extensionCanonicalJson(result.provenance) !==
        extensionCanonicalJson(state.prepared!.pointer) ||
      result.fileName !== state.initial.fileName ||
      result.format !== state.initial.format ||
      result.byteLength !== state.initial.byteLength ||
      result.digest !== state.prepared!.digest
    )
      fail("internal", "project_source_upload_store_result_invalid");
    await assertSourceUploadCurrent(a);
    return result;
  }
  #authority(
    actor: ActorContext,
    action: ProjectSourceUploadAction,
    uploadId: string | null,
    projectId: string | null = null,
  ): ProjectSourceUploadCommitAuthority {
    const permission = captureSourceUploadPermission({
      actor,
      action,
      resource: {
        kind: "projectSourceUpload",
        owner: owner(actor),
        uploadId,
        projectId,
      },
    });
    const active = () => {
      const result: unknown = this.#d.authorization.assertActive(permission);
      if (result !== undefined) {
        try {
          void Promise.prototype.then.call(
            result,
            () => undefined,
            () => undefined,
          );
        } catch {
          /* An arbitrary thenable establishes no synchronous authority. */
        }
        fail("internal", "project_source_upload_authority_invalid");
      }
    };
    return captureSourceUploadAuthority({
      version: "crewon.project-source-upload-commit.v1",
      permission,
      assertCurrent: async () => {
        const decision = await this.#d.authorization.authorize(permission);
        if (decision.outcome !== "allow")
          fail("authorization", "project_source_upload_permission_denied");
        active();
      },
      assertActive: active,
    });
  }
  #capture(
    raw: unknown,
    maximumBytes: number,
    expectedBytes: number | null,
  ): Uint8Array {
    let result: Uint8Array;
    try {
      result = this.#d.bytes.capture(raw, { maximumBytes, expectedBytes });
      const length = this.#byteLength(result);
      if (
        result === raw ||
        length < 1 ||
        length > maximumBytes ||
        (expectedBytes !== null && length !== expectedBytes)
      )
        throw new Error("bad_snapshot");
    } catch (error) {
      throw new ApplicationError(
        "validation",
        "project_source_upload_bytes_invalid",
        { cause: error },
      );
    }
    return result;
  }
  #byteLength(bytes: Uint8Array): number {
    try {
      return byteLengthGetter.call(bytes) as number;
    } catch {
      return fail("validation", "project_source_upload_bytes_invalid");
    }
  }
  #now() {
    return creativeProjectTimestamp(this.#d.clock.now());
  }
  async #load(
    actor: ActorContext,
    uploadId: string,
    a: ProjectSourceUploadCommitAuthority,
  ) {
    const result = await this.#d.store.load(
      { owner: owner(actor), uploadId },
      a,
    );
    if (result === null) fail("notFound", "project_source_upload_not_found");
    return this.#state(result, actor, uploadId);
  }
  #state(raw: unknown, actor: ActorContext, uploadId: string | null) {
    let state: ProjectSourceUploadState;
    try {
      state = captureSourceUploadState(raw);
    } catch (error) {
      throw new ApplicationError(
        "internal",
        "project_source_upload_store_result_invalid",
        { cause: error },
      );
    }
    if (
      extensionCanonicalJson(state.initial.owner) !==
        extensionCanonicalJson(owner(actor)) ||
      (uploadId !== null && state.initial.uploadId !== uploadId)
    )
      fail("notFound", "project_source_upload_not_found");
    if (state.initial.storageRealmId !== this.#d.store.storageRealmId)
      fail("internal", "project_source_upload_store_result_invalid");
    return state;
  }
  #result(
    raw: unknown,
    actor: ActorContext,
    uploadId: string | null,
  ): ProjectSourceUploadMutationResult {
    const v = sourceUploadFields(raw, ["disposition", "state"]);
    if (v.disposition !== "committed" && v.disposition !== "replayed")
      fail("internal", "project_source_upload_store_result_invalid");
    return Object.freeze({
      disposition: v.disposition,
      state: this.#state(v.state, actor, uploadId),
    });
  }
  #preparationResult(
    state: ProjectSourceUploadState,
  ): ProjectSourceUploadPreparationResult {
    return Object.freeze({
      disposition:
        state.phase === "ready"
          ? "ready"
          : state.phase === "rejected"
            ? "rejected"
            : "pending",
      state,
    });
  }
  #parsed(
    input: unknown,
    actor: ActorContext,
    initial: ProjectSourceUploadInitial,
  ): ProjectSourceUploadParsedFile {
    const fields = sourceUploadFields(input, parsedFields);
    const captured = capturePreparedProjectSource(
      { ...fields, uploadId: initial.uploadId, owner: initial.owner },
      {
        actor,
        uploadId: initial.uploadId,
        fileDigest: initial.fileDigest,
        projectId: null,
      },
      this.#d.digester,
    );
    if (
      captured.byteLength !== initial.byteLength ||
      captured.fileName !== initial.fileName ||
      captured.format !== initial.format
    )
      fail("internal", "project_source_upload_parser_result_invalid");
    const { uploadId: unusedId, owner: unusedOwner, ...parsed } = captured;
    void unusedId;
    void unusedOwner;
    return Object.freeze(parsed);
  }
  #assertBegin(
    initial: ProjectSourceUploadInitial,
    command: BeginProjectSourceUploadCommand,
    requestDigest: string,
  ) {
    if (
      initial.requestDigest !== requestDigest ||
      initial.fileName !== command.fileName ||
      initial.format !== command.format ||
      initial.byteLength !== command.byteLength ||
      initial.fileDigest !== command.fileDigest
    )
      fail("internal", "project_source_upload_store_result_invalid");
  }
}
function owner(actor: ActorContext) {
  return Object.freeze({
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    principalId: actor.principalId,
  });
}
function change(input: unknown) {
  const v = sourceUploadFields(input, ["uploadId", "expectedRevision"]);
  return {
    uploadId: creativeProjectOpaqueId(v.uploadId),
    expectedRevision: creativeProjectRevision(v.expectedRevision),
  };
}
function parserFailure(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const d = Object.getOwnPropertyDescriptor(error, "code");
  return d &&
    Object.hasOwn(d, "value") &&
    typeof d.value === "string" &&
    contentFailures.has(d.value)
    ? d.value
    : null;
}
function fail(
  category: ConstructorParameters<typeof ApplicationError>[0],
  code: string,
): never {
  throw new ApplicationError(category, code);
}
function bound<T extends object, K extends keyof T>(
  object: T,
  key: K,
): Extract<T[K], (...args: never[]) => unknown> {
  for (let p: object | null = object; p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, key);
    if (!d) continue;
    if (!Object.hasOwn(d, "value") || typeof d.value !== "function") break;
    return d.value.bind(object);
  }
  return fail("internal", "project_source_upload_dependency_invalid");
}
