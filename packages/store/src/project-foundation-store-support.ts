import { createHash } from "node:crypto";
import type {
  ActorContext,
  CreativeProjectMutationReceipt,
  CreativeProjectOwnerScope,
  ProjectFoundationMutationKind,
  ProjectFoundationMutationResult,
  ProjectFoundationStore,
} from "@crewon/application";
import { captureSourceUploadPreparedPointer } from "@crewon/application";
import {
  assertCreativeProjectOwner,
  assertCreativeProjectScope,
  assertProjectSourceChapterIdentity,
  assertProjectSourceChunkIdentity,
  confirmProjectProposal,
  createProjectFoundation,
  createProjectProposal,
  creativeProjectDigest,
  creativeProjectOpaqueId,
  creativeProjectRevision,
  extensionCanonicalJson,
  parseProjectBriefRevision,
  parseProjectSource,
  parseProjectSourceChapter,
  parseProjectSourceChunk,
  projectSourceScalarLength,
  setProjectFoundationCreativeStartMode,
  setProjectFoundationSource,
  updateProjectFoundationParameters,
  validateCreativeProject,
  validateCreativeProjectActor,
  validateProjectFoundation,
  validateProjectProposal,
  type CreativeProject,
  type ProjectFoundation,
  type ProjectProposal,
  type ProjectSource,
  type ProjectSourceChapter,
  type ProjectSourceChunk,
} from "@crewon/domain";
import {
  creativeStoreDigester,
  creativeStoreOwner,
  prepareCreativeMutation,
  verifyCreativeMutation,
} from "./creative-project-store-records.ts";

type Input<M extends keyof ProjectFoundationStore> = Parameters<
  ProjectFoundationStore[M]
>[0];
export type FoundationIdentity = Readonly<{
  actor: ActorContext;
  owner: CreativeProjectOwnerScope;
  kind: ProjectFoundationMutationKind;
  receipt: CreativeProjectMutationReceipt;
}>;
export type FoundationPrepared =
  | (Input<"commitCreation"> & { kind: "create-project" })
  | (Input<"commitProposal"> & { kind: "save-proposal" })
  | Input<"commitFoundationChange">;

export function foundationFailure(code: string): never {
  throw new Error(code);
}
export function foundationEqual(actual: unknown, expected: unknown): void {
  if (extensionCanonicalJson(actual) !== extensionCanonicalJson(expected))
    foundationFailure("project_foundation_recipe_invalid");
}
export function foundationJson(record: unknown, maximum = 65_536): string {
  const json = extensionCanonicalJson(record);
  if (Buffer.byteLength(json) > maximum)
    foundationFailure("project_foundation_record_limit");
  return json;
}
export function foundationDigest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
export function foundationProposal(input: unknown): ProjectProposal {
  const proposal = validateProjectProposal(input);
  const { contentDigest, ...body } = proposal;
  if (contentDigest !== foundationDigest(extensionCanonicalJson(body)))
    foundationFailure("project_foundation_proposal_digest_mismatch");
  return proposal;
}

