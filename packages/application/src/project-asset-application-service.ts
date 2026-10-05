import {
  assertProjectAssetRevisionIdentity,
  assertProjectAssetReferenceRevisionIdentity,
  parseProjectAsset,
  parseProjectAssetRevision,
  parseProjectAssetReferenceRevision,
  parseProjectTextArtifact,
  parseProjectTextArtifactRevision,
  projectAssetDependencyStatus,
  projectAssetReferenceState,
  projectAssetId,
  projectAssetKind,
  projectAssetRecord,
  projectAssetRevision,
  type CreativeProject,
  type ProjectAsset,
  type ProjectAssetRevision,
  type ProjectScriptRevision,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { projectAssetScriptSourceIsCurrent } from "./project-asset-application-sources.ts";
import type { ActorContext } from "./authorization-port.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type { CreativeProjectAuthorizationPort } from "./creative-project-authorization-port.ts";
import type { CreativeProjectStore } from "./creative-project-store-port.ts";
import type { ProjectTextStore } from "./project-text-store-port.ts";
import {
  checkedCreativeProject,
  checkedCreativeBrief,
  creativeActor,
  creativeOwner,
  compareCreativeIds,
} from "./creative-project-application-support.ts";
import {
  parseProjectAssetMutationCommand,
  type ProjectAssetMutationKind,
  type ProjectAssetMutationCommand,
  type SaveProjectAssetCandidateCommand,
  type SelectProjectAssetRevisionCommand,
  type SetProjectAssetLockedCommand,
  type SaveProjectAssetReferenceCandidateCommand,
  type SelectProjectAssetReferenceCommand,
} from "./project-asset-commands.ts";
import {
  captureProjectAssetCommitAuthority,
  assertProjectAssetCommitCurrent,
  assertProjectAssetCommitActive,
  type ProjectAssetCommitOptions,
} from "./project-asset-commit-authority.ts";
import { assertProjectAssetUiMutationCommand } from "./project-asset-ui-commit-authority.ts";
import { assertProjectAssetRunMutationCommand } from "./project-asset-run-commit-authority.ts";
import {
  checkedProjectAssetMutationResult,
  projectAssetBoundMethod,
  projectAssetOwnFields,
  projectAssetLimit,
  projectAssetMutationReceipt,
  projectAssetUseCase,
} from "./project-asset-application-support.ts";
import type {
  ProjectAssetStore,
  ProjectAssetView,
  ProjectAssetMutationResult,
  ProjectAssetReadScope,
} from "./project-asset-store-port.ts";

export type ProjectAssetApplicationDependencies = Readonly<{
  store: ProjectAssetStore;
  projects: Pick<CreativeProjectStore, "loadProject" | "loadBrief">;
  texts: Pick<ProjectTextStore, "loadArtifact" | "loadRevision">;
  authorization: CreativeProjectAuthorizationPort;
  clock: ApplicationClock;
  ids: ApplicationIdGenerator;
  digester: ContentDigester;
}>;
const owners = new WeakSet<object>();
export function isProjectAssetApplicationService(
  input: unknown,
): input is ProjectAssetApplicationService {
  return input !== null && typeof input === "object" && owners.has(input);
}

/** Shared metadata commands. This service never starts a Run or calls an image supplier. */
export class ProjectAssetApplicationService {
  readonly #d: ProjectAssetApplicationDependencies;
  constructor(input: ProjectAssetApplicationDependencies) {
    const d = projectAssetOwnFields(input, [
      "store",
      "projects",
      "texts",
      "authorization",
      "clock",
      "ids",
      "digester",
    ]);
    const s = d.store;
    const store: ProjectAssetStore = {
      loadAsset: projectAssetBoundMethod(s, "loadAsset"),
      loadRevision: projectAssetBoundMethod(s, "loadRevision"),
      loadReferenceRevision: projectAssetBoundMethod(
        s,
        "loadReferenceRevision",
      ),
      listAssets: projectAssetBoundMethod(s, "listAssets"),
      listRevisions: projectAssetBoundMethod(s, "listRevisions"),
      listReferences: projectAssetBoundMethod(s, "listReferences"),
      loadMutationReceipt: projectAssetBoundMethod(s, "loadMutationReceipt"),
      commitMutation: projectAssetBoundMethod(s, "commitMutation"),
    };
    this.#d = Object.freeze({
      store: Object.freeze(store),
      projects: Object.freeze({
        loadProject: projectAssetBoundMethod<
          CreativeProjectStore["loadProject"]
        >(d.projects, "loadProject"),
        loadBrief: projectAssetBoundMethod<CreativeProjectStore["loadBrief"]>(
          d.projects,
          "loadBrief",
        ),
      }),
      texts: Object.freeze({
        loadArtifact: projectAssetBoundMethod<ProjectTextStore["loadArtifact"]>(
          d.texts,
          "loadArtifact",
        ),
        loadRevision: projectAssetBoundMethod<ProjectTextStore["loadRevision"]>(
          d.texts,
          "loadRevision",
        ),
      }),
      authorization: Object.freeze({
        authorize: projectAssetBoundMethod<
          CreativeProjectAuthorizationPort["authorize"]
        >(d.authorization, "authorize"),
      }),
      clock: Object.freeze({
        now: projectAssetBoundMethod<ApplicationClock["now"]>(d.clock, "now"),
      }),
      ids: Object.freeze({
        nextId: projectAssetBoundMethod<ApplicationIdGenerator["nextId"]>(
          d.ids,
          "nextId",
        ),
      }),
      digester: Object.freeze({
        sha256: projectAssetBoundMethod<ContentDigester["sha256"]>(
          d.digester,
          "sha256",
        ),
      }),
    });
    owners.add(this);
    Object.freeze(this);
  }
  saveCandidate(
    actor: ActorContext,
    command: SaveProjectAssetCandidateCommand,
    options?: ProjectAssetCommitOptions,
  ) {
    return this.#mutate(actor, "save-content", command, options);
  }
  selectRevision(
    actor: ActorContext,
    command: SelectProjectAssetRevisionCommand,
    options?: ProjectAssetCommitOptions,
  ) {
    return this.#mutate(actor, "select-content", command, options);
  }
  setLocked(
    actor: ActorContext,
    command: SetProjectAssetLockedCommand,
    options?: ProjectAssetCommitOptions,
  ) {
    return this.#mutate(actor, "set-lock", command, options);
  }
  saveReferenceCandidate(
    actor: ActorContext,
    command: SaveProjectAssetReferenceCandidateCommand,
    options?: ProjectAssetCommitOptions,
  ) {
    return this.#mutate(actor, "save-reference", command, options);
  }
  selectReference(
    actor: ActorContext,
    command: SelectProjectAssetReferenceCommand,
    options?: ProjectAssetCommitOptions,
  ) {
    return this.#mutate(actor, "select-reference", command, options);
  }

  async #mutate(
    actorInput: ActorContext,
    kind: ProjectAssetMutationKind,
    raw: ProjectAssetMutationCommand,
    options?: ProjectAssetCommitOptions,
  ): Promise<ProjectAssetMutationResult> {
    return projectAssetUseCase(async () => {
      const actor = creativeActor(actorInput),
        authority = captureProjectAssetCommitAuthority(options);
      let command: ProjectAssetMutationCommand;
      try {
        command = parseProjectAssetMutationCommand(kind, raw);
      } catch (cause) {
        throw new ApplicationError(
          "validation",
          cause instanceof Error &&
          "code" in cause &&
          typeof cause.code === "string"
            ? cause.code
            : "project_asset_command_invalid",
          { cause },
        );
      }
      assertProjectAssetUiMutationCommand(
        authority,
        actor,
        kind,
        command,
        this.#d.digester,
      );
      assertProjectAssetRunMutationCommand(
        authority,
        actor,
        kind,
        command,
        this.#d.digester,
      );
      const policy = () =>
        this.#authorize(actor, "creativeProject:write", command.projectId);
      const commitOptions: ProjectAssetCommitOptions = Object.freeze({
        authority: Object.freeze({
          assertCurrent: async () => {
            await policy();
            await assertProjectAssetCommitCurrent(authority);
          },
          assertTransactionCurrent: async () => {
            await policy();
            if (
              authority &&
              (await authority.assertTransactionCurrent()) !== undefined
            )
              throw new Error("project_asset_commit_authority_invalid");
          },
          assertActive: () => assertProjectAssetCommitActive(authority),
          ...(authority?.uiTransaction === undefined
            ? {}
            : { uiTransaction: authority.uiTransaction }),
          ...(authority?.runTransaction === undefined
            ? {}
            : { runTransaction: authority.runTransaction }),
        }),
      });
      await policy();
      await assertProjectAssetCommitCurrent(authority);
      const receipt = projectAssetMutationReceipt(
          actor,
          kind,
          command,
          this.#d.digester,
        ),
        identity = { actor, kind, receipt };
      const previous = await this.#d.store.loadMutationReceipt(
        identity,
        commitOptions,
      );
      const project = await this.#project(actor, command.projectId);
      if (previous !== null) {
        const result = checkedProjectAssetMutationResult(
          previous,
          actor,
          project,
          kind,
          command,
          this.#d.digester,
        );
        await policy();
        await assertProjectAssetCommitCurrent(authority);
        return Object.freeze({ ...result, disposition: "replayed" });
      }
      const at = this.#d.clock.now();
      const createdAssetId =
        kind === "save-content" && command.assetId === null
          ? projectAssetId(this.#d.ids.nextId("artifact"))
          : null;
      const result = await this.#d.store.commitMutation(
        { actor, kind, command, receipt, at, createdAssetId },
        commitOptions,
      );
      // A confirmed atomic receipt remains valid if a later caller withdrawal arrives.
      return checkedProjectAssetMutationResult(
        result,
        actor,
        project,
        kind,
        command,
        this.#d.digester,
      );
    });
  }
  getAsset(
    actor: ActorContext,
    input: Readonly<{ projectId: string; assetId: string }>,
  ): Promise<ProjectAssetView | null> {
    return this.#read(
      actor,
      input,
      ["projectId", "assetId"],
      async (a, p, q) => {
        const asset = await this.#asset(a, p, projectAssetId(q.assetId));
        return asset === null ? null : this.#view(a, p, asset);
      },
    );
  }
  getRevision(
    actor: ActorContext,
    input: Readonly<{
      projectId: string;
      assetId: string;
      contentRevision: number;
    }>,
  ): Promise<ProjectAssetRevision> {
    return this.#read(
      actor,
      input,
      ["projectId", "assetId", "contentRevision"],
      async (a, p, q) => {
        const asset = await this.#requiredAsset(
          a,
          p,
          projectAssetId(q.assetId),
        );
        return this.#revision(
          a,
          p,
          asset,
          projectAssetRevision(q.contentRevision),
        );
      },
    );
  }
  getReferenceRevision(
    actor: ActorContext,
    input: Readonly<{
      projectId: string;
      assetId: string;
      referenceRevision: number;
    }>,
  ) {
    return this.#read(
      actor,
      input,
      ["projectId", "assetId", "referenceRevision"],
      async (a, p, q) => {
        const asset = await this.#requiredAsset(
          a,
          p,
          projectAssetId(q.assetId),
        );
        return this.#reference(
          a,
          p,
          asset,
          projectAssetRevision(q.referenceRevision),
        );
      },
    );
  }
  listAssets(
    actor: ActorContext,
    input: Readonly<{
      projectId: string;
      kind: "character" | "scene" | "prop" | null;
      afterAssetId: string | null;
      limit: number;
    }>,
  ) {
    return this.#read(
      actor,
      input,
      ["projectId", "kind", "afterAssetId", "limit"],
      async (a, p, q) => {
        const kind = q.kind === null ? null : projectAssetKind(q.kind),
          afterAssetId =
            q.afterAssetId === null ? null : projectAssetId(q.afterAssetId),
          limit = projectAssetLimit(q.limit);
        const raw = await this.#d.store.listAssets({
          ...this.#scope(a, p.projectId),
          kind,
          afterAssetId,
          limit,
        });
        const page = projectAssetOwnFields(raw, ["assets", "nextAssetId"]);
        if (!Array.isArray(page.assets) || page.assets.length > limit)
          invalid();
        const assets = page.assets.map((item) => this.#checkedAsset(item, p));
        if (
          assets.some(
            (asset, i) =>
              (kind !== null && asset.kind !== kind) ||
              compareCreativeIds(
                asset.assetId,
                i === 0 ? (afterAssetId ?? "") : assets[i - 1]!.assetId,
              ) <= 0,
          )
        )
          invalid();
        const nextAssetId =
          page.nextAssetId === null ? null : projectAssetId(page.nextAssetId);
        if (
          nextAssetId !== null &&
          (assets.length !== limit || assets.at(-1)?.assetId !== nextAssetId)
        )
          invalid();
        return Object.freeze({ assets: Object.freeze(assets), nextAssetId });
      },
    );
  }
  listRevisions(
    actor: ActorContext,
    input: Readonly<{
      projectId: string;
      assetId: string;
      afterContentRevision: number;
      limit: number;
    }>,
  ) {
    return this.#read(
      actor,
      input,
      ["projectId", "assetId", "afterContentRevision", "limit"],
      async (a, p, q) => {
        const asset = await this.#requiredAsset(
            a,
            p,
            projectAssetId(q.assetId),
          ),
          after = projectAssetRevision(q.afterContentRevision, 0),
          limit = projectAssetLimit(q.limit);
        const raw = await this.#d.store.listRevisions({
          ...this.#scope(a, p.projectId),
          assetId: asset.assetId,
          afterContentRevision: after,
          limit,
        });
        const page = projectAssetOwnFields(raw, [
          "revisions",
          "nextContentRevision",
        ]);
        if (!Array.isArray(page.revisions) || page.revisions.length > limit)
          invalid();
        const revisions = page.revisions.map((item) => {
          const r = parseProjectAssetRevision(item, this.#d.digester);
          assertProjectAssetRevisionIdentity(asset, r);
          return r;
        });
        if (
          revisions.some(
            (r, i) =>
              r.contentRevision <=
              (i === 0 ? after : revisions[i - 1]!.contentRevision),
          )
        )
          invalid();
        const nextContentRevision =
          page.nextContentRevision === null
            ? null
            : projectAssetRevision(page.nextContentRevision);
        if (
          nextContentRevision !== null &&
          (revisions.length !== limit ||
            revisions.at(-1)?.contentRevision !== nextContentRevision)
        )
          invalid();
        return Object.freeze({
          revisions: Object.freeze(revisions),
          nextContentRevision,
        });
      },
    );
  }
  listReferences(
    actor: ActorContext,
    input: Readonly<{
      projectId: string;
      assetId: string;
      afterReferenceRevision: number;
      limit: number;
    }>,
  ) {
    return this.#read(
      actor,
      input,
      ["projectId", "assetId", "afterReferenceRevision", "limit"],
      async (a, p, q) => {
        const asset = await this.#requiredAsset(
            a,
            p,
            projectAssetId(q.assetId),
          ),
          after = projectAssetRevision(q.afterReferenceRevision, 0),
          limit = projectAssetLimit(q.limit);
        const raw = await this.#d.store.listReferences({
          ...this.#scope(a, p.projectId),
          assetId: asset.assetId,
          afterReferenceRevision: after,
          limit,
        });
        const page = projectAssetOwnFields(raw, [
          "references",
          "nextReferenceRevision",
        ]);
        if (!Array.isArray(page.references) || page.references.length > limit)
          invalid();
        const references = page.references.map((item) => {
          const r = parseProjectAssetReferenceRevision(item, this.#d.digester);
          assertProjectAssetReferenceRevisionIdentity(asset, r);
          return r;
        });
        if (
          references.some(
            (r, i) =>
              r.referenceRevision <=
              (i === 0 ? after : references[i - 1]!.referenceRevision),
          )
        )
          invalid();
        const nextReferenceRevision =
          page.nextReferenceRevision === null
            ? null
            : projectAssetRevision(page.nextReferenceRevision);
        if (
          nextReferenceRevision !== null &&
          (references.length !== limit ||
            references.at(-1)?.referenceRevision !== nextReferenceRevision)
        )
          invalid();
        return Object.freeze({
          references: Object.freeze(references),
          nextReferenceRevision,
        });
      },
    );
  }
  async #read<T>(
    actorInput: ActorContext,
    input: unknown,
    fields: readonly string[],
    read: (
      actor: ActorContext,
      project: CreativeProject,
      query: Record<string, unknown>,
    ) => Promise<T>,
  ): Promise<T> {
    return projectAssetUseCase(async () => {
      const actor = creativeActor(actorInput);
      let q: Record<string, unknown>;
      try {
        q = projectAssetRecord(input, fields);
      } catch (cause) {
        throw new ApplicationError(
          "validation",
          "project_asset_command_invalid",
          { cause },
        );
      }
      const id = projectAssetId(q.projectId);
      await this.#authorize(actor, "creativeProject:read", id);
      const project = await this.#project(actor, id),
        result = await read(actor, project, q);
      await this.#authorize(actor, "creativeProject:read", id);
      return result;
    });
  }
  #scope(actor: ActorContext, projectId: string): ProjectAssetReadScope {
    return { owner: creativeOwner(actor), projectId };
  }
  async #project(actor: ActorContext, id: string): Promise<CreativeProject> {
    const raw = await this.#d.projects.loadProject(this.#scope(actor, id));
    if (raw === null)
      throw new ApplicationError("notFound", "creative_project_not_found");
    return checkedCreativeProject(raw, actor, id);
  }
  #checkedAsset(raw: unknown, p: CreativeProject): ProjectAsset {
    const a = parseProjectAsset(raw);
    if (
      a.tenantId !== p.tenantId ||
      a.spaceId !== p.spaceId ||
      a.projectId !== p.projectId ||
      a.ownerPrincipalId !== p.ownerPrincipalId
    )
      invalid();
    return a;
  }
  async #asset(a: ActorContext, p: CreativeProject, id: string) {
    const raw = await this.#d.store.loadAsset({
      ...this.#scope(a, p.projectId),
      assetId: id,
    });
    if (raw === null) return null;
    const asset = this.#checkedAsset(raw, p);
    if (asset.assetId !== id) invalid();
    return asset;
  }
  async #requiredAsset(a: ActorContext, p: CreativeProject, id: string) {
    const asset = await this.#asset(a, p, id);
    if (!asset)
      throw new ApplicationError("notFound", "project_asset_not_found");
    return asset;
  }
  async #revision(
    a: ActorContext,
    p: CreativeProject,
    asset: ProjectAsset,
    n: number,
  ) {
    const raw = await this.#d.store.loadRevision({
      ...this.#scope(a, p.projectId),
      assetId: asset.assetId,
      contentRevision: n,
    });
    if (raw === null)
      throw new ApplicationError(
        "notFound",
        "project_asset_revision_not_found",
      );
    const r = parseProjectAssetRevision(raw, this.#d.digester);
    assertProjectAssetRevisionIdentity(asset, r);
    if (r.contentRevision !== n) invalid();
    return r;
  }
  async #reference(
    a: ActorContext,
    p: CreativeProject,
    asset: ProjectAsset,
    n: number,
  ) {
    const raw = await this.#d.store.loadReferenceRevision({
      ...this.#scope(a, p.projectId),
      assetId: asset.assetId,
      referenceRevision: n,
    });
    if (raw === null)
      throw new ApplicationError(
        "notFound",
        "project_asset_reference_not_found",
      );
    const r = parseProjectAssetReferenceRevision(raw, this.#d.digester);
    assertProjectAssetReferenceRevisionIdentity(asset, r);
    if (r.referenceRevision !== n) invalid();
    return r;
  }
  async #view(
    a: ActorContext,
    p: CreativeProject,
    asset: ProjectAsset,
  ): Promise<ProjectAssetView> {
    const selectedRevision =
        asset.selectedContentRevision === null
          ? null
          : await this.#revision(a, p, asset, asset.selectedContentRevision),
      selectedReference =
        asset.selectedReferenceRevision === null
          ? null
          : await this.#reference(a, p, asset, asset.selectedReferenceRevision);
    const raw = await this.#d.projects.loadBrief({
      ...this.#scope(a, p.projectId),
      briefRevision: p.latestBriefRevision,
    });
    if (raw === null)
      throw new ApplicationError(
        "internal",
        "project_asset_store_result_invalid",
      );
    const brief = checkedCreativeBrief(
      raw,
      p,
      this.#d.digester,
      p.latestBriefRevision,
    );
    let selectedScript: ProjectScriptRevision | null = null,
      scriptSourceCurrent = true;
    if (selectedRevision?.script) {
      const input = {
          ...this.#scope(a, p.projectId),
          artifactId: selectedRevision.script.artifactId,
        },
        headRaw = await this.#d.texts.loadArtifact(input);
      if (headRaw !== null) {
        const head = parseProjectTextArtifact(headRaw);
        if (
          head.tenantId !== p.tenantId ||
          head.spaceId !== p.spaceId ||
          head.projectId !== p.projectId ||
          head.ownerPrincipalId !== a.principalId ||
          head.artifactId !== input.artifactId ||
          head.kind !== "script"
        )
          invalid();
        if (head.selectedContentRevision !== null) {
          const r = await this.#d.texts.loadRevision({
            ...input,
            contentRevision: head.selectedContentRevision,
          });
          if (r === null) invalid();
          const s = parseProjectTextArtifactRevision(r, this.#d.digester);
          if (
            s.kind !== "script" ||
            s.artifactId !== head.artifactId ||
            s.contentRevision !== head.selectedContentRevision ||
            s.tenantId !== p.tenantId ||
            s.spaceId !== p.spaceId ||
            s.projectId !== p.projectId
          )
            invalid();
          selectedScript = s;
          scriptSourceCurrent = await projectAssetScriptSourceIsCurrent(
            this.#d.texts,
            this.#d.digester,
            a,
            p,
            brief,
            s,
          );
        }
      }
    }
    const dependency = projectAssetDependencyStatus(
      selectedRevision,
      brief,
      selectedScript,
    );
    const sourceStale =
      dependency.staleReasons.length === 0 && !scriptSourceCurrent;
    return Object.freeze({
      asset,
      selectedRevision,
      selectedReference,
      dependencyState: sourceStale ? "stale" : dependency.dependencyState,
      staleReasons: sourceStale
        ? Object.freeze(["script-source-stale" as const])
        : dependency.staleReasons,
      referenceState: projectAssetReferenceState(
        asset,
        selectedRevision,
        selectedReference,
      ),
    });
  }
  async #authorize(
    actor: ActorContext,
    action: "creativeProject:read" | "creativeProject:write",
    projectId: string,
  ) {
    const raw = await this.#d.authorization.authorize({
      actor,
      action,
      resource: {
        kind: "creativeProject",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        projectId,
      },
    });
    if (raw?.outcome !== "allow")
      throw new ApplicationError("authorization", "authorization_denied");
  }
}
function invalid(): never {
  throw new ApplicationError("internal", "project_asset_store_result_invalid");
}
