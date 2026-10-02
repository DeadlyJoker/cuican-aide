import {
  creativeProjectBriefText,
  creativeProjectDigest,
  creativeProjectOpaqueId,
  creativeProjectPrompt,
  creativeProjectRevision,
  creativeProjectTimestamp,
  creativeProjectTitle,
  parseConceptAssetRevision,
  parseProjectBriefRevision,
  validateConceptAsset,
  validateCreativeProject,
  validateCreativeProjectActor,
  type ConceptAsset,
  type ConceptAssetRevision,
  type CreativeProject,
  type ProjectBriefRevision,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type {
  CreativeProjectMutationCommand,
  ListCreativeProjectsQuery,
} from "./creative-project-commands.ts";
import type {
  CreativeProjectMutationKind,
  CreativeProjectMutationReceipt,
  CreativeProjectMutationResult,
  CreativeProjectOwnerScope,
} from "./creative-project-store-port.ts";

const maximumCommandBytes = 24 * 1024;
const encoder = new TextEncoder();

/** Detached, descriptor-only input traversal: valid multiline briefs fit the JSON budget. */
export function creativeRecord(input: unknown, fields: readonly string[]) {
  let nodes = 0;
  const ancestors = new WeakSet<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 512 || depth > 8) invalidCommand();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (encoder.encode(value).length > maximumCommandBytes) invalidCommand();
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || value === null || ancestors.has(value))
      invalidCommand();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalidCommand();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > 32 ||
      keys.some((key) => typeof key !== "string") ||
      Object.values(descriptors).some(
        (entry) => !entry.enumerable || !Object.hasOwn(entry, "value"),
      )
    )
      invalidCommand();
    ancestors.add(value);
    const result = Object.fromEntries(
      (keys as string[])
        .sort()
        .map((key) => [key, visit(descriptors[key]!.value, depth + 1)]),
    );
    ancestors.delete(value);
    return Object.freeze(result);
  };
  const copied = visit(input, 0);
  if (
    copied === null ||
    typeof copied !== "object" ||
    encoder.encode(JSON.stringify(copied)).length > maximumCommandBytes ||
    Object.keys(copied).sort().join("\0") !== [...fields].sort().join("\0")
  )
    invalidCommand();
  return copied as Record<string, unknown>;
}

export function creativeInput<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError(
      "validation",
      errorCode(error) || "creative_project_command_invalid",
      { cause: error },
    );
  }
}

export function creativeActor(input: ActorContext): ActorContext {
  return creativeInput(() =>
    validateCreativeProjectActor(
      creativeRecord(input, ["tenantId", "spaceId", "principalId", "actorId"]),
    ),
  );
}

export function creativeOwner(actor: ActorContext): CreativeProjectOwnerScope {
  return Object.freeze({
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    principalId: actor.principalId,
  });
}

export function creativeLimit(input: unknown): number {
  if (
    typeof input !== "number" ||
    !Number.isInteger(input) ||
    input < 1 ||
    input > 50
  )
    throw new ApplicationError("validation", "creative_project_limit_invalid");
  return input;
}

export function creativeState(
  input: unknown,
  options: { allowed: "project-state" | "list-filter" } = {
    allowed: "project-state",
  },
): "active" | "archived" | "all" {
  if (
    input !== "active" &&
    input !== "archived" &&
    !(options.allowed === "list-filter" && input === "all")
  )
    throw new ApplicationError("validation", "creative_project_state_invalid");
  return input as "active" | "archived" | "all";
}

export function creativeListQuery(
  input: ListCreativeProjectsQuery,
): ListCreativeProjectsQuery {
  return creativeInput(() => {
    const value = creativeRecord(input, ["state", "after", "limit"]);
    const cursor =
      value.after === null
        ? null
        : creativeRecord(value.after, ["updatedAt", "projectId"]);
    return Object.freeze({
      state: creativeState(value.state, { allowed: "list-filter" }),
      after:
        cursor === null
          ? null
          : Object.freeze({
              updatedAt: creativeProjectTimestamp(cursor.updatedAt),
              projectId: creativeProjectOpaqueId(cursor.projectId),
            }),
      limit: creativeLimit(value.limit),
    });
  });
}