/** Recipe envelopes are shallow inspected; source arrays are validated separately, never copied into a small JSON command. */
export function foundationFields(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    foundationFailure("project_foundation_fields_invalid");
  const keys = Reflect.ownKeys(input);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.slice().sort().join("\0") !== [...fields].sort().join("\0") ||
    Object.values(descriptors).some(
      (d) => !d.enumerable || !Object.hasOwn(d, "value"),
    )
  )
    foundationFailure("project_foundation_fields_invalid");
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, d]) => [key, d.value]),
  );
}
function array<T>(input: unknown, parse: (value: unknown) => T): readonly T[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype)
    foundationFailure("project_foundation_source_array_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
  if (
    !Number.isInteger(length) ||
    length < 0 ||
    length > 20_000 ||
    Reflect.ownKeys(input).length !== length + 1
  )
    foundationFailure("project_foundation_source_array_limit");
  const result: T[] = [];
  for (let i = 0; i < length; i++) {
    const d = descriptors[String(i)];
    if (d === undefined || !d.enumerable || !Object.hasOwn(d, "value"))
      foundationFailure("project_foundation_source_array_invalid");
    result.push(parse(d.value));
  }
  return Object.freeze(result);
}
export function foundationIdentity(input: unknown): FoundationIdentity {
  const value = foundationFields(input, ["actor", "kind", "receipt"]);
  const actor = validateCreativeProjectActor(value.actor);
  const receipt = foundationFields(value.receipt, [
    "idempotencyKey",
    "requestDigest",
  ]);
  const kind = foundationKind(value.kind);
  return Object.freeze({
    actor,
    kind,
    owner: Object.freeze({
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      principalId: actor.principalId,
    }),
    receipt: Object.freeze({
      idempotencyKey: creativeProjectOpaqueId(receipt.idempotencyKey),
      requestDigest: creativeProjectDigest(receipt.requestDigest),
    }),
  });
}
export function foundationKind(input: unknown): ProjectFoundationMutationKind {
  if (
    input !== "create-project" &&
    input !== "update-parameters" &&
    input !== "append-source" &&
    input !== "save-proposal" &&
    input !== "confirm-proposal" &&
    input !== "choose-direct-script"
  )
    foundationFailure("project_foundation_mutation_kind_invalid");
  return input;
}
export function foundationRead(
  input: unknown,
  extra: readonly string[] = [],
): Record<string, unknown> & {
  owner: CreativeProjectOwnerScope;
  projectId: string;
} {
  const value = foundationFields(input, ["owner", "projectId", ...extra]);
  return {
    ...value,
    owner: creativeStoreOwner(value.owner),
    projectId: creativeProjectOpaqueId(value.projectId),
  };
}
export function foundationLimit(input: unknown, maximum = 50): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 1 ||
    input > maximum
  )
    foundationFailure("project_foundation_limit_invalid");
  return input;
}

export function prepareFoundation(
  kind: ProjectFoundationMutationKind,
  input: unknown,
): FoundationPrepared {
  const fields =
    kind === "create-project"
      ? [
          "actor",
          "receipt",
          "project",
          "initialBrief",
          "foundation",
          "source",
          "chunks",
          "chapters",
        ]
      : kind === "save-proposal"
        ? [
            "actor",
            "receipt",
            "project",
            "foundation",
            "expectedFoundationRevision",
            "proposal",
          ]
        : [
            "actor",
            "receipt",
            "kind",
            "expectedFoundationRevision",
            "foundation",
            "source",
            "chunks",
            "chapters",
            "proposal",
          ];
  const hasSourceUpload =
    kind !== "save-proposal" &&
    input !== null &&
    typeof input === "object" &&
    Object.hasOwn(input, "sourceUpload");
  const value = foundationFields(
    input,
    hasSourceUpload ? [...fields, "sourceUpload"] : fields,
  );
  if ("kind" in value && value.kind !== kind)
    foundationFailure("project_foundation_mutation_kind_invalid");
  const identity = foundationIdentity({
    actor: value.actor,
    receipt: value.receipt,
    kind,
  });
  const foundation = validateProjectFoundation(value.foundation);
  if (
    foundation.tenantId !== identity.actor.tenantId ||
    foundation.spaceId !== identity.actor.spaceId ||
    foundation.ownerPrincipalId !== identity.actor.principalId
  )
    foundationFailure("project_foundation_owner_mismatch");
  const common = {
    actor: identity.actor,
    receipt: identity.receipt,
    foundation,
  };
  if (kind === "save-proposal") {
    const project = validateCreativeProject(value.project);
    const proposal = foundationProposal(value.proposal);
    assertCreativeProjectOwner(project, identity.actor);
    assertCreativeProjectScope(project, foundation);
    assertCreativeProjectScope(project, proposal);
    return Object.freeze({
      ...common,
      kind,
      project,
      proposal,
      expectedFoundationRevision: creativeProjectRevision(
        value.expectedFoundationRevision,
      ),
    });
  }
  const source =
    value.source === null ? null : parseProjectSource(value.source);
  const sourceUpload = hasSourceUpload
    ? captureSourceUploadPreparedPointer(value.sourceUpload)
    : undefined;
  const chunks = array(value.chunks, parseProjectSourceChunk);
  const chapters = array(value.chapters, parseProjectSourceChapter);
  if (source !== null) verifySourceBundle(foundation, source, chunks, chapters);
  else if (chunks.length !== 0 || chapters.length !== 0)
    foundationFailure("project_foundation_source_required");
  if (kind === "create-project") {
    const project = validateCreativeProject(value.project);
    const initialBrief = parseProjectBriefRevision(
      value.initialBrief,
      creativeStoreDigester,
    );
    assertCreativeProjectOwner(project, identity.actor);
    assertCreativeProjectScope(project, foundation);
    return Object.freeze({
      ...common,
      kind,
      project,
      initialBrief,
      source,
      chunks,
      chapters,
      ...(sourceUpload === undefined ? {} : { sourceUpload }),
    });
  }
  const proposal =
    value.proposal === null ? null : foundationProposal(value.proposal);
  if (source !== null && kind !== "append-source")
    foundationFailure("project_foundation_recipe_invalid");
  if (proposal !== null && kind !== "confirm-proposal")
    foundationFailure("project_foundation_recipe_invalid");
  if (kind === "append-source" && source === null)
    foundationFailure("project_foundation_source_required");
  if (kind === "confirm-proposal" && proposal === null)
    foundationFailure("project_foundation_proposal_required");
  return Object.freeze({
    ...common,
    kind,
    source,
    chunks,
    chapters,
    ...(sourceUpload === undefined ? {} : { sourceUpload }),
    proposal,
    expectedFoundationRevision: creativeProjectRevision(
      value.expectedFoundationRevision,
    ),
  });
}

