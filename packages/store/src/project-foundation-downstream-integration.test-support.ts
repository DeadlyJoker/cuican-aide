import { randomUUID } from "node:crypto";
import type { ActorContext, ProjectFoundationStore } from "@crewon/application";
import {
  confirmProjectProposal,
  createProjectFoundation,
  createProjectProposal,
  extensionCanonicalJson,
  projectSourceScalarLength,
  updateProjectFoundationParameters,
  validateProjectProposal,
  type CreativeProject,
  type ProjectProposal,
} from "@crewon/domain";
import {
  parameters,
  sourceBundle,
} from "./project-foundation-store.test-support.ts";
import { creativeStoreDigester as digester } from "./creative-project-store-records.ts";

type Parent = Readonly<{
  projectFoundationStore(): ProjectFoundationStore & {
    migrate(): Promise<void>;
  };
}>;

const sqlValue = (value: string | number) =>
  typeof value === "number"
    ? String(value)
    : `'${value.replaceAll("'", "''")}'`;
const nextTime = (at: string) => new Date(Date.parse(at) + 1_000).toISOString();

/**
 * An explicit canonical, internal fixture attachment to an existing original project.
 * It seeds historical SQL facts, not an uploaded file, private UI membership or Run grant.
 * Proposal confirmation/invalidation after the seed use the actual Foundation Store CAS.
 */
export async function seedDownstreamFoundation(
  input: Readonly<{
    parent: Parent;
    project: CreativeProject;
    actor: ActorContext;
    prefix: string;
    execute(sql: string): Promise<unknown>;
    origin?: "creative" | "novel";
    creativeStartMode?: "confirm-plan" | "direct-script";
  }>,
) {
  const { project, actor, prefix } = input;
  const store = input.parent.projectFoundationStore();
  await store.migrate();
  const origin = input.origin ?? "novel";
  const bundle =
    origin === "novel"
      ? sourceBundle(project, 1, project.updatedAt, undefined, actor)
      : null;
  let current = createProjectFoundation({
    project,
    actor,
    expectedProjectRevision: project.revision,
    origin,
    parameters: parameters(origin),
    source:
      bundle === null
        ? null
        : { revision: bundle.source.revision, digest: bundle.source.digest },
    creativeStartMode:
      origin === "creative"
        ? (input.creativeStartMode ?? "confirm-plan")
        : null,
    at: project.updatedAt,
  });
  let latestProposal: ProjectProposal | null = null;
  const insert = (table: string, values: readonly (string | number)[]) =>
    input.execute(
      `INSERT INTO ${prefix}${table} VALUES(${values.map(sqlValue).join(",")})`,
    );
  const scope = [project.tenantId, project.spaceId, project.projectId];
  if (bundle !== null) {
    await insert("project_sources", [
      ...scope,
      bundle.source.revision,
      bundle.source.digest,
      bundle.source.fileDigest,
      bundle.source.characterLength,
      JSON.stringify(bundle.source),
    ]);
    for (const chunk of bundle.chunks)
      await insert("project_source_chunks", [
        ...scope,
        chunk.sourceRevision,
        chunk.index,
        chunk.startOffset,
        projectSourceScalarLength(chunk.content),
        chunk.content,
        chunk.digest,
      ]);
    for (const chapter of bundle.chapters)
      await insert("project_source_chapters", [
        ...scope,
        chapter.sourceRevision,
        chapter.chapterId,
        chapter.startOffset,
        chapter.endOffset,
        JSON.stringify(chapter),
      ]);
  }
  await insert("project_foundations", [
    ...scope,
    current.ownerPrincipalId,
    current.origin,
    current.revision,
    current.parametersRevision,
    JSON.stringify(current),
  ]);
  const receipt = () => {
    const idempotencyKey = randomUUID();
    return { idempotencyKey, requestDigest: digester.sha256(idempotencyKey) };
  };
  async function confirm() {
    const value = createProjectProposal({
      project,
      foundation: current,
      actor,
      expectedFoundationRevision: current.revision,
      previousProposal: latestProposal,
      expectedProposalRevision: latestProposal?.revision ?? 0,
      kind: origin === "novel" ? "novel-adaptation" : "creative-plan",
      text: "实际内部改编方案：保留雨夜重逢，分集围绕信件展开。",
      contentDigest: digester.sha256("placeholder"),
      at: nextTime(current.updatedAt),
    });
    const { contentDigest: _digest, ...body } = value;
    const proposal = validateProjectProposal({
      ...body,
      contentDigest: digester.sha256(extensionCanonicalJson(body)),
    });
    const saved = await store.commitProposal({
      actor,
      receipt: receipt(),
      project,
      foundation: current,
      expectedFoundationRevision: current.revision,
      proposal,
    });
    latestProposal = saved.proposal;
    const foundation = confirmProjectProposal({
      project,
      foundation: current,
      actor,
      expectedFoundationRevision: current.revision,
      proposal,
      at: nextTime(current.updatedAt),
    });
    const result = await store.commitFoundationChange({
      actor,
      receipt: receipt(),
      kind: "confirm-proposal",
      expectedFoundationRevision: current.revision,
      foundation,
      source: null,
      chunks: [],
      chapters: [],
      proposal,
    });
    current = result.foundation;
    return result;
  }
  async function invalidate() {
    const foundation = updateProjectFoundationParameters({
      project,
      foundation: current,
      actor,
      expectedFoundationRevision: current.revision,
      parameters: {
        ...current.parameters,
        episodeCount: (current.parameters.episodeCount ?? 1) + 1,
      },
      at: nextTime(current.updatedAt),
    });
    const result = await store.commitFoundationChange({
      actor,
      receipt: receipt(),
      kind: "update-parameters",
      expectedFoundationRevision: current.revision,
      foundation,
      source: null,
      chunks: [],
      chapters: [],
      proposal: null,
    });
    current = result.foundation;
    return result;
  }
  return {
    store,
    confirm,
    invalidate,
    get foundation() {
      return current;
    },
  };
}