export function creativeMutationCommand(
  kind: CreativeProjectMutationKind,
  input: unknown,
): CreativeProjectMutationCommand {
  return creativeInput(() => {
    const fields = {
      "create-project": ["title", "briefText", "idempotencyKey"],
      "rename-project": [
        "projectId",
        "title",
        "expectedProjectRevision",
        "idempotencyKey",
      ],
      "set-project-state": [
        "projectId",
        "state",
        "expectedProjectRevision",
        "idempotencyKey",
      ],
      "append-brief": [
        "projectId",
        "text",
        "expectedProjectRevision",
        "idempotencyKey",
      ],
      "create-concept": [
        "projectId",
        "briefRevision",
        "name",
        "prompt",
        "expectedProjectRevision",
        "idempotencyKey",
      ],
      "append-concept": [
        "projectId",
        "assetId",
        "briefRevision",
        "prompt",
        "expectedProjectRevision",
        "expectedAssetMetadataRevision",
        "idempotencyKey",
      ],
    }[kind];
    const value = creativeRecord(input, fields);
    const idempotencyKey = creativeProjectOpaqueId(value.idempotencyKey);
    if (kind === "create-project")
      return Object.freeze({
        title: creativeProjectTitle(value.title),
        briefText: creativeProjectBriefText(value.briefText),
        idempotencyKey,
      });
    const common = {
      projectId: creativeProjectOpaqueId(value.projectId),
      expectedProjectRevision: creativeProjectRevision(
        value.expectedProjectRevision,
      ),
      idempotencyKey,
    };
    switch (kind) {
      case "rename-project":
        return Object.freeze({
          ...common,
          title: creativeProjectTitle(value.title),
        });
      case "set-project-state":
        return Object.freeze({
          ...common,
          state: creativeState(value.state) as "active" | "archived",
        });
      case "append-brief":
        return Object.freeze({
          ...common,
          text: creativeProjectBriefText(value.text),
        });
      case "create-concept":
        return Object.freeze({
          ...common,
          briefRevision: creativeProjectRevision(value.briefRevision),
          name: creativeProjectTitle(value.name),
          prompt: creativeProjectPrompt(value.prompt),
        });
      case "append-concept":
        return Object.freeze({
          ...common,
          assetId: creativeProjectOpaqueId(value.assetId),
          briefRevision: creativeProjectRevision(value.briefRevision),
          prompt: creativeProjectPrompt(value.prompt),
          expectedAssetMetadataRevision: creativeProjectRevision(
            value.expectedAssetMetadataRevision,
          ),
        });
    }
  });
}

export function creativeReceipt(
  actor: ActorContext,
  kind: CreativeProjectMutationKind,
  command: CreativeProjectMutationCommand,
  digester: ContentDigester,
): CreativeProjectMutationReceipt {
  return Object.freeze({
    idempotencyKey: command.idempotencyKey,
    requestDigest: creativeProjectDigest(
      digester.sha256(
        JSON.stringify({
          schemaVersion: "crewon.creative-project-command.v0",
          kind,
          actor,
          command,
        }),
      ),
    ),
  });
}

export function creativeStored<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    throw new ApplicationError(
      "internal",
      "creative_project_store_result_invalid",
      { cause: error },
    );
  }
}

export function creativeStoredRecord(
  input: unknown,
  fields: readonly string[],
) {
  return creativeStored(() => {
    if (input === null || typeof input !== "object" || Array.isArray(input))
      invalidStore();
    const prototype = Object.getPrototypeOf(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(input);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.some((key) => typeof key !== "string") ||
      keys.length !== fields.length ||
      Object.keys(descriptors).sort().join("\0") !==
        [...fields].sort().join("\0") ||
      Object.values(descriptors).some(
        (entry) => !entry.enumerable || !Object.hasOwn(entry, "value"),
      )
    )
      invalidStore();
    return Object.fromEntries(
      fields.map((field) => [field, descriptors[field]!.value]),
    ) as Record<string, unknown>;
  });
}

export function checkedCreativeProject(
  input: unknown,
  owner: CreativeProjectOwnerScope,
  projectId?: string,
): CreativeProject {
  return creativeStored(() => {
    const project = validateCreativeProject(input);
    if (
      project.tenantId !== owner.tenantId ||
      project.spaceId !== owner.spaceId ||
      project.ownerPrincipalId !== owner.principalId ||
      (projectId !== undefined && project.projectId !== projectId)
    )
      invalidStore();
    return project;
  });
}

export function checkedCreativeBrief(
  input: unknown,
  project: CreativeProject,
  digester: ContentDigester,
  revision?: number,
): ProjectBriefRevision {
  return creativeStored(() => {
    const brief = parseProjectBriefRevision(input, digester);
    checkChildScope(brief, project);
    if (
      brief.briefRevision > project.latestBriefRevision ||
      (revision !== undefined && brief.briefRevision !== revision)
    )
      invalidStore();
    return brief;
  });
}

