import assert from "node:assert/strict";
import {
  extensionCanonicalJson,
  saveProjectOutlineCandidate,
  saveProjectScriptCandidate,
  selectProjectTextRevision,
  setProjectTextArtifactLocked,
  type ProjectOutlineRevision,
  type ProjectTextArtifact,
  type ProjectTextArtifactRevision,
} from "@crewon/domain";
import {
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitCurrent,
} from "./creative-project-commit-authority.ts";
import { captureProjectTextCommitAuthority } from "./project-text-application-support.ts";
import { ProjectTextApplicationService } from "./project-text-application-service.ts";
import type {
  ProjectTextMutationIdentity,
  ProjectTextMutationResult,
  ProjectTextStore,
} from "./project-text-store-port.ts";
import type { CreativeProjectCommitOptions } from "./creative-project-store-port.ts";
import {
  actor,
  createCommand,
  createFixture,
  sha256,
} from "./creative-project.test-support.ts";

export { actor, sha256 };
export const outlineContent = {
  title: "夜航",
  logline: "修复师发现线索",
  synopsis: "三个雨夜揭开谜团。",
  episodes: [1, 2, 3].map((number) => ({
    episodeId: `ep-${number}`,
    title: `第${number}集`,
    summary: `第${number}集概要`,
  })),
};
export const scriptContent = {
  title: "第一集",
  scenes: [
    {
      sceneId: "scene-1",
      location: "修复室",
      timeOfDay: "夜",
      action: "她抬起头。",
      dialogue: [{ speaker: "修复师", text: "你终于来了。" }],
    },
  ],
};
type Input<M extends keyof ProjectTextStore> = Parameters<
  NonNullable<ProjectTextStore[M]>
>[0];
type Commit =
  | Input<"commitCandidate">
  | Input<"commitSelection">
  | Input<"commitLock">;

