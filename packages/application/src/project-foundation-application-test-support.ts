import {
  confirmProjectProposal,
  createProjectFoundation,
  extensionCanonicalJson,
  readProjectSourcePage,
  setProjectFoundationCreativeStartMode,
  setProjectFoundationSource,
  updateProjectFoundationParameters,
  type CreativeProject,
  type ProjectFoundation,
  type ProjectProposal,
  type ProjectSource,
  type ProjectSourceChapter,
  type ProjectSourceChunk,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import { ProjectFoundationApplicationService } from "./project-foundation-application-service.ts";
import type { ProjectFoundationApplicationDependencies } from "./project-foundation-application-service.ts";
import type { CreateProjectFoundationCommand } from "./project-foundation-commands.ts";
import type { CreativeProjectAuthorizationAction } from "./creative-project-authorization-port.ts";
import type {
  CreativeProjectMutationReceipt,
  CreativeProjectOwnerScope,
} from "./creative-project-store-port.ts";
import type {
  ProjectFoundationCommitOptions,
  ProjectFoundationMutationKind,
  ProjectFoundationMutationResult,
  ProjectFoundationReadScope,
  ProjectFoundationStore,
} from "./project-foundation-store-port.ts";
import type { PreparedProjectSource } from "./project-source-preparation-port.ts";
import type { ProjectSourcePreparationRequest } from "./project-source-preparation-port.ts";
import type { ProjectSourceUploadPreparedPointer } from "./project-source-upload-port.ts";
import type { ProjectSourceUploadCommitAuthority } from "./project-source-upload-port.ts";
import { ApplicationError } from "./application-error.ts";
import { actor, sha256 } from "./creative-project.test-support.ts";
export { actor, sha256 };
type Input<M extends keyof ProjectFoundationStore> = Parameters<
  ProjectFoundationStore[M]
>[0];
type Method = keyof ProjectFoundationStore | "loadProject";
const owner = (who: ActorContext = actor) => ({
  tenantId: who.tenantId,
  spaceId: who.spaceId,
  principalId: who.principalId,
});
function key(
  scope: { tenantId: string; spaceId: string; projectId: string },
  revision?: number,
) {
  return JSON.stringify([
    scope.tenantId,
    scope.spaceId,
    scope.projectId,
    ...(revision === undefined ? [] : [revision]),
  ]);
}
function equal(left: unknown, right: unknown) {
  if (extensionCanonicalJson(left) !== extensionCanonicalJson(right))
    throw new Error("project_foundation_recipe_invalid");
}
function identity(
  input: { actor: ActorContext; receipt: CreativeProjectMutationReceipt },
  kind: ProjectFoundationMutationKind,
) {
  return JSON.stringify([
    input.actor.tenantId,
    input.actor.spaceId,
    input.actor.principalId,
    input.actor.actorId,
    kind,
    input.receipt.idempotencyKey,
  ]);
}

/** Application-contract adapter. Domain-derived CAS and actor receipts; no Store package import. */
export class MemoryProjectFoundations implements ProjectFoundationStore {
  readonly projects = new Map<string, CreativeProject>();
  readonly foundations = new Map<string, ProjectFoundation>();
  readonly sources = new Map<string, ProjectSource>();
  readonly chunks = new Map<string, readonly ProjectSourceChunk[]>();
  readonly chapters = new Map<string, readonly ProjectSourceChapter[]>();
  readonly proposals = new Map<string, ProjectProposal>();
  readonly sourceUploads = new Map<
    string,
    ProjectSourceUploadPreparedPointer
  >();
  readonly receipts = new Map<
    string,
    { digest: string; result: ProjectFoundationMutationResult }
  >();
  readonly calls: Method[] = [];
  before: ((method: Method) => Promise<void>) | null = null;
  override: ((method: Method, raw: unknown) => unknown) | null = null;
  afterCommit: (() => void) | null = null;
  beforePublish: (() => void) | null = null;
  async #read<T>(method: Method, execute: () => T): Promise<T> {
    this.calls.push(method);
    await this.before?.(method);
    const result = execute();
    return (this.override?.(method, result) ?? result) as T;
  }
  #owned(input: ProjectFoundationReadScope) {
    const project = this.projects.get(
      key({ ...input.owner, projectId: input.projectId }),
    );
    return project && project.ownerPrincipalId === input.owner.principalId
      ? project
      : null;
  }
  loadProject(input: ProjectFoundationReadScope) {
    return this.#read("loadProject", () => this.#owned(input));
  }
  loadFoundation(input: Input<"loadFoundation">) {
    return this.#read("loadFoundation", () =>
      this.#owned(input) === null
        ? null
        : (this.foundations.get(
            key({ ...input.owner, projectId: input.projectId }),
          ) ?? null),
    );
  }
  loadSource(input: Input<"loadSource">) {
    return this.#read("loadSource", () =>
      this.#owned(input) === null
        ? null
        : (this.sources.get(
            key({ ...input.owner, projectId: input.projectId }, input.revision),
          ) ?? null),
    );
  }
  loadProposal(input: Input<"loadProposal">) {
    return this.#read("loadProposal", () =>
      this.#owned(input) === null
        ? null
        : (this.proposals.get(
            key({ ...input.owner, projectId: input.projectId }, input.revision),
          ) ?? null),
    );
  }
  listProposals(input: Input<"listProposals">) {
    return this.#read("listProposals", () => {
      const rows =
        this.#owned(input) === null
          ? []
          : [...this.proposals.values()]
              .filter(
                (proposal) =>
                  proposal.projectId === input.projectId &&
                  proposal.tenantId === input.owner.tenantId &&
                  proposal.spaceId === input.owner.spaceId &&
                  proposal.revision > input.afterRevision,
              )
              .sort((a, b) => a.revision - b.revision);
      const proposals = rows.slice(0, input.limit);
      return {
        proposals,
        nextRevision:
          rows.length > input.limit ? proposals.at(-1)!.revision : null,
      };
    });
  }
  readSourcePage(input: Input<"readSourcePage">) {
    return this.#read("readSourcePage", () => {
      if (this.#owned(input) === null)
        throw new Error("project_foundation_source_not_found");
      const sourceKey = key(
        { ...input.owner, projectId: input.projectId },
        input.revision,
      );
      const source = this.sources.get(sourceKey);
      if (!source || source.digest !== input.digest)
        throw new Error("project_foundation_source_digest_mismatch");
      const end = Math.min(
        source.characterLength,
        input.startOffset + input.limit,
      );
      const chunks = (this.chunks.get(sourceKey) ?? []).filter(
        (chunk) =>
          chunk.startOffset < end &&
          chunk.startOffset + Array.from(chunk.content).length >
            input.startOffset,
      );
      return readProjectSourcePage({
        source,
        chunks,
        startOffset: input.startOffset,
        limit: input.limit,
      });
    });
  }
  listSourceChapters(input: Input<"listSourceChapters">) {
    return this.#read("listSourceChapters", () => {
      if (this.#owned(input) === null)
        throw new Error("project_foundation_source_not_found");
      const sourceKey = key(
        { ...input.owner, projectId: input.projectId },
        input.revision,
      );
      if (this.sources.get(sourceKey)?.digest !== input.digest)
        throw new Error("project_foundation_source_digest_mismatch");
      const rows = (this.chapters.get(sourceKey) ?? []).filter(
        (chapter) =>
          input.afterStartOffset === null ||
          chapter.startOffset > input.afterStartOffset,
      );
      const chapters = rows.slice(0, input.limit);
      return {
        chapters,
        nextStartOffset:
          rows.length > input.limit ? chapters.at(-1)!.startOffset : null,
      };
    });
  }
  #receipt(
    input: { actor: ActorContext; receipt: CreativeProjectMutationReceipt },
    kind: ProjectFoundationMutationKind,
  ) {
    const row = this.receipts.get(identity(input, kind));
    if (row === undefined) return null;
    if (row.digest !== input.receipt.requestDigest)
      throw new Error("project_foundation_idempotency_conflict");
    return { ...row.result, disposition: "replayed" as const };
  }
  async loadMutationReceipt(
    input: Input<"loadMutationReceipt">,
    options?: ProjectFoundationCommitOptions,
  ) {
    await options?.authority?.assertCurrent();
    const value = await this.#read("loadMutationReceipt", () =>
      this.#receipt(input, input.kind),
    );
    options?.authority?.assertActive();
    return value;
  }
  async #begin(method: Method, options?: ProjectFoundationCommitOptions) {
    this.calls.push(method);
    await this.before?.(method);
    await options?.authority?.assertCurrent();
    options?.authority?.assertActive();
  }
  #publish(
    method: Method,
    input: { actor: ActorContext; receipt: CreativeProjectMutationReceipt },
    result: ProjectFoundationMutationResult,
    options?: ProjectFoundationCommitOptions,
    sourceRecords?: {
      chunks: readonly ProjectSourceChunk[];
      chapters: readonly ProjectSourceChapter[];
      sourceUpload?: ProjectSourceUploadPreparedPointer;
    },
  ) {
    this.beforePublish?.();
    options?.authority?.assertActive();
    this.projects.set(key(result.project), result.project);
    this.foundations.set(key(result.foundation), result.foundation);
    if (result.source !== null) {
      this.sources.set(
        key(result.source, result.source.revision),
        result.source,
      );
      if (sourceRecords !== undefined) {
        if (sourceRecords.sourceUpload !== undefined)
          this.sourceUploads.set(
            key(result.source, result.source.revision),
            sourceRecords.sourceUpload,
          );
        this.chunks.set(
          key(result.source, result.source.revision),
          sourceRecords.chunks,
        );
        this.chapters.set(
          key(result.source, result.source.revision),
          sourceRecords.chapters,
        );
      }
    }
    if (result.proposal !== null)
      this.proposals.set(
        key(result.proposal, result.proposal.revision),
        result.proposal,
      );
    this.receipts.set(identity(input, result.kind), {
      digest: input.receipt.requestDigest,
      result,
    });
    this.afterCommit?.();
    return (this.override?.(method, result) ??
      result) as ProjectFoundationMutationResult;
  }
  async commitCreation(
    input: Input<"commitCreation">,
    options?: ProjectFoundationCommitOptions,
  ) {
    await this.#begin("commitCreation", options);
    const prior = this.#receipt(input, "create-project");
    if (prior !== null) return prior;
    if (this.projects.has(key(input.project)))
      throw new Error("project_foundation_project_conflict");
    equal(
      createProjectFoundation({
        project: input.project,
        actor: input.actor,
        expectedProjectRevision: input.project.revision,
        origin: input.foundation.origin,
        parameters: input.foundation.parameters,
        source:
          input.source === null
            ? null
            : { revision: input.source.revision, digest: input.source.digest },
        creativeStartMode: input.foundation.creativeStartMode,
        at: input.project.createdAt,
      }),
      input.foundation,
    );
    const result: ProjectFoundationMutationResult = {
      kind: "create-project",
      disposition: "committed",
      project: input.project,
      foundation: input.foundation,
      brief: input.initialBrief,
      source: input.source,
      proposal: null,
    };
    const returned = this.#publish(
      "commitCreation",
      input,
      result,
      options,
      input,
    );
    return returned;
  }
  #current(input: {
    actor: ActorContext;
    foundation: ProjectFoundation;
    expectedFoundationRevision: number;
  }) {
    const project = this.#owned({
      owner: owner(input.actor),
      projectId: input.foundation.projectId,
    });
    const foundation = project && this.foundations.get(key(project));
    if (!project || !foundation)
      throw new Error("project_foundation_not_found");
    if (project.state !== "active")
      throw new Error("project_foundation_project_archived");
    if (foundation.revision !== input.expectedFoundationRevision)
      throw new Error("project_foundation_revision_conflict");
    return {
      project,
      foundation,
      actor: input.actor,
      expectedFoundationRevision: input.expectedFoundationRevision,
      at: input.foundation.updatedAt,
    };
  }
  async commitProposal(
    input: Input<"commitProposal">,
    options?: ProjectFoundationCommitOptions,
  ) {
    await this.#begin("commitProposal", options);
    const prior = this.#receipt(input, "save-proposal");
    if (prior !== null) return prior;
    const current = this.#current(input);
    equal(current.project, input.project);
    equal(current.foundation, input.foundation);
    const latest = [...this.proposals.values()]
      .filter((proposal) => key(proposal) === key(current.project))
      .reduce((revision, proposal) => Math.max(revision, proposal.revision), 0);
    if (input.proposal.revision !== latest + 1)
      throw new Error("project_foundation_proposal_revision_conflict");
    return this.#publish(
      "commitProposal",
      input,
      {
        kind: "save-proposal",
        disposition: "committed",
        project: current.project,
        foundation: current.foundation,
        brief: null,
        source: null,
        proposal: input.proposal,
      },
      options,
    );
  }
  async commitFoundationChange(
    input: Input<"commitFoundationChange">,
    options?: ProjectFoundationCommitOptions,
  ) {
    await this.#begin("commitFoundationChange", options);
    const prior = this.#receipt(input, input.kind);
    if (prior !== null) return prior;
    const current = this.#current(input);
    let foundation: ProjectFoundation;
    if (input.kind === "update-parameters")
      foundation = updateProjectFoundationParameters({
        ...current,
        parameters: input.foundation.parameters,
      });
    else if (input.kind === "append-source") {
      const latest = [...this.sources.values()]
        .filter((source) => key(source) === key(current.project))
        .reduce((revision, source) => Math.max(revision, source.revision), 0);
      if (input.source?.revision !== latest + 1)
        throw new Error("project_foundation_source_revision_conflict");
      foundation = setProjectFoundationSource({
        ...current,
        source: {
          revision: input.source!.revision,
          digest: input.source!.digest,
        },
      });
    } else if (input.kind === "confirm-proposal") {
      const stored = this.proposals.get(
        key(input.proposal!, input.proposal!.revision),
      );
      equal(stored, input.proposal);
      foundation = confirmProjectProposal({ ...current, proposal: stored! });
    } else
      foundation = setProjectFoundationCreativeStartMode({
        ...current,
        creativeStartMode: input.foundation.creativeStartMode as
          | "confirm-plan"
          | "direct-script",
      });
    equal(foundation, input.foundation);
    const returned = this.#publish(
      "commitFoundationChange",
      input,
      {
        kind: input.kind,
        disposition: "committed",
        project: current.project,
        foundation,
        brief: null,
        source: input.source,
        proposal: input.proposal,
      },
      options,
      input,
    );
    return returned;
  }
}
export function preparedSource(
  uploadId = "upload-1",
  who = actor,
): PreparedProjectSource {
  const parts = ["雨😀夜\n", "重逢 café。"];
  const text = parts.join("");
  const raw = `<p>${text}</p>`;
  let offset = 0;
  const chunks = parts.map((content, index) => {
    const startOffset = offset;
    offset += Array.from(content).length;
    return { index, startOffset, content, digest: sha256(content) };
  });
  return {
    uploadId,
    owner: owner(who),
    fileName: "原文.html",
    format: "html",
    byteLength: new TextEncoder().encode(raw).length,
    characterLength: offset,
    digest: sha256(text),
    fileDigest: sha256(raw),
    chunks,
    chapters: chunks.map((chunk) => ({
      chapterId: `chapter-${chunk.index}`,
      title: `第${chunk.index + 1}章`,
      startOffset: chunk.startOffset,
      endOffset: chunk.startOffset + Array.from(chunk.content).length,
    })),
  };
}
export function createCommand(
  origin: "creative" | "novel" = "creative",
  idempotencyKey = `create-${origin}`,
): CreateProjectFoundationCommand {
  return {
    title: "雨夜相逢",
    briefText: "两个人在雨夜重逢。",
    origin,
    idempotencyKey,
    creativeStartMode: origin === "creative" ? "confirm-plan" : null,
    sourceUpload:
      origin === "novel"
        ? { uploadId: "upload-1", fileDigest: preparedSource().fileDigest }
        : null,
    parameters: {
      genre: "悬疑",
      episodeMode: "series",
      episodeCount: 3,
      episodeDurationSeconds:
        origin === "novel" ? { minimum: 120, maximum: 300 } : null,
      aspectRatio: "9:16",
      visualStyle: origin === "novel" ? "semi-realistic" : null,
      needsCharacters: true,
      needsArt: true,
      adaptation:
        origin === "novel"
          ? {
              strategy: "core",
              retainedCharacters: ["林雨"],
              retainedScenes: ["雨夜"],
            }
          : null,
    },
  };
}
/** This in-memory recipe fixture explicitly does not prove durable ledger adoption. */
export function createFixture(
  options: Readonly<{
    sourceAdmission?: ProjectFoundationApplicationDependencies["sourceAdmission"];
    omitAdoptionAuthority?: true;
  }> = { sourceAdmission: "trusted-internal-recipe" },
) {
  const store = new MemoryProjectFoundations();
  const f = {
    store,
    idCalls: 0,
    clockCalls: 0,
    sourceCalls: 0,
    sourceRequests: [] as ProjectSourcePreparationRequest[],
    adoptionCaptures: 0,
    adoptionChecks: 0,
    adoptionActiveChecks: 0,
    allowAdoption: true,
    activeAdoption: true,
    adoptionOverride: null as
      | null
      | ((authority: ProjectSourceUploadCommitAuthority) => unknown),
    allow: true,
    authorizations: [] as CreativeProjectAuthorizationAction[],
    uploads: new Map([
      ["upload-1", preparedSource()],
      ["upload-2", preparedSource("upload-2")],
    ]),
    sourceBefore: null as null | (() => Promise<void>),
    service: null as unknown as ProjectFoundationApplicationService,
  };
  f.service = new ProjectFoundationApplicationService({
    projects: store,
    store,
    ...(options.sourceAdmission === undefined
      ? {}
      : { sourceAdmission: options.sourceAdmission }),
    sourcePreparation: {
      ...(options.omitAdoptionAuthority
        ? {}
        : {
            captureAdoptionAuthority(request: ProjectSourcePreparationRequest) {
              f.adoptionCaptures++;
              const authority: ProjectSourceUploadCommitAuthority = {
                version: "crewon.project-source-upload-commit.v1",
                permission: {
                  actor: request.actor,
                  action: "projectSourceUpload:adopt",
                  resource: {
                    kind: "projectSourceUpload",
                    owner: owner(request.actor),
                    uploadId: request.uploadId,
                    projectId: request.projectId,
                  },
                },
                async assertCurrent() {
                  f.adoptionChecks++;
                  if (!f.allowAdoption)
                    throw new ApplicationError(
                      "authorization",
                      "fixture-adopt-denied",
                    );
                },
                assertActive() {
                  f.adoptionActiveChecks++;
                  if (!f.activeAdoption)
                    throw new ApplicationError(
                      "authorization",
                      "fixture-adopt-withdrawn",
                    );
                },
              };
              return (f.adoptionOverride?.(authority) ??
                authority) as ProjectSourceUploadCommitAuthority;
            },
          }),
      async loadPrepared(request) {
        f.sourceCalls++;
        f.sourceRequests.push(request);
        await f.sourceBefore?.();
        return f.uploads.get(request.uploadId) ?? null;
      },
    },
    authorization: {
      async authorize({ action }) {
        f.authorizations.push(action);
        return f.allow
          ? { outcome: "allow" as const }
          : { outcome: "deny" as const, reasonCode: "fixture-denied" };
      },
    },
    clock: {
      now() {
        f.clockCalls++;
        return new Date(Date.UTC(2026, 9, 8, 0, 0, f.clockCalls)).toISOString();
      },
    },
    ids: {
      nextId() {
        return `project-${++f.idCalls}`;
      },
    },
    digester: { sha256 },
  });
  return f;
}
export function replaceFoundation(
  f: ReturnType<typeof createFixture>,
  foundation: ProjectFoundation,
) {
  f.store.foundations.set(key(foundation), foundation);
}
export function replaceProject(
  f: ReturnType<typeof createFixture>,
  project: CreativeProject,
) {
  f.store.projects.set(key(project), project);
}
export function sourceKey(
  scope: { tenantId: string; spaceId: string; projectId: string },
  revision: number,
) {
  return key(scope, revision);
}
