import { createHash } from "node:crypto";
import { extensionCanonicalJson } from "@crewon/domain";
import type {
  ConceptAsset,
  ConceptAssetRevision,
  CreativeProject,
  ProjectBriefRevision,
} from "@crewon/domain";
import type {
  ActorContext,
  AuthorizationDecision,
} from "./authorization-port.ts";
import type { CreativeProjectAuthorizationAction } from "./creative-project-authorization-port.ts";
import { CreativeProjectApplicationService } from "./creative-project-application-service.ts";
import type {
  CreativeProjectMutationKind,
  CreativeProjectMutationReceipt,
  CreativeProjectMutationResult,
  CreativeProjectOwnerScope,
  CreativeProjectStore,
} from "./creative-project-store-port.ts";

export const actor: ActorContext = Object.freeze({
  tenantId: "tenant-1",
  spaceId: "space-1",
  principalId: "principal-1",
  actorId: "actor-1",
});

export function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function withContentDigest<T extends { contentDigest: string }>(
  record: T,
): T {
  const { contentDigest: _previousDigest, ...body } = record;
  return { ...record, contentDigest: sha256(extensionCanonicalJson(body)) };
}

export function createFixture() {
  const store = new MemoryCreativeProjects();
  const fixture = {
    store,
    idCalls: [] as string[],
    idValue: (kind: string, sequence: number) => `${kind}-${sequence}`,
    clockCalls: 0,
    authorizations: [] as Array<{
      action: CreativeProjectAuthorizationAction;
      actor: ActorContext;
      projectId: string | null;
    }>,
    authorization: (
      _action: CreativeProjectAuthorizationAction,
      _actor: ActorContext,
      _projectId: string | null,
    ): AuthorizationDecision => ({ outcome: "allow" }),
    service: null as unknown as CreativeProjectApplicationService,
  };
  fixture.service = new CreativeProjectApplicationService({
    store,
    authorization: {
      authorize: async ({ action, actor, resource }) => {
        fixture.authorizations.push({
          action,
          actor,
          projectId: resource.projectId,
        });
        return fixture.authorization(action, actor, resource.projectId);
      },
    },
    clock: {
      now: () => {
        fixture.clockCalls += 1;
        return new Date(
          Date.UTC(2026, 9, 2, 0, 0, fixture.clockCalls),
        ).toISOString();
      },
    },
    ids: {
      nextId: (kind) => {
        fixture.idCalls.push(kind);
        return fixture.idValue(kind, fixture.idCalls.length);
      },
    },
    digester: { sha256 },
  });
  return fixture;
}

