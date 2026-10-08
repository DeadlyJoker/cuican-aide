import {
  CREWON_PROJECT_SOURCE_UPLOAD_API_VERSION,
  CREWON_PROJECT_SOURCE_UPLOAD_SERVICE,
  MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES,
  isProjectSourceUploadAction,
  projectSourceUploadsCodec,
  parseProjectSourceUploadPartResponse,
  type ProjectSourceUploadPartLocator,
  type ProjectSourceUploadRequest,
  type PublicProjectSourceUpload,
} from "@crewon/contracts/project-source-uploads";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import { ApplicationError } from "./application-error.ts";
import {
  ProjectSourceUploadApplicationService,
  isProjectSourceUploadApplicationService,
} from "./project-source-upload-application-service.ts";
import { projectSourceUploadActionContext } from "./plugin-project-source-upload-action-context.ts";
import { capturePluginProjectSourceUploadInvocation } from "./plugin-project-source-upload-invocation.ts";
import {
  captureSourceUploadAuthorization,
  captureSourceUploadPartAuthorization,
  captureSourceUploadPublications,
} from "./plugin-project-source-upload-action-owner-config.ts";
import { uiRecord } from "./plugin-ui-application-support.ts";
import type {
  ProjectSourceUploadExecutionAuthority,
  ProjectSourceUploadState,
} from "./project-source-upload-port.ts";
import type {
  PluginUiActionContext,
  PluginUiActionPort,
  PluginUiCommittedMetadataOutcome,
  PluginUiCommittedMetadataPort,
  PluginUiJsonValue,
} from "./plugin-ui-ports.ts";

export type PluginProjectSourceUploadActionPublication = Readonly<{
  pluginId: string;
  packageDigest: string;
  contributionId: string;
}>;
export interface PluginProjectSourceUploadActionAuthorizationPort {
  /** External host policy only. No reentrant borrow of the committing Store's connection/pool. */
  authorize(
    context: PluginUiActionContext,
    request: ProjectSourceUploadRequest,
  ): Promise<void>;
  /** Independent host raw-write policy; JSON prepare/status authority cannot authorize this action. */
  authorizePart?(
    context: PluginUiActionContext,
    locator: ProjectSourceUploadPartLocator,
  ): Promise<void>;
}
export type PluginProjectSourceUploadActionOwnerDependencies = Readonly<{
  uploads: ProjectSourceUploadApplicationService;
  publications: readonly PluginProjectSourceUploadActionPublication[];
  authorization: PluginProjectSourceUploadActionAuthorizationPort;
}>;
type Outcome = Readonly<{
  context: PluginUiActionContext;
  fingerprint: string;
  output: PluginUiJsonValue;
}>;
const actualOwners = new WeakSet<object>();
const outcomePrototype = Object.freeze(Object.create(null) as object);
export function isPluginProjectSourceUploadActionOwner(
  input: unknown,
): input is PluginProjectSourceUploadActionOwner {
  return input !== null && typeof input === "object" && actualOwners.has(input);
}