/** Verify complete normalized material before a trusted ingestion recipe can enter its transaction. */
function verifySourceBundle(
  foundation: ProjectFoundation,
  source: ProjectSource,
  chunks: readonly ProjectSourceChunk[],
  chapters: readonly ProjectSourceChapter[],
): void {
  assertCreativeProjectScope(foundation, source);
  if (
    source.createdByActorId !== foundation.updatedByActorId ||
    source.createdAt !== foundation.updatedAt
  )
    foundationFailure("project_foundation_recipe_invalid");
  const hash = createHash("sha256");
  let offset = 0,
    bytes = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    assertProjectSourceChunkIdentity(source, chunk);
    if (
      chunk.index !== i ||
      chunk.startOffset !== offset ||
      chunk.digest !== foundationDigest(chunk.content)
    )
      foundationFailure("project_foundation_source_chunk_mismatch");
    offset += projectSourceScalarLength(chunk.content);
    bytes += Buffer.byteLength(chunk.content);
    if (bytes > 20_000_000)
      foundationFailure("project_foundation_source_text_limit");
    hash.update(chunk.content);
  }
  if (
    offset !== source.characterLength ||
    source.digest !== `sha256:${hash.digest("hex")}`
  )
    foundationFailure("project_foundation_source_digest_mismatch");
  const ids = new Set<string>();
  let previousEnd = 0;
  for (const chapter of chapters) {
    assertProjectSourceChapterIdentity(source, chapter);
    if (ids.has(chapter.chapterId) || chapter.startOffset < previousEnd)
      foundationFailure("project_foundation_source_chapter_mismatch");
    previousEnd = chapter.endOffset;
    ids.add(chapter.chapterId);
  }
}

