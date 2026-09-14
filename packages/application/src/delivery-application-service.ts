import {
  DELIVERY_LIMITS,
  DeliveryError,
  XLSX_MEDIA_TYPE,
  deliveryId,
  deliveryFileName,
  deliveryInteger,
  deliverySheetName,
  parseDeliveryAssembleRequest,
  parseDeliveryPatchRequest,
  parseDeliveryTargetRef,
  type DeliveryAssembleRequest,
  type DeliveryInputRecord,
  type DeliveryPatchRequest,
  type DeliveryTargetRef,
  type DeliveryVersionRecord,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type {
  DeliveryScope,
  DeliveryStorePort,
  SpreadsheetEnginePort,
} from "./delivery-ports.ts";
import { canonicalJson } from "./canonical-json.ts";

export interface DeliveryAccessPort {
  check(
    actor: ActorContext,
    threadId: string,
    access: "read" | "write",
  ): Promise<void>;
  checkRun(actor: ActorContext, threadId: string, runId: string): Promise<void>;
}
export type DeliveryOperation = Readonly<{
  key: string;
  sourceRunId: string | null;
}>;
const bytes = (value: string) => new TextEncoder().encode(value);
async function digest(content: Uint8Array) {
  return `sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(content)))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Owns input identity, explicit processing and immutable CAS commits, never model prose. */
export class DeliveryApplicationService {
  readonly #store: DeliveryStorePort;
  readonly #engine: SpreadsheetEnginePort;
  readonly #access: DeliveryAccessPort;
  readonly #now: () => string;
  readonly #id: () => string;
  constructor(config: {
    store: DeliveryStorePort;
    engine: SpreadsheetEnginePort;
    access: DeliveryAccessPort;
    now?: () => string;
    id?: () => string;
  }) {
    this.#store = config.store;
    this.#engine = config.engine;
    this.#access = config.access;
    this.#now = config.now ?? (() => new Date().toISOString());
    this.#id = config.id ?? (() => crypto.randomUUID());
  }
  async validateTarget(
    actor: ActorContext,
    target: DeliveryTargetRef,
    access: "read" | "write" = "write",
  ): Promise<void> {
    const parsed = parseDeliveryTargetRef(target);
    if (parsed.tenantId !== actor.tenantId || parsed.spaceId !== actor.spaceId)
      throw new ApplicationError("authorization", "delivery_target_forbidden");
    await this.#scope(actor, parsed.threadId, access);
  }
  async catalog(actor: ActorContext, threadId: string) {
    return this.#store.catalog(await this.#scope(actor, threadId, "read"));
  }
  async history(actor: ActorContext, threadId: string, id: string) {
    return this.#store.history(
      await this.#scope(actor, threadId, "read"),
      deliveryId(id),
    );
  }
  async upload(
    actor: ActorContext,
    threadId: string,
    input: {
      name: string;
      role: "data" | "template";
      mediaType: DeliveryInputRecord["mediaType"];
      content: Uint8Array;
    },
    key: string,
  ): Promise<DeliveryInputRecord> {
    return this.#persistInput(actor, threadId, input, {
      key,
      sourceRunId: null,
    });
  }
  /** Trusted Worker adapter supplies the Run from its invocation, never an HTTP/model field. */
  async importFromRun(
    actor: ActorContext,
    threadId: string,
    input: {
      name: string;
      role: "data";
      mediaType: DeliveryInputRecord["mediaType"];
      content: Uint8Array;
    },
    operation: { key: string; sourceRunId: string },
  ): Promise<DeliveryInputRecord> {
    return this.#persistInput(actor, threadId, input, operation);
  }
  async #persistInput(
    actor: ActorContext,
    threadId: string,
    input: {
      name: string;
      role: "data" | "template";
      mediaType: DeliveryInputRecord["mediaType"];
      content: Uint8Array;
    },
    operation: DeliveryOperation,
  ): Promise<DeliveryInputRecord> {
    const key = operation.key;
    const scope = await this.#scope(actor, threadId, "write");
    this.#key(key);
    if (
      (input.mediaType !== "text/csv" && input.mediaType !== XLSX_MEDIA_TYPE) ||
      (input.role !== "data" && input.role !== "template") ||
      (input.role === "template" && input.mediaType !== XLSX_MEDIA_TYPE)
    )
      throw new ApplicationError("validation", "delivery_input_type_invalid");
    const name = deliveryFileName(
      input.name,
      input.mediaType === "text/csv" ? "csv" : "xlsx",
    );
    this.#size(input.content);
    const contentDigest = await digest(input.content);
    const fingerprint = await this.#operation(
      actor,
      threadId,
      {
        kind: "input",
        name,
        role: input.role,
        mediaType: input.mediaType,
        contentDigest,
      },
      operation,
    );
    const prior = await this.#store.findOperation(scope, key, fingerprint);
    if (prior) {
      if (!("inputId" in prior))
        throw new ApplicationError("conflict", "delivery_idempotency_conflict");
      return prior;
    }
    const inspection = await this.#engine.inspect({
      inputId: "upload",
      mediaType: input.mediaType,
      content: input.content,
    });
    const record: DeliveryInputRecord = {
      inputId: this.#id(),
      target: scope.target,
      ownerActorId: actor.actorId,
      name,
      role: input.role,
      mediaType: input.mediaType,
      byteLength: input.content.byteLength,
      contentDigest,
      inspection,
      createdAt: this.#now(),
      sourceRunId: operation.sourceRunId,
    };
    await this.#operation(
      actor,
      threadId,
      {
        kind: "input",
        name,
        role: input.role,
        mediaType: input.mediaType,
        contentDigest,
      },
      operation,
    );
    return this.#store.putInput({
      scope,
      record,
      content: input.content,
      key,
      fingerprint,
    });
  }
  async readInput(actor: ActorContext, threadId: string, id: string) {
    const stored = await this.#store.getInput(
      await this.#scope(actor, threadId, "read"),
      deliveryId(id),
    );
    if (!stored)
      throw new ApplicationError("notFound", "delivery_input_not_found");
    return stored;
  }
  async readVersion(actor: ActorContext, threadId: string, id: string) {
    const stored = await this.#store.getVersion(
      await this.#scope(actor, threadId, "read"),
      deliveryId(id),
    );
    if (!stored)
      throw new ApplicationError("notFound", "delivery_version_not_found");
    return stored;
  }
  async page(
    actor: ActorContext,
    threadId: string,
    query: {
      kind: "input" | "version";
      id: string;
      sheet: string;
      startRow: number;
      limit: number;
    },
  ) {
    if (query.kind !== "input" && query.kind !== "version")
      throw new ApplicationError("validation", "delivery_page_invalid");
    const stored =
      query.kind === "input"
        ? await this.readInput(actor, threadId, query.id)
        : await this.readVersion(actor, threadId, query.id);
    return this.#engine.readPage(
      {
        inputId: query.id,
        content: stored.content,
        mediaType: stored.record.mediaType,
      },
      {
        sheet: deliverySheetName(query.sheet),
        startRow: deliveryInteger(query.startRow, DELIVERY_LIMITS.rows),
        limit: deliveryInteger(query.limit, DELIVERY_LIMITS.pageRows),
      },
    );
  }
  async assemble(
    actor: ActorContext,
    threadId: string,
    request: DeliveryAssembleRequest,
    operation: DeliveryOperation,
  ): Promise<DeliveryVersionRecord> {
    const parsed = parseDeliveryAssembleRequest(request);
    const scope = await this.#scope(actor, threadId, "write");
    const fingerprint = await this.#operation(
      actor,
      threadId,
      { kind: "assemble", request: parsed },
      operation,
    );
    const prior = await this.#store.findOperation(
      scope,
      operation.key,
      fingerprint,
    );
    if (prior) return this.#version(prior);
    const template = await this.readInput(
      actor,
      threadId,
      parsed.templateInputId,
    );
    if (template.record.role !== "template")
      throw new ApplicationError("validation", "delivery_template_required");
    const sources = [];
    for (const inputId of new Set(
      parsed.sources.map((source) => source.inputId),
    )) {
      const source = await this.readInput(actor, threadId, inputId);
      if (source.record.role !== "data")
        throw new ApplicationError("validation", "delivery_source_invalid");
      sources.push({
        inputId,
        content: source.content,
        mediaType: source.record.mediaType,
      });
    }
    const output = await this.#engine.assemble({
      template: {
        inputId: template.record.inputId,
        content: template.content,
        mediaType: template.record.mediaType,
      },
      sources,
      request: parsed,
    });
    this.#size(output.content);
    const record: DeliveryVersionRecord = {
      schemaVersion: "crewon.delivery-result.v1",
      target: scope.target,
      deliveryId: this.#id(),
      versionId: this.#id(),
      contentDigest: await digest(output.content),
      mediaType: XLSX_MEDIA_TYPE,
      sourceRunId: operation.sourceRunId,
      availability: "ready",
      ownerActorId: actor.actorId,
      name: parsed.name,
      byteLength: output.content.byteLength,
      createdAt: this.#now(),
      parentVersionId: null,
      inputIds: [template.record.inputId, ...sources.map((s) => s.inputId)],
      inspection: output.inspection,
      validation: output.validation,
      retention: "saved",
    };
    await this.#operation(
      actor,
      threadId,
      { kind: "assemble", request: parsed },
      operation,
    );
    return this.#store.commitVersion({
      scope,
      record,
      content: output.content,
      expected: null,
      key: operation.key,
      fingerprint,
    });
  }
  async patch(
    actor: ActorContext,
    threadId: string,
    request: DeliveryPatchRequest,
    operation: DeliveryOperation,
  ): Promise<DeliveryVersionRecord> {
    const parsed = parseDeliveryPatchRequest(request);
    const scope = await this.#scope(actor, threadId, "write");
    const fingerprint = await this.#operation(
      actor,
      threadId,
      { kind: "patch", request: parsed },
      operation,
    );
    const prior = await this.#store.findOperation(
      scope,
      operation.key,
      fingerprint,
    );
    if (prior) return this.#version(prior);
    const base = await this.readVersion(
      actor,
      threadId,
      parsed.expectedVersionId,
    );
    if (
      base.record.deliveryId !== parsed.deliveryId ||
      base.record.contentDigest !== parsed.expectedContentDigest
    )
      throw new ApplicationError("conflict", "delivery_version_conflict");
    const head = (await this.#store.catalog(scope)).deliveries.find(
      (d) => d.deliveryId === parsed.deliveryId,
    );
    if (head?.versionId !== parsed.expectedVersionId)
      throw new ApplicationError("conflict", "delivery_version_conflict");
    const output = await this.#engine.patch({
      file: {
        inputId: base.record.versionId,
        mediaType: XLSX_MEDIA_TYPE,
        content: base.content,
      },
      patches: parsed.patches,
    });
    this.#size(output.content);
    const record: DeliveryVersionRecord = {
      ...base.record,
      versionId: this.#id(),
      contentDigest: await digest(output.content),
      byteLength: output.content.byteLength,
      parentVersionId: base.record.versionId,
      sourceRunId: operation.sourceRunId,
      createdAt: this.#now(),
      inspection: output.inspection,
      validation: {
        ...base.record.validation,
        formulaCount: output.formulaCount,
        warnings: [
          ...new Set([
            ...base.record.validation.warnings,
            "Cells were edited; source row counts and totals describe the original assembly.",
          ]),
        ].slice(0, 32),
      },
    };
    await this.#operation(
      actor,
      threadId,
      { kind: "patch", request: parsed },
      operation,
    );
    return this.#store.commitVersion({
      scope,
      record,
      content: output.content,
      expected: {
        versionId: parsed.expectedVersionId,
        contentDigest: parsed.expectedContentDigest,
      },
      key: operation.key,
      fingerprint,
    });
  }
  async #scope(
    actor: ActorContext,
    threadId: string,
    access: "read" | "write",
  ): Promise<DeliveryScope> {
    for (const id of [
      actor.actorId,
      actor.principalId,
      actor.tenantId,
      actor.spaceId,
      threadId,
    ])
      deliveryId(id);
    await this.#access.check(actor, threadId, access);
    return {
      target: {
        schemaVersion: "crewon.delivery-target.v1",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        threadId,
        targetId: "thread-deliveries",
      },
      ownerActorId: actor.actorId,
    };
  }
  #key(key: string) {
    if (
      typeof key !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,1023}$/u.test(key)
    )
      throw new ApplicationError(
        "validation",
        "delivery_idempotency_key_invalid",
      );
  }
  async #operation(
    actor: ActorContext,
    threadId: string,
    request: unknown,
    operation: DeliveryOperation,
  ) {
    this.#key(operation.key);
    await this.#access.check(actor, threadId, "write");
    if (operation.sourceRunId !== null)
      await this.#access.checkRun(
        actor,
        threadId,
        deliveryId(operation.sourceRunId),
      );
    return digest(
      bytes(canonicalJson({ request, sourceRunId: operation.sourceRunId })),
    );
  }
  #version(
    record: DeliveryInputRecord | DeliveryVersionRecord,
  ): DeliveryVersionRecord {
    if ("inputId" in record)
      throw new ApplicationError("conflict", "delivery_idempotency_conflict");
    return record;
  }
  #size(content: Uint8Array) {
    if (
      !(content instanceof Uint8Array) ||
      content.byteLength < 1 ||
      content.byteLength > DELIVERY_LIMITS.fileBytes
    )
      throw new DeliveryError("delivery_file_size_invalid");
  }
}
