import {
  creativeProjectDigest,
  creativeProjectOpaqueId,
  creativeProjectRevision,
  parseProjectSourceChapter,
  projectSourceScalarLength,
  type CreativeProject,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import { ApplicationError } from "./application-error.ts";
import type { CreativeProjectStore } from "./creative-project-store-port.ts";
import {
  checkedCreativeProject,
  creativeActor,
  creativeInput,
  creativeOwner,
  creativePage,
  creativeStoredRecord,
} from "./creative-project-application-support.ts";
import type {
  ProjectFoundationQuery,
  ProjectProposalQuery,
  ProjectProposalsQuery,
  ProjectSourceChaptersQuery,
  ProjectSourcePageQuery,
  ProjectSourceQuery,
} from "./project-foundation-commands.ts";
import type { ProjectFoundationStore } from "./project-foundation-store-port.ts";
import {
  checkedFoundation,
  checkedProposal,
  checkedSource,
  foundationFailure,
  foundationLimit,
  foundationRecord,
  foundationStored,
  foundationUseCase,
} from "./project-foundation-application-support.ts";

type Dependencies = Readonly<{
  projects: Pick<CreativeProjectStore, "loadProject">;
  store: ProjectFoundationStore;
  digester: ContentDigester;
  authorize(actor: ActorContext, projectId: string): Promise<void>;
}>;
/** Bounded, owner-joined reads; historical source/proposal versions remain readable. */
export class ProjectFoundationReader {
  readonly #dependencies: Dependencies;
  constructor(dependencies: Dependencies) {
    this.#dependencies = dependencies;
  }
  getFoundation(actor: ActorContext, query: ProjectFoundationQuery) {
    return this.#read(
      actor,
      query,
      ["projectId"],
      (value) => ({ projectId: creativeProjectOpaqueId(value.projectId) }),
      async (who, q, project) => {
        const raw = await this.#dependencies.store.loadFoundation({
          owner: creativeOwner(who),
          projectId: q.projectId,
        });
        return raw === null ? null : checkedFoundation(raw, project);
      },
    );
  }
  getSource(actor: ActorContext, query: ProjectSourceQuery) {
    return this.#read(
      actor,
      query,
      ["projectId", "sourceRevision"],
      sourceQuery,
      async (who, q, project) => this.#source(who, project, q.sourceRevision),
    );
  }
  getProposal(actor: ActorContext, query: ProjectProposalQuery) {
    return this.#read(
      actor,
      query,
      ["projectId", "proposalRevision"],
      (value) => ({
        projectId: creativeProjectOpaqueId(value.projectId),
        proposalRevision: creativeProjectRevision(value.proposalRevision),
      }),
      async (who, q, project) => {
        const raw = await this.#dependencies.store.loadProposal({
          owner: creativeOwner(who),
          projectId: q.projectId,
          revision: q.proposalRevision,
        });
        if (raw === null)
          throw new ApplicationError(
            "notFound",
            "project_foundation_proposal_not_found",
          );
        return checkedProposal(
          raw,
          project,
          this.#dependencies.digester,
          q.proposalRevision,
        );
      },
    );
  }
  readSourcePage(actor: ActorContext, query: ProjectSourcePageQuery) {
    return this.#read(
      actor,
      query,
      ["projectId", "sourceRevision", "sourceDigest", "startOffset", "limit"],
      (value) => ({
        ...sourceQuery(value),
        sourceDigest: creativeProjectDigest(value.sourceDigest),
        startOffset: creativeProjectRevision(value.startOffset, { minimum: 0 }),
        limit: foundationLimit(value.limit, 1_024),
      }),
      async (who, q, project) => {
        const source = await this.#source(who, project, q.sourceRevision);
        if (source.digest !== q.sourceDigest)
          throw new ApplicationError(
            "conflict",
            "project_foundation_source_digest_mismatch",
          );
        if (q.startOffset > source.characterLength)
          throw new ApplicationError(
            "validation",
            "project_foundation_source_range_invalid",
          );
        const raw = await this.#dependencies.store.readSourcePage({
          owner: creativeOwner(who),
          projectId: q.projectId,
          revision: q.sourceRevision,
          digest: q.sourceDigest,
          startOffset: q.startOffset,
          limit: q.limit,
        });
        return foundationStored(() => {
          const page = foundationRecord(raw, [
            "sourceRevision",
            "startOffset",
            "endOffset",
            "content",
            "nextOffset",
          ]);
          const endOffset = Math.min(
            source.characterLength,
            q.startOffset + q.limit,
          );
          if (
            page.sourceRevision !== q.sourceRevision ||
            page.startOffset !== q.startOffset ||
            page.endOffset !== endOffset ||
            typeof page.content !== "string" ||
            projectSourceScalarLength(page.content) !==
              endOffset - q.startOffset ||
            page.nextOffset !==
              (endOffset < source.characterLength ? endOffset : null)
          )
            foundationFailure();
          return Object.freeze({
            sourceRevision: q.sourceRevision,
            startOffset: q.startOffset,
            endOffset,
            content: page.content,
            nextOffset: page.nextOffset as number | null,
          });
        });
      },
    );
  }
  listSourceChapters(actor: ActorContext, query: ProjectSourceChaptersQuery) {
    return this.#read(
      actor,
      query,
      [
        "projectId",
        "sourceRevision",
        "sourceDigest",
        "afterStartOffset",
        "limit",
      ],
      (value) => ({
        ...sourceQuery(value),
        sourceDigest: creativeProjectDigest(value.sourceDigest),
        afterStartOffset:
          value.afterStartOffset === null
            ? null
            : creativeProjectRevision(value.afterStartOffset, { minimum: 0 }),
        limit: foundationLimit(value.limit),
      }),
      async (who, q, project) => {
        const source = await this.#source(who, project, q.sourceRevision);
        if (source.digest !== q.sourceDigest)
          throw new ApplicationError(
            "conflict",
            "project_foundation_source_digest_mismatch",
          );
        const raw = await this.#dependencies.store.listSourceChapters({
          owner: creativeOwner(who),
          projectId: q.projectId,
          revision: q.sourceRevision,
          digest: q.sourceDigest,
          afterStartOffset: q.afterStartOffset,
          limit: q.limit,
        });
        return foundationStored(() => {
          const page = creativeStoredRecord(raw, [
            "chapters",
            "nextStartOffset",
          ]);
          const seen = new Set<string>();
          const chapters = creativePage(
            page.chapters,
            q.limit,
            (item) => {
              const chapter = parseProjectSourceChapter(item);
              if (
                chapter.tenantId !== project.tenantId ||
                chapter.spaceId !== project.spaceId ||
                chapter.projectId !== project.projectId ||
                chapter.sourceRevision !== q.sourceRevision ||
                chapter.endOffset > source.characterLength ||
                (q.afterStartOffset !== null &&
                  chapter.startOffset <= q.afterStartOffset) ||
                seen.has(chapter.chapterId)
              )
                foundationFailure();
              seen.add(chapter.chapterId);
              return chapter;
            },
            (left, right) => left.endOffset <= right.startOffset,
          );
          if (
            page.nextStartOffset !== null &&
            (chapters.length !== q.limit ||
              page.nextStartOffset !== chapters.at(-1)!.startOffset)
          )
            foundationFailure();
          return Object.freeze({
            chapters,
            nextStartOffset: page.nextStartOffset as number | null,
          });
        });
      },
    );
  }
  listProposals(actor: ActorContext, query: ProjectProposalsQuery) {
    return this.#read(
      actor,
      query,
      ["projectId", "afterProposalRevision", "limit"],
      (value) => ({
        projectId: creativeProjectOpaqueId(value.projectId),
        afterProposalRevision: creativeProjectRevision(
          value.afterProposalRevision,
          { minimum: 0 },
        ),
        limit: foundationLimit(value.limit),
      }),
      async (who, q, project) => {
        const raw = await this.#dependencies.store.listProposals({
          owner: creativeOwner(who),
          projectId: q.projectId,
          afterRevision: q.afterProposalRevision,
          limit: q.limit,
        });
        return foundationStored(() => {
          const page = creativeStoredRecord(raw, ["proposals", "nextRevision"]);
          const proposals = creativePage(
            page.proposals,
            q.limit,
            (item) => {
              const proposal = checkedProposal(
                item,
                project,
                this.#dependencies.digester,
              );
              if (proposal.revision <= q.afterProposalRevision)
                foundationFailure();
              return proposal;
            },
            (left, right) => left.revision < right.revision,
          );
          if (
            page.nextRevision !== null &&
            (proposals.length !== q.limit ||
              page.nextRevision !== proposals.at(-1)!.revision)
          )
            foundationFailure();
          return Object.freeze({
            proposals,
            nextRevision: page.nextRevision as number | null,
          });
        });
      },
    );
  }
  async #source(
    actor: ActorContext,
    project: CreativeProject,
    revision: number,
  ) {
    const raw = await this.#dependencies.store.loadSource({
      owner: creativeOwner(actor),
      projectId: project.projectId,
      revision,
    });
    if (raw === null)
      throw new ApplicationError(
        "notFound",
        "project_foundation_source_not_found",
      );
    return checkedSource(raw, project, revision);
  }
  #read<Q extends { projectId: string }, R>(
    actorInput: ActorContext,
    input: unknown,
    fields: readonly string[],
    validate: (value: Record<string, unknown>) => Q,
    read: (
      actor: ActorContext,
      query: Q,
      project: CreativeProject,
    ) => Promise<R>,
  ): Promise<R> {
    return foundationUseCase(async () => {
      const actor = creativeActor(actorInput);
      const query = creativeInput(() =>
        Object.freeze(validate(foundationRecord(input, fields))),
      );
      await this.#dependencies.authorize(actor, query.projectId);
      const raw = await this.#dependencies.projects.loadProject({
        owner: creativeOwner(actor),
        projectId: query.projectId,
      });
      if (raw === null)
        throw new ApplicationError("notFound", "creative_project_not_found");
      const project = checkedCreativeProject(
        raw,
        creativeOwner(actor),
        query.projectId,
      );
      const result = await read(actor, query, project);
      await this.#dependencies.authorize(actor, query.projectId);
      return result;
    });
  }
}
function sourceQuery(value: Record<string, unknown>) {
  return {
    projectId: creativeProjectOpaqueId(value.projectId),
    sourceRevision: creativeProjectRevision(value.sourceRevision),
  };
}