/** Re-derive against locked persisted records. Recipes do not confer owner, version, or write authority. */
export function verifyFoundation(
  input: FoundationPrepared,
  stored: {
    project: CreativeProject | null;
    foundation: ProjectFoundation | null;
    latestProposal: ProjectProposal | null;
    confirmedProposal: ProjectProposal | null;
    latestSourceRevision: number;
  },
): ProjectFoundationMutationResult {
  if (input.kind === "create-project") {
    const original = verifyCreativeMutation(
      prepareCreativeMutation("create-project", {
        actor: input.actor,
        receipt: input.receipt,
        project: input.project,
        initialBrief: input.initialBrief,
      }),
      { project: stored.project, brief: null, asset: null },
    );
    if (original.kind !== "create-project" || stored.foundation !== null)
      foundationFailure("project_foundation_recipe_invalid");
    const foundation = createProjectFoundation({
      project: original.project,
      actor: input.actor,
      expectedProjectRevision: original.project.revision,
      origin: input.foundation.origin,
      parameters: input.foundation.parameters,
      source:
        input.source === null
          ? null
          : { revision: input.source.revision, digest: input.source.digest },
      creativeStartMode: input.foundation.creativeStartMode,
      at: original.project.createdAt,
    });
    foundationEqual(foundation, input.foundation);
    if (input.source !== null && input.source.revision !== 1)
      foundationFailure("project_foundation_source_revision_conflict");
    return Object.freeze({
      kind: input.kind,
      disposition: "committed",
      project: original.project,
      foundation,
      brief: original.brief,
      source: input.source,
      proposal: null,
    });
  }
  const project = stored.project;
  const current = stored.foundation;
  if (project === null || current === null)
    foundationFailure("project_foundation_not_found");
  assertCreativeProjectOwner(project, input.actor);
  assertCreativeProjectScope(project, input.foundation);
  if (project.state !== "active")
    foundationFailure("project_foundation_project_archived");
  if (current.revision !== input.expectedFoundationRevision)
    foundationFailure("project_foundation_revision_conflict");
  const mutation = {
    project,
    foundation: current,
    actor: input.actor,
    expectedFoundationRevision: input.expectedFoundationRevision,
    at: input.foundation.updatedAt,
  };
  if (input.kind === "save-proposal") {
    foundationEqual(input.foundation, current);
    foundationEqual(input.project, project);
    const proposal = createProjectProposal({
      ...mutation,
      previousProposal: stored.latestProposal,
      expectedProposalRevision: stored.latestProposal?.revision ?? 0,
      kind: input.proposal.kind,
      text: input.proposal.text,
      contentDigest: input.proposal.contentDigest,
      at: input.proposal.createdAt,
    });
    foundationEqual(proposal, input.proposal);
    return Object.freeze({
      kind: input.kind,
      disposition: "committed",
      project,
      foundation: current,
      brief: null,
      source: null,
      proposal,
    });
  }
  let foundation: ProjectFoundation;
  switch (input.kind) {
    case "update-parameters":
      foundation = updateProjectFoundationParameters({
        ...mutation,
        parameters: input.foundation.parameters,
      });
      break;
    case "append-source":
      if (
        input.source === null ||
        input.source.revision !== stored.latestSourceRevision + 1
      )
        foundationFailure("project_foundation_source_revision_conflict");
      foundation = setProjectFoundationSource({
        ...mutation,
        source: {
          revision: input.source.revision,
          digest: input.source.digest,
        },
      });
      break;
    case "confirm-proposal":
      if (input.proposal === null || stored.confirmedProposal === null)
        foundationFailure("project_foundation_proposal_not_found");
      foundationEqual(input.proposal, stored.confirmedProposal);
      foundation = confirmProjectProposal({
        ...mutation,
        proposal: stored.confirmedProposal,
      });
      break;
    case "choose-direct-script":
      if (input.foundation.creativeStartMode === null)
        foundationFailure("project_foundation_recipe_invalid");
      foundation = setProjectFoundationCreativeStartMode({
        ...mutation,
        creativeStartMode: input.foundation.creativeStartMode,
      });
      break;
  }
  foundationEqual(input.foundation, foundation);
  return Object.freeze({
    kind: input.kind,
    disposition: "committed",
    project,
    foundation,
    brief: null,
    source: input.source,
    proposal: input.proposal,
  });
}

export function decodeFoundationReceipt(
  input: unknown,
  identity: FoundationIdentity,
): ProjectFoundationMutationResult {
  const value = foundationFields(input, [
    "kind",
    "disposition",
    "project",
    "foundation",
    "brief",
    "source",
    "proposal",
  ]);
  const project = validateCreativeProject(value.project);
  const foundation = validateProjectFoundation(value.foundation);
  assertCreativeProjectOwner(project, identity.actor);
  assertCreativeProjectScope(project, foundation);
  if (
    value.kind !== identity.kind ||
    value.disposition !== "committed" ||
    foundation.ownerPrincipalId !== project.ownerPrincipalId
  )
    foundationFailure("project_foundation_receipt_invalid");
  const brief =
    value.brief === null
      ? null
      : parseProjectBriefRevision(value.brief, creativeStoreDigester);
  const source =
    value.source === null ? null : parseProjectSource(value.source);
  const proposal =
    value.proposal === null ? null : foundationProposal(value.proposal);
  for (const child of [brief, source, proposal])
    if (child !== null) assertCreativeProjectScope(project, child);
  return Object.freeze({
    kind: identity.kind,
    disposition: "replayed",
    project,
    foundation,
    brief,
    source,
    proposal,
  });
}