/** Application-only fixture. Real database lock, SQL and crash boundaries have separate Store tests. */
export class MemoryProjectText implements ProjectTextStore {
  readonly artifacts = new Map<string, ProjectTextArtifact>();
  readonly revisions = new Map<string, ProjectTextArtifactRevision>();
  readonly receipts = new Map<
    string,
    { digest: string; result: ProjectTextMutationResult }
  >();
  readonly commits: ProjectTextMutationResult[] = [];
  before: ((method: keyof ProjectTextStore) => Promise<void>) | null = null;
  override:
    | ((method: keyof ProjectTextStore, value: unknown) => unknown)
    | null = null;
  beforeCommit: (() => Promise<void>) | null = null;
  afterCommit: (() => void) | null = null;
  readonly projects: ReturnType<typeof createFixture>["store"];
  constructor(projects: ReturnType<typeof createFixture>["store"]) {
    this.projects = projects;
  }
  async #read<M extends keyof ProjectTextStore, T>(
    method: M,
    work: () => T,
  ): Promise<T> {
    await this.before?.(method);
    const value = work();
    return (this.override === null ? value : this.override(method, value)) as T;
  }
  #visible(artifact: ProjectTextArtifact, input: Input<"loadOutline">) {
    return (
      artifact.tenantId === input.owner.tenantId &&
      artifact.spaceId === input.owner.spaceId &&
      artifact.ownerPrincipalId === input.owner.principalId &&
      artifact.projectId === input.projectId
    );
  }
  loadOutline(input: Input<"loadOutline">) {
    return this.#read(
      "loadOutline",
      () =>
        [...this.artifacts.values()].find(
          (row) => this.#visible(row, input) && row.kind === "outline",
        ) ?? null,
    );
  }
  loadScript(input: Input<"loadScript">) {
    return this.#read(
      "loadScript",
      () =>
        [...this.artifacts.values()].find(
          (row) =>
            this.#visible(row, input) &&
            row.kind === "script" &&
            row.episodeId === input.episodeId,
        ) ?? null,
    );
  }
  loadArtifact(input: Input<"loadArtifact">) {
    return this.#read("loadArtifact", () => {
      const row = this.artifacts.get(input.artifactId);
      return row !== undefined && this.#visible(row, input) ? row : null;
    });
  }
  loadRevision(input: Input<"loadRevision">) {
    return this.#read("loadRevision", () => {
      const head = this.artifacts.get(input.artifactId);
      return head !== undefined && this.#visible(head, input)
        ? (this.revisions.get(`${input.artifactId}/${input.contentRevision}`) ??
            null)
        : null;
    });
  }
  listArtifacts(input: Input<"listArtifacts">) {
    return this.#read("listArtifacts", () => {
      const rows = [...this.artifacts.values()]
        .filter(
          (row) =>
            this.#visible(row, input) &&
            (input.afterArtifactId === null ||
              row.artifactId > input.afterArtifactId),
        )
        .sort((a, b) => a.artifactId.localeCompare(b.artifactId));
      const artifacts = rows.slice(0, input.limit);
      return {
        artifacts,
        nextArtifactId:
          rows.length > input.limit ? artifacts.at(-1)!.artifactId : null,
      };
    });
  }
  listRevisions(input: Input<"listRevisions">) {
    return this.#read("listRevisions", () => {
      const head = this.artifacts.get(input.artifactId);
      const rows =
        head !== undefined && this.#visible(head, input)
          ? [...this.revisions.values()]
              .filter(
                (row) =>
                  row.artifactId === input.artifactId &&
                  row.contentRevision > input.afterContentRevision,
              )
              .sort((a, b) => a.contentRevision - b.contentRevision)
          : [];
      const revisions = rows.slice(0, input.limit);
      return {
        revisions,
        nextContentRevision:
          rows.length > input.limit ? revisions.at(-1)!.contentRevision : null,
      };
    });
  }
  #receipt(input: ProjectTextMutationIdentity) {
    const key = JSON.stringify([
      input.actor,
      input.kind,
      input.receipt.idempotencyKey,
    ]);
    const saved = this.receipts.get(key);
    if (saved !== undefined && saved.digest !== input.receipt.requestDigest)
      throw new Error("project_text_idempotency_conflict");
    return saved === undefined
      ? null
      : Object.freeze({ ...saved.result, disposition: "replayed" as const });
  }
  loadMutationReceipt(input: ProjectTextMutationIdentity) {
    return this.#read("loadMutationReceipt", () => this.#receipt(input));
  }
  commitCandidate(
    input: Input<"commitCandidate">,
    options?: CreativeProjectCommitOptions,
  ) {
    return this.#commit(input.kind, input, options);
  }
  commitSelection(
    input: Input<"commitSelection">,
    options?: CreativeProjectCommitOptions,
  ) {
    return this.#commit("select-revision", input, options);
  }
  commitLock(
    input: Input<"commitLock">,
    options?: CreativeProjectCommitOptions,
  ) {
    return this.#commit("set-lock", input, options);
  }
  async #commit(
    kind: ProjectTextMutationResult["kind"],
    input: Commit,
    options: CreativeProjectCommitOptions | undefined,
  ) {
    const authority = captureProjectTextCommitAuthority(options);
    await assertCreativeProjectCommitCurrent(authority);
    await this.beforeCommit?.();
    const replay = this.#receipt({
      actor: input.actor,
      kind,
      receipt: input.receipt,
    });
    if (replay !== null) return replay;
    const owner = {
      tenantId: input.actor.tenantId,
      spaceId: input.actor.spaceId,
      principalId: input.actor.principalId,
    };
    const project = await this.projects.loadProject({
      owner,
      projectId: input.project.projectId,
    });
    if (project === null) throw new Error("creative_project_not_found");
    const actual =
      [...this.artifacts.values()].find(
        (row) =>
          this.#visible(row, { owner, projectId: project.projectId }) &&
          row.kind === input.artifact.kind &&
          row.episodeId === input.artifact.episodeId,
      ) ?? null;
    const common = {
      project,
      actor: input.actor,
      artifact: actual,
      expectedArtifactRevision: input.expectedArtifactRevision,
      at: input.artifact.updatedAt,
    };
    let prepared: {
      artifact: ProjectTextArtifact;
      contentRevision: ProjectTextArtifactRevision | null;
    };
    if (kind === "save-outline" || kind === "save-script") {
      const revision = (input as Input<"commitCandidate">).contentRevision;
      const brief = await this.projects.loadBrief({
        owner,
        projectId: project.projectId,
        briefRevision: revision.brief.briefRevision,
      });
      if (brief === null) throw new Error("creative_project_brief_not_found");
      prepared =
        revision.kind === "outline"
          ? saveProjectOutlineCandidate(
              {
                ...common,
                artifactId: input.artifact.artifactId,
                brief,
                content: revision.content,
              },
              { sha256 },
            )
          : saveProjectScriptCandidate(
              {
                ...common,
                artifactId: input.artifact.artifactId,
                brief,
                content: revision.content,
                episodeId: revision.episodeId,
                outline:
                  revision.outline === null
                    ? null
                    : (this.revisions.get(
                        `${revision.outline.artifactId}/${revision.outline.contentRevision}`,
                      ) as ProjectOutlineRevision),
              },
              { sha256 },
            );
    } else {
      if (actual === null) throw new Error("project_text_artifact_not_found");
      if (kind === "set-lock")
        prepared = {
          ...setProjectTextArtifactLocked({
            ...common,
            artifact: actual,
            locked: input.artifact.locked,
          }),
          contentRevision: null,
        };
      else {
        const revision = (input as Input<"commitSelection">).contentRevision;
        const latestBrief = await this.projects.loadBrief({
          owner,
          projectId: project.projectId,
          briefRevision: project.latestBriefRevision,
        });
        if (latestBrief === null)
          throw new Error("creative_project_brief_not_found");
        const head = [...this.artifacts.values()].find(
          (row) =>
            row.kind === "outline" && row.projectId === project.projectId,
        );
        const selectedOutline =
          head?.selectedContentRevision === null || head === undefined
            ? null
            : (this.revisions.get(
                `${head.artifactId}/${head.selectedContentRevision}`,
              ) as ProjectOutlineRevision);
        prepared = selectProjectTextRevision(
          {
            ...common,
            artifact: actual,
            contentRevision: revision,
            latestBrief,
            selectedOutline,
          },
          { sha256 },
        );
      }
    }
    const supplied = {
      artifact: input.artifact,
      contentRevision:
        "contentRevision" in input ? input.contentRevision : null,
    };
    assert.equal(
      extensionCanonicalJson(supplied),
      extensionCanonicalJson(prepared),
    );
    await assertCreativeProjectCommitCurrent(authority);
    assertCreativeProjectCommitActive(authority);
    const result: ProjectTextMutationResult = Object.freeze({
      kind,
      disposition: "committed",
      ...prepared,
    });
    this.artifacts.set(result.artifact.artifactId, result.artifact);
    if (result.contentRevision !== null)
      this.revisions.set(
        `${result.artifact.artifactId}/${result.contentRevision.contentRevision}`,
        result.contentRevision,
      );
    this.receipts.set(
      JSON.stringify([input.actor, kind, input.receipt.idempotencyKey]),
      { digest: input.receipt.requestDigest, result },
    );
    this.commits.push(result);
    this.afterCommit?.();
    return result;
  }
}
export async function createProjectTextFixture() {
  const original = createFixture();
  const created = await original.service.createProject(actor, createCommand());
  const store = new MemoryProjectText(original.store);
  const fixture = {
    original,
    store,
    project: created.project,
    denied: false,
    authorizations: 0,
    ids: 0,
    service: null as unknown as ProjectTextApplicationService,
  };
  fixture.service = new ProjectTextApplicationService({
    store,
    projects: original.store,
    authorization: {
      authorize: async () => {
        fixture.authorizations++;
        return fixture.denied
          ? { outcome: "deny", reasonCode: "test_withdrawn" }
          : { outcome: "allow" };
      },
    },
    clock: {
      now: () =>
        new Date(Date.UTC(2026, 9, 5, 0, 0, fixture.ids)).toISOString(),
    },
    ids: { nextId: () => `text-${++fixture.ids}` },
    digester: { sha256 },
  });
  return fixture;
}
export function outlineCommand(
  projectId: string,
  idempotencyKey = "outline-1",
) {
  return {
    projectId,
    expectedArtifactRevision: 0,
    briefRevision: 1,
    content: outlineContent,
    idempotencyKey,
  };
}