export function createCommand(key = "create-1") {
  return {
    title: "雨夜相逢",
    briefText: "两个人在雨夜重逢。",
    idempotencyKey: key,
  };
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Method = keyof CreativeProjectStore;
type Input<M extends Method> = Parameters<CreativeProjectStore[M]>[0];
type ReceiptInput = Readonly<{
  actor: ActorContext;
  receipt: CreativeProjectMutationReceipt;
}>;

/**
 * Application contract fixture only: no SQLite/PostgreSQL, Run, supplier, fee or UI.
 * Reads enforce actual principal ownership. Each recipe checks its receipt and CAS
 * before publishing all records plus the receipt in one synchronous memory step.
 */
export class MemoryCreativeProjects implements CreativeProjectStore {
  readonly projects = new Map<string, CreativeProject>();
  readonly briefs = new Map<string, ProjectBriefRevision>();
  readonly assets = new Map<string, ConceptAsset>();
  readonly revisions = new Map<string, ConceptAssetRevision>();
  readonly receipts = new Map<
    string,
    {
      digest: string;
      result: CreativeProjectMutationResult;
    }
  >();
  readonly calls: Array<{ method: Method; input: unknown }> = [];
  readonly commits: CreativeProjectMutationResult[] = [];
  before: ((method: Method, input: unknown) => Promise<void>) | null = null;
  override: ((method: Method, result: unknown) => unknown) | null = null;
  failCommit = false;

  resetCalls() {
    this.calls.length = 0;
  }

  async loadProject(input: Input<"loadProject">) {
    return this.#read("loadProject", input, () =>
      this.#owned(input.owner, input.projectId),
    );
  }

  async listProjects(input: Input<"listProjects">) {
    return this.#read("listProjects", input, () => {
      const records = [...this.projects.values()]
        .filter(
          (project) =>
            ownerMatches(input.owner, project) &&
            (input.state === "all" || project.state === input.state),
        )
        .sort(projectOrder)
        .filter(
          (project) =>
            input.after === null || projectOrder(project, input.after) > 0,
        );
      const projects = records.slice(0, input.limit);
      const last = projects.at(-1);
      return {
        projects,
        next:
          records.length > input.limit && last !== undefined
            ? { updatedAt: last.updatedAt, projectId: last.projectId }
            : null,
      };
    });
  }

  async loadBrief(input: Input<"loadBrief">) {
    return this.#read("loadBrief", input, () =>
      this.#owned(input.owner, input.projectId) === null
        ? null
        : (this.briefs.get(
            briefKey(input.owner, input.projectId, input.briefRevision),
          ) ?? null),
    );
  }

  async listBriefs(input: Input<"listBriefs">) {
    return this.#read("listBriefs", input, () =>
      this.#owned(input.owner, input.projectId) === null
        ? []
        : [...this.briefs.values()]
            .filter(
              (brief) =>
                scopeMatches(input.owner, input.projectId, brief) &&
                brief.briefRevision > input.afterBriefRevision,
            )
            .sort((a, b) => a.briefRevision - b.briefRevision)
            .slice(0, input.limit),
    );
  }

  async loadConceptAsset(input: Input<"loadConceptAsset">) {
    return this.#read("loadConceptAsset", input, () =>
      this.#owned(input.owner, input.projectId) === null
        ? null
        : (this.assets.get(
            assetKey(input.owner, input.projectId, input.assetId),
          ) ?? null),
    );
  }

  async listConceptAssets(input: Input<"listConceptAssets">) {
    return this.#read("listConceptAssets", input, () =>
      this.#owned(input.owner, input.projectId) === null
        ? []
        : [...this.assets.values()]
            .filter(
              (asset) =>
                scopeMatches(input.owner, input.projectId, asset) &&
                (input.afterAssetId === null ||
                  scalarOrder(asset.assetId, input.afterAssetId) > 0),
            )
            .sort((a, b) => scalarOrder(a.assetId, b.assetId))
            .slice(0, input.limit),
    );
  }

  async loadConceptRevision(input: Input<"loadConceptRevision">) {
    return this.#read("loadConceptRevision", input, () =>
      this.#owned(input.owner, input.projectId) === null
        ? null
        : (this.revisions.get(
            revisionKey(
              input.owner,
              input.projectId,
              input.assetId,
              input.assetRevision,
            ),
          ) ?? null),
    );
  }

  async listConceptRevisions(input: Input<"listConceptRevisions">) {
    return this.#read("listConceptRevisions", input, () =>
      this.#owned(input.owner, input.projectId) === null
        ? []
        : [...this.revisions.values()]
            .filter(
              (revision) =>
                scopeMatches(input.owner, input.projectId, revision) &&
                revision.assetId === input.assetId &&
                revision.assetRevision > input.afterAssetRevision,
            )
            .sort((a, b) => a.assetRevision - b.assetRevision)
            .slice(0, input.limit),
    );
  }

  async loadMutationReceipt(input: Input<"loadMutationReceipt">) {
    return this.#read("loadMutationReceipt", input, () =>
      this.#receipt(input, input.kind),
    );
  }

  async commitProjectCreation(input: Input<"commitProjectCreation">) {
    await this.#enter("commitProjectCreation", input);
    const prior = this.#receipt(input, "create-project");
    if (prior !== null)
      return this.#result(
        "commitProjectCreation",
        prior,
      ) as ReturnResult<"commitProjectCreation">;
    if (
      !ownerMatches(ownerFor(input.actor), input.project) ||
      !scopeMatches(input.actor, input.project.projectId, input.initialBrief)
    )
      throw new Error("creative_project_scope_mismatch");
    if (this.projects.has(projectKey(input.actor, input.project.projectId)))
      throw new Error("creative_project_revision_conflict");
    const result = {
      kind: "create-project" as const,
      disposition: "committed" as const,
      project: input.project,
      brief: input.initialBrief,
    };
    this.#publish(input, result, () => {
      this.projects.set(
        projectKey(input.actor, input.project.projectId),
        copy(input.project),
      );
      this.briefs.set(
        briefKey(
          input.actor,
          input.project.projectId,
          input.initialBrief.briefRevision,
        ),
        copy(input.initialBrief),
      );
    });
    return this.#result(
      "commitProjectCreation",
      result,
    ) as ReturnResult<"commitProjectCreation">;
  }

  async commitProjectMetadata(input: Input<"commitProjectMetadata">) {
    await this.#enter("commitProjectMetadata", input);
    const prior = this.#receipt(input, input.kind);
    if (prior !== null)
      return this.#result(
        "commitProjectMetadata",
        prior,
      ) as ReturnResult<"commitProjectMetadata">;
    this.#current(input.actor, input.project, input.expectedProjectRevision);
    const result = {
      kind: input.kind,
      disposition: "committed" as const,
      project: input.project,
    };
    this.#publish(input, result, () => {
      this.projects.set(
        projectKey(input.actor, input.project.projectId),
        copy(input.project),
      );
    });
    return this.#result(
      "commitProjectMetadata",
      result,
    ) as ReturnResult<"commitProjectMetadata">;
  }

  async commitProjectBrief(input: Input<"commitProjectBrief">) {
    await this.#enter("commitProjectBrief", input);
    const prior = this.#receipt(input, "append-brief");
    if (prior !== null)
      return this.#result(
        "commitProjectBrief",
        prior,
      ) as ReturnResult<"commitProjectBrief">;
    this.#current(input.actor, input.project, input.expectedProjectRevision);
    const key = briefKey(
      input.actor,
      input.project.projectId,
      input.brief.briefRevision,
    );
    if (this.briefs.has(key))
      throw new Error("creative_project_revision_conflict");
    const result = {
      kind: "append-brief" as const,
      disposition: "committed" as const,
      project: input.project,
      brief: input.brief,
    };
    this.#publish(input, result, () => {
      this.projects.set(
        projectKey(input.actor, input.project.projectId),
        copy(input.project),
      );
      this.briefs.set(key, copy(input.brief));
    });
    return this.#result(
      "commitProjectBrief",
      result,
    ) as ReturnResult<"commitProjectBrief">;
  }

  async commitConceptRevision(input: Input<"commitConceptRevision">) {
    await this.#enter("commitConceptRevision", input);
    const prior = this.#receipt(input, input.kind);
    if (prior !== null)
      return this.#result(
        "commitConceptRevision",
        prior,
      ) as ReturnResult<"commitConceptRevision">;
    const current = this.#current(
      input.actor,
      input.project,
      input.expectedProjectRevision,
    );
    if (current.state === "archived")
      throw new Error("creative_project_archived");
    const aKey = assetKey(input.actor, current.projectId, input.asset.assetId);
    const oldAsset = this.assets.get(aKey);
    if (
      input.kind === "create-concept"
        ? oldAsset !== undefined
        : oldAsset?.revision !== input.expectedAssetMetadataRevision
    )
      throw new Error("creative_project_revision_conflict");
    const brief = this.briefs.get(
      briefKey(
        input.actor,
        current.projectId,
        input.assetRevision.briefRevision,
      ),
    );
    if (
      brief === undefined ||
      brief.contentDigest !== input.assetRevision.briefContentDigest
    )
      throw new Error("creative_project_brief_mismatch");
    const rKey = revisionKey(
      input.actor,
      current.projectId,
      input.asset.assetId,
      input.assetRevision.assetRevision,
    );
    if (this.revisions.has(rKey))
      throw new Error("creative_project_revision_conflict");
    const result = {
      kind: input.kind,
      disposition: "committed" as const,
      project: input.project,
      asset: input.asset,
      assetRevision: input.assetRevision,
    };
    this.#publish(input, result, () => {
      this.projects.set(
        projectKey(input.actor, current.projectId),
        copy(input.project),
      );
      this.assets.set(aKey, copy(input.asset));
      this.revisions.set(rKey, copy(input.assetRevision));
    });
    return this.#result(
      "commitConceptRevision",
      result,
    ) as ReturnResult<"commitConceptRevision">;
  }

  async #enter<M extends Method>(method: M, input: Input<M>) {
    this.calls.push({ method, input: copy(input) });
    await this.before?.(method, input);
  }

  async #read<M extends Method>(
    method: M,
    input: Input<M>,
    read: () => unknown,
  ): Promise<ReturnResult<M>> {
    await this.#enter(method, input);
    return this.#result(method, read()) as ReturnResult<M>;
  }

  #result(method: Method, result: unknown): unknown {
    const cloned = copy(result);
    return this.override === null ? cloned : this.override(method, cloned);
  }

  #owned(owner: CreativeProjectOwnerScope, projectId: string) {
    const project = this.projects.get(projectKey(owner, projectId));
    return project !== undefined && ownerMatches(owner, project)
      ? project
      : null;
  }

  #current(actor: ActorContext, proposed: CreativeProject, expected: number) {
    const current = this.#owned(ownerFor(actor), proposed.projectId);
    if (current === null) throw new Error("creative_project_not_found");
    if (current.revision !== expected)
      throw new Error("creative_project_revision_conflict");
    return current;
  }

  #receipt(input: ReceiptInput, kind: CreativeProjectMutationKind) {
    const prior = this.receipts.get(receiptKey(input, kind));
    if (prior === undefined) return null;
    if (prior.digest !== input.receipt.requestDigest)
      throw new Error("creative_project_idempotency_conflict");
    return { ...copy(prior.result), disposition: "replayed" as const };
  }

  #publish(
    input: ReceiptInput,
    result: CreativeProjectMutationResult,
    write: () => void,
  ) {
    if (this.failCommit)
      throw new Error("fixture_commit_failed_before_publish");
    write();
    this.receipts.set(receiptKey(input, result.kind), {
      digest: input.receipt.requestDigest,
      result: copy(result),
    });
    this.commits.push(copy(result));
  }
}