export function checkedCreativeAsset(
  input: unknown,
  project: CreativeProject,
  assetId?: string,
): ConceptAsset {
  return creativeStored(() => {
    const asset = validateConceptAsset(input);
    checkChildScope(asset, project);
    if (assetId !== undefined && asset.assetId !== assetId) invalidStore();
    return asset;
  });
}

export function checkedCreativeAssetRevision(
  input: unknown,
  project: CreativeProject,
  digester: ContentDigester,
  assetId: string,
  expected: { assetRevision?: number; latestAssetRevision?: number } = {},
): ConceptAssetRevision {
  return creativeStored(() => {
    const result = parseConceptAssetRevision(input, digester);
    checkChildScope(result, project);
    if (
      result.assetId !== assetId ||
      result.briefRevision > project.latestBriefRevision ||
      (expected.assetRevision !== undefined &&
        result.assetRevision !== expected.assetRevision) ||
      (expected.latestAssetRevision !== undefined &&
        result.assetRevision > expected.latestAssetRevision)
    )
      invalidStore();
    return result;
  });
}

export function checkedCreativeMutationResult(
  input: unknown,
  actor: ActorContext,
  kind: CreativeProjectMutationKind,
  command: CreativeProjectMutationCommand,
  digester: ContentDigester,
): CreativeProjectMutationResult {
  return creativeStored(() => {
    const extra =
      kind === "create-project" || kind === "append-brief"
        ? ["brief"]
        : kind === "create-concept" || kind === "append-concept"
          ? ["asset", "assetRevision"]
          : [];
    const value = creativeRecord(input, [
      "kind",
      "disposition",
      "project",
      ...extra,
    ]);
    if (
      value.kind !== kind ||
      (value.disposition !== "committed" && value.disposition !== "replayed")
    )
      invalidStore();
    const project = checkedCreativeProject(
      value.project,
      creativeOwner(actor),
      "projectId" in command ? command.projectId : undefined,
    );
    const base = { kind, disposition: value.disposition, project };
    if (kind === "create-project") {
      const requested = command as { title: string; briefText: string };
      const brief = checkedCreativeBrief(value.brief, project, digester, 1);
      if (
        project.title !== requested.title ||
        project.state !== "active" ||
        project.revision !== 2 ||
        project.latestBriefRevision !== 1 ||
        brief.text !== requested.briefText ||
        project.createdByActorId !== actor.actorId ||
        brief.createdByActorId !== actor.actorId
      )
        invalidStore();
      return Object.freeze({ ...base, brief }) as CreativeProjectMutationResult;
    }
    const expected = (command as { expectedProjectRevision: number })
      .expectedProjectRevision;
    if (kind === "rename-project" || kind === "set-project-state") {
      if (
        (project.revision !== expected && project.revision !== expected + 1) ||
        (kind === "rename-project"
          ? project.title !== (command as { title: string }).title
          : project.state !== (command as { state: string }).state)
      )
        invalidStore();
      return Object.freeze(base) as CreativeProjectMutationResult;
    }
    if (
      project.revision !== expected + 1 ||
      project.updatedByActorId !== actor.actorId
    )
      invalidStore();
    if (kind === "append-brief") {
      const brief = checkedCreativeBrief(
        value.brief,
        project,
        digester,
        project.latestBriefRevision,
      );
      if (
        brief.text !== (command as { text: string }).text ||
        brief.createdByActorId !== actor.actorId
      )
        invalidStore();
      return Object.freeze({ ...base, brief }) as CreativeProjectMutationResult;
    }
    const requested = command as {
      assetId?: string;
      briefRevision: number;
      prompt: string;
      name?: string;
      expectedAssetMetadataRevision?: number;
    };
    const asset = checkedCreativeAsset(value.asset, project, requested.assetId);
    const assetRevision = checkedCreativeAssetRevision(
      value.assetRevision,
      project,
      digester,
      asset.assetId,
      {
        assetRevision: asset.latestAssetRevision,
        latestAssetRevision: asset.latestAssetRevision,
      },
    );
    if (
      assetRevision.briefRevision !== requested.briefRevision ||
      assetRevision.prompt !== requested.prompt ||
      assetRevision.createdByActorId !== actor.actorId ||
      asset.updatedByActorId !== actor.actorId ||
      (kind === "create-concept"
        ? asset.name !== requested.name ||
          asset.revision !== 1 ||
          asset.latestAssetRevision !== 1
        : asset.revision !== requested.expectedAssetMetadataRevision! + 1)
    )
      invalidStore();
    return Object.freeze({
      ...base,
      asset,
      assetRevision,
    }) as CreativeProjectMutationResult;
  });
}