/** Four JSON actions on the genuine mounted UI lifetime. Raw writePart needs its separate mount lifecycle. */
export class PluginProjectSourceUploadActionOwner {
  readonly actions: PluginUiActionPort;
  readonly committedMetadata: PluginUiCommittedMetadataPort;
  readonly #uploads: ReturnType<typeof captureUploads>;
  readonly #publications: readonly PluginProjectSourceUploadActionPublication[];
  readonly #authorize: PluginProjectSourceUploadActionAuthorizationPort["authorize"];
  readonly #authorizePart: PluginProjectSourceUploadActionAuthorizationPort["authorizePart"];
  readonly #outcomes = new WeakMap<object, Outcome>();
  #closed = false;
  #pending = 0;
  #closing: Promise<void> | undefined;
  #finishClose: (() => void) | undefined;
  constructor(input: PluginProjectSourceUploadActionOwnerDependencies) {
    try {
      const value = uiRecord(input, [
        "uploads",
        "publications",
        "authorization",
      ]);
      this.#uploads = captureUploads(value.uploads);
      this.#publications = captureSourceUploadPublications(value.publications);
      this.#authorize = captureSourceUploadAuthorization(value.authorization);
      this.#authorizePart = captureSourceUploadPartAuthorization(
        value.authorization,
      );
    } catch (cause) {
      throw new ApplicationError(
        "internal",
        "plugin_project_source_upload_config_invalid",
        { cause },
      );
    }
    this.actions = Object.freeze({
      invoke: (context: PluginUiActionContext) => this.#invoke(context),
    });
    this.committedMetadata = Object.freeze({
      isOutcome: (value: unknown): value is PluginUiCommittedMetadataOutcome =>
        value !== null &&
        typeof value === "object" &&
        this.#outcomes.has(value),
      verify: (
        context: PluginUiActionContext,
        outcome: PluginUiCommittedMetadataOutcome,
      ) => this.#verify(context, outcome),
    });
    actualOwners.add(this);
    Object.freeze(this);
  }
  supportsAction(action: string): boolean {
    return isProjectSourceUploadAction(action);
  }
  assertAvailable(): void {
    if (this.#closed)
      throw new ApplicationError(
        "authorization",
        "plugin_project_source_upload_actions_unavailable",
      );
  }
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    return (this.#closing =
      this.#pending === 0
        ? Promise.resolve()
        : new Promise((resolve) => {
            this.#finishClose = resolve;
          }));
  }
  /** Synchronous trusted native snapshot; no plugin can select a different byte adapter. */
  capturePartBytes(bytes: Uint8Array): Uint8Array {
    this.assertAvailable();
    return this.#uploads.capturePartBytes(bytes);
  }
  /** Only the dedicated actual raw mount lifecycle can supply the independently registered write context. */
  async writePart(
    invocation: PluginUiActionContext,
    bytes: Uint8Array,
  ): Promise<PluginUiCommittedMetadataOutcome> {
    this.assertAvailable();
    if (this.#authorizePart === undefined)
      throw new ApplicationError(
        "authorization",
        "plugin_project_source_upload_raw_authorization_required",
      );
    if (this.#pending >= 64)
      throw new ApplicationError(
        "conflict",
        "plugin_project_source_upload_inflight_limit",
      );
    const original = capturePluginProjectSourceUploadInvocation(invocation),
      snapshot = original.snapshot;
    if (
      snapshot.request.action !==
        "crewon.project-source-uploads.v1.writePart" ||
      original.authority.transaction === undefined
    )
      throw new ApplicationError(
        "authorization",
        "plugin_project_source_upload_raw_invocation_required",
      );
    const locator = snapshot.request.input;
    const ownedBytes = this.#uploads.capturePartBytes(bytes);
    this.#assertPublication(snapshot.context);
    let active = true;
    const check = async (current: () => Promise<void>) => {
      try {
        authority.assertActive();
        await current();
        authority.assertActive();
        if ((await this.#authorizePart!(invocation, locator)) !== undefined)
          throw new ApplicationError(
            "authorization",
            "plugin_project_source_upload_authorization_invalid",
          );
        authority.assertActive();
        await current();
        authority.assertActive();
      } catch (cause) {
        active = false;
        if (cause instanceof ApplicationError) throw cause;
        throw new ApplicationError(
          "authorization",
          "plugin_project_source_upload_action_denied",
          { cause },
        );
      }
    };
    const authority: ProjectSourceUploadExecutionAuthority = Object.freeze({
      assertActive: () => {
        this.assertAvailable();
        if (!active)
          throw new ApplicationError(
            "authorization",
            "plugin_project_source_upload_invocation_unavailable",
          );
        original.authority.assertActive();
      },
      assertCurrent: () => check(original.authority.assertCurrent),
      transaction: Object.freeze({
        ...original.authority.transaction,
        assertCurrent: () =>
          check(original.authority.transaction!.assertCurrent),
      }),
    });
    this.#pending++;
    try {
      await authority.assertCurrent();
      const result = await this.#uploads.writeLocatedPart(
        snapshot.context.actor,
        locator,
        ownedBytes,
        { authority },
      );
      const output = parsePluginUiJsonValue(
        parseProjectSourceUploadPartResponse(
          {
            disposition: result.disposition,
            upload: publicUpload(result.state),
          },
          locator,
          ownedBytes.byteLength,
        ),
        { maxBytes: MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES },
      );
      // A confirmed write is durable even if the signal, lease or policy withdraws after COMMIT.
      if (
        projectSourceUploadActionContext(invocation).fingerprint !==
        snapshot.fingerprint
      )
        throw new ApplicationError(
          "internal",
          "plugin_project_source_upload_context_changed",
        );
      const outcome = Object.freeze(
        Object.create(outcomePrototype),
      ) as PluginUiCommittedMetadataOutcome;
      this.#outcomes.set(
        outcome,
        Object.freeze({
          context: invocation,
          fingerprint: snapshot.fingerprint,
          output,
        }),
      );
      return outcome;
    } finally {
      this.#pending--;
      if (this.#pending === 0) this.#finishClose?.();
    }
  }
  async #invoke(invocation: PluginUiActionContext) {
    this.assertAvailable();
    if (this.#pending >= 64)
      throw new ApplicationError(
        "conflict",
        "plugin_project_source_upload_inflight_limit",
      );
    const original = capturePluginProjectSourceUploadInvocation(invocation),
      snapshot = original.snapshot;
    if (
      snapshot.request.action === "crewon.project-source-uploads.v1.writePart"
    )
      throw new ApplicationError(
        "authorization",
        "plugin_project_source_upload_raw_invocation_required",
      );
    const request = snapshot.request;
    this.#assertPublication(snapshot.context);
    if (original.authority.transaction === undefined)
      throw new ApplicationError(
        "authorization",
        "plugin_project_source_upload_invocation_unavailable",
      );
    let active = true;
    const check = async (current: () => Promise<void>) => {
      try {
        authority.assertActive();
        await current();
        authority.assertActive();
        if ((await this.#authorize(invocation, request)) !== undefined)
          throw new ApplicationError(
            "authorization",
            "plugin_project_source_upload_authorization_invalid",
          );
        authority.assertActive();
        await current();
        authority.assertActive();
      } catch (error) {
        active = false;
        if (error instanceof ApplicationError) throw error;
        throw new ApplicationError(
          "authorization",
          "plugin_project_source_upload_action_denied",
          { cause: error },
        );
      }
    };
    const authority: ProjectSourceUploadExecutionAuthority = Object.freeze({
      assertActive: () => {
        this.assertAvailable();
        if (!active)
          throw new ApplicationError(
            "authorization",
            "plugin_project_source_upload_invocation_unavailable",
          );
        original.authority.assertActive();
      },
      assertCurrent: () => check(original.authority.assertCurrent),
      transaction: Object.freeze({
        ...original.authority.transaction,
        assertCurrent: () =>
          check(original.authority.transaction!.assertCurrent),
      }),
    });
    this.#pending++;
    try {
      await authority.assertCurrent();
      const result = await this.#dispatch(snapshot.context, request, authority);
      if (result.kind === "read") await authority.assertCurrent();
      const output = parsePluginUiJsonValue(
        projectSourceUploadsCodec.parseResponse(result.output, request),
        { maxBytes: MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES },
      );
      if (
        projectSourceUploadActionContext(invocation).fingerprint !==
        snapshot.fingerprint
      )
        throw new ApplicationError(
          "internal",
          "plugin_project_source_upload_context_changed",
        );
      if (result.kind === "read") return output;
      const outcome = Object.freeze(
        Object.create(outcomePrototype),
      ) as PluginUiCommittedMetadataOutcome;
      this.#outcomes.set(
        outcome,
        Object.freeze({
          context: invocation,
          fingerprint: snapshot.fingerprint,
          output,
        }),
      );
      return outcome;
    } finally {
      this.#pending--;
      if (this.#pending === 0) this.#finishClose?.();
    }
  }
  #verify(
    context: PluginUiActionContext,
    outcome: PluginUiCommittedMetadataOutcome,
  ): PluginUiJsonValue {
    const entry =
      outcome !== null && typeof outcome === "object"
        ? this.#outcomes.get(outcome)
        : undefined;
    this.#outcomes.delete(outcome);
    if (
      entry === undefined ||
      entry.context !== context ||
      projectSourceUploadActionContext(context).fingerprint !==
        entry.fingerprint
    )
      throw new ApplicationError(
        "internal",
        "plugin_ui_committed_metadata_invalid",
      );
    return entry.output;
  }
  #assertPublication(context: PluginUiActionContext): void {
    const descriptor = context.lease.descriptor,
      contribution = descriptor.contributions.find(
        (value) => value.id === context.lease.contributionId,
      );
    const dualEntry =
      descriptor.entrypoints.node !== null &&
      descriptor.businessManifestPath !== null;
    if (
      !this.#publications.some(
        (value) =>
          value.pluginId === descriptor.pluginId &&
          value.packageDigest === context.package.packageDigest &&
          value.contributionId === context.lease.contributionId,
      ) ||
      contribution?.kind !== "module" ||
      contribution.slot !== "main.content" ||
      !descriptor.requires.some(
        (value) =>
          value.service === CREWON_PROJECT_SOURCE_UPLOAD_SERVICE &&
          value.apiVersion === CREWON_PROJECT_SOURCE_UPLOAD_API_VERSION &&
          (!value.optional || dualEntry),
      )
    )
      throw new ApplicationError(
        "authorization",
        "plugin_project_source_upload_publication_unavailable",
      );
  }
  async #dispatch(
    context: PluginUiActionContext,
    request: ProjectSourceUploadRequest,
    authority: ProjectSourceUploadExecutionAuthority,
  ): Promise<Readonly<{ kind: "read" | "metadata"; output: unknown }>> {
    const options = Object.freeze({ authority }),
      actor = context.actor;
    switch (request.action) {
      case "crewon.project-source-uploads.v1.begin": {
        const result = await this.#uploads.begin(actor, request.input, options);
        return {
          kind: "metadata",
          output: {
            disposition: result.disposition,
            upload: publicUpload(result.state),
          },
        };
      }
      case "crewon.project-source-uploads.v1.status":
        return {
          kind: "read",
          output: {
            upload: publicUpload(
              await this.#uploads.getStatus(actor, request.input, options),
            ),
          },
        };
      case "crewon.project-source-uploads.v1.prepare": {
        const result = await this.#uploads.prepare(
          actor,
          request.input,
          options,
        );
        return {
          kind: result.disposition === "pending" ? "read" : "metadata",
          output: {
            disposition: result.disposition,
            upload: publicUpload(result.state),
          },
        };
      }
      case "crewon.project-source-uploads.v1.cancel": {
        const result = await this.#uploads.cancel(
          actor,
          request.input,
          options,
        );
        return {
          kind: "metadata",
          output: {
            disposition: result.disposition,
            upload: publicUpload(result.state),
          },
        };
      }
    }
  }
}
function captureUploads(input: unknown) {
  if (!isProjectSourceUploadApplicationService(input))
    throw new Error("plugin_project_source_upload_service_invalid");
  const proto = ProjectSourceUploadApplicationService.prototype;
  return Object.freeze({
    begin: proto.begin.bind(input),
    getStatus: proto.getStatus.bind(input),
    prepare: proto.prepare.bind(input),
    cancel: proto.cancel.bind(input),
    capturePartBytes: proto.capturePartBytes.bind(input),
    writeLocatedPart: proto.writeLocatedPart.bind(input),
  });
}
function publicUpload(
  state: ProjectSourceUploadState,
): PublicProjectSourceUpload {
  const initial = state.initial,
    p = state.prepared;
  return {
    uploadId: initial.uploadId,
    revision: state.revision,
    phase: state.phase,
    fileName: initial.fileName,
    format: initial.format,
    byteLength: initial.byteLength,
    fileDigest: initial.fileDigest,
    partBytes: initial.partBytes,
    partCount: initial.partCount,
    receivedParts: state.parts.map((part) => ({
      index: part.index,
      byteLength: part.byteLength,
      rawDigest: part.rawDigest,
    })),
    prepared:
      p === null
        ? null
        : {
            digest: p.digest,
            characterLength: p.characterLength,
            normalizedByteLength: p.normalizedByteLength,
            chunkCount: p.chunkCount,
            chapterCount: p.chapterCount,
          },
    failureCode: state.failureCode,
    updatedAt: state.updatedAt,
  };
}