type ReturnResult<M extends Method> = Awaited<
  ReturnType<CreativeProjectStore[M]>
>;
function copy<T>(input: T): T {
  return structuredClone(input);
}
function ownerFor(input: ActorContext): CreativeProjectOwnerScope {
  return {
    tenantId: input.tenantId,
    spaceId: input.spaceId,
    principalId: input.principalId,
  };
}
function ownerMatches(
  owner: CreativeProjectOwnerScope,
  project: CreativeProject,
) {
  return (
    project.tenantId === owner.tenantId &&
    project.spaceId === owner.spaceId &&
    project.ownerPrincipalId === owner.principalId
  );
}
function scopeMatches(
  owner: Pick<ActorContext, "tenantId" | "spaceId">,
  projectId: string,
  record: Pick<CreativeProject, "tenantId" | "spaceId" | "projectId">,
) {
  return (
    record.tenantId === owner.tenantId &&
    record.spaceId === owner.spaceId &&
    record.projectId === projectId
  );
}
function projectKey(
  owner: Pick<ActorContext, "tenantId" | "spaceId">,
  projectId: string,
) {
  return JSON.stringify([owner.tenantId, owner.spaceId, projectId]);
}
function briefKey(
  owner: Pick<ActorContext, "tenantId" | "spaceId">,
  projectId: string,
  revision: number,
) {
  return JSON.stringify([projectKey(owner, projectId), revision]);
}
function assetKey(
  owner: Pick<ActorContext, "tenantId" | "spaceId">,
  projectId: string,
  assetId: string,
) {
  return JSON.stringify([projectKey(owner, projectId), assetId]);
}
function revisionKey(
  owner: Pick<ActorContext, "tenantId" | "spaceId">,
  projectId: string,
  assetId: string,
  revision: number,
) {
  return JSON.stringify([assetKey(owner, projectId, assetId), revision]);
}
function receiptKey(input: ReceiptInput, kind: CreativeProjectMutationKind) {
  return JSON.stringify([
    input.actor.tenantId,
    input.actor.spaceId,
    input.actor.principalId,
    input.actor.actorId,
    kind,
    input.receipt.idempotencyKey,
  ]);
}
function projectOrder(
  a: Pick<CreativeProject, "updatedAt" | "projectId">,
  b: Pick<CreativeProject, "updatedAt" | "projectId">,
) {
  return (
    scalarOrder(b.updatedAt, a.updatedAt) ||
    scalarOrder(b.projectId, a.projectId)
  );
}

function scalarOrder(a: string, b: string): number {
  const left = [...a].map((point) => point.codePointAt(0)!);
  const right = [...b].map((point) => point.codePointAt(0)!);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index])
      return left[index]! < right[index]! ? -1 : 1;
  }
  return left.length - right.length;
}