export type CreativeProjectPreparedRecords = Readonly<{
  project: CreativeProject;
  brief?: ProjectBriefRevision;
  asset?: ConceptAsset;
  assetRevision?: ConceptAssetRevision;
}>;

/** Confirmed new commits must return every prepared record unchanged; late replay uses its original IDs/time. */
export function assertCreativeCommittedRecords(
  result: CreativeProjectMutationResult,
  prepared: CreativeProjectPreparedRecords,
): void {
  if (result.disposition !== "committed") return;
  creativeStored(() => {
    const returned = result as unknown as Record<string, unknown>;
    for (const key of Object.keys(
      prepared,
    ) as (keyof CreativeProjectPreparedRecords)[]) {
      const expected = prepared[key]!;
      const actual = returned[key];
      if (
        actual === null ||
        typeof actual !== "object" ||
        canonicalFlatRecord(expected) !== canonicalFlatRecord(actual)
      )
        invalidStore();
    }
  });
}

/** UTF-8 binary order for valid Unicode IDs agrees with scalar order, independently of locale. */
export function compareCreativeIds(left: string, right: string): number {
  const a = Array.from(left, (point) => point.codePointAt(0)!);
  const b = Array.from(right, (point) => point.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

function canonicalFlatRecord(value: object): string {
  return JSON.stringify(
    Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

export function creativePage<T>(
  input: unknown,
  limit: number,
  check: (item: unknown) => T,
  ordered: (previous: T, next: T) => boolean,
): readonly T[] {
  return creativeStored(() => {
    if (!Array.isArray(input) || input.length > limit) invalidStore();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (
      Reflect.ownKeys(input).length !== input.length + 1 ||
      Object.keys(descriptors).some(
        (key) =>
          key !== "length" &&
          (!Object.hasOwn(descriptors[key]!, "value") ||
            !descriptors[key]!.enumerable),
      )
    )
      invalidStore();
    const result = Array.from({ length: input.length }, (_, index) => {
      const item = descriptors[String(index)];
      if (item === undefined || !Object.hasOwn(item, "value")) invalidStore();
      return check(item.value);
    });
    if (
      result.some(
        (item, index) => index > 0 && !ordered(result[index - 1]!, item),
      )
    )
      invalidStore();
    return Object.freeze(result);
  });
}

export async function creativeProjectUseCase<T>(
  execute: () => Promise<T>,
): Promise<T> {
  try {
    return await execute();
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    const code = errorCode(error);
    if (
      [
        "creative_project_owner_mismatch",
        "creative_project_scope_mismatch",
      ].includes(code)
    )
      throw new ApplicationError("authorization", code, { cause: error });
    if (
      [
        "creative_project_not_found",
        "creative_project_brief_not_found",
        "creative_project_asset_not_found",
        "creative_project_asset_revision_not_found",
      ].includes(code)
    )
      throw new ApplicationError("notFound", code, { cause: error });
    if (
      [
        "creative_project_revision_conflict",
        "creative_project_asset_revision_conflict",
        "creative_project_idempotency_conflict",
        "creative_project_archived",
        "creative_project_revision_exhausted",
        "creative_project_brief_reference_invalid",
      ].includes(code)
    )
      throw new ApplicationError("conflict", code, { cause: error });
    throw new ApplicationError(
      "internal",
      "creative_project_service_unavailable",
      { cause: error },
    );
  }
}

function checkChildScope(
  child: { tenantId: string; spaceId: string; projectId: string },
  project: CreativeProject,
) {
  if (
    child.tenantId !== project.tenantId ||
    child.spaceId !== project.spaceId ||
    child.projectId !== project.projectId
  )
    invalidStore();
}
function errorCode(error: unknown): string {
  return error instanceof Error
    ? "code" in error && typeof error.code === "string"
      ? error.code
      : error.message
    : "";
}
export function invalidStore(): never {
  throw new Error("creative_project_store_result_invalid");
}
function invalidCommand(): never {
  throw new ApplicationError("validation", "creative_project_command_invalid");
}
