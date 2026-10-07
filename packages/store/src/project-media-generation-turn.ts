import type { MaterialPreparationPlan as ProjectMediaInputPlan } from "./project-material-preparation-plan.ts";
import {
  parseProjectMediaGenerationReference,
  captureProjectMediaGenerationAuthority,
  parseProjectMediaGenerationLink,
  assertProjectMediaGenerationActive,
  mediaInputDigest,
  mediaInputSame,
  mediaGenerationFail as fail,
  MEDIA_GENERATION_ACTION,
  type CommitExtensionTurnInput,
  type CommitExtensionTurnOptions,
  type ProjectMediaGenerationLink,
  type ProjectMediaGenerationCommitAuthority,
} from "@crewon/application";
import {
  type PluginTaskAdmission,
  extensionCanonicalJson,
} from "@crewon/domain";
import { qualifySavedProjectMediaInput } from "./project-media-input-plan.ts";
import { loadMaterialPreparation } from "./project-material-preparation-plan.ts";
import {
  assetQuery,
  type AssetDialect,
} from "./project-asset-store-support.ts";
import { types } from "node:util";
function field(input: unknown, key: string): unknown {
  if (!input || typeof input !== "object" || types.isProxy(input))
    fail("record_invalid");
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) {
    if (key in input) fail("record_invalid");
    return undefined;
  }
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
    fail("record_invalid");
  return descriptor.value;
}
export type CapturedProjectMediaGenerationTurn = Readonly<{
  reference: NonNullable<CommitExtensionTurnInput["projectMediaGeneration"]>;
  authority: ProjectMediaGenerationCommitAuthority;
  admission: PluginTaskAdmission;
}>;
export function captureProjectMediaGenerationTurn(
  input: CommitExtensionTurnInput,
  admission: PluginTaskAdmission | undefined,
  enabled: boolean,
  options: CommitExtensionTurnOptions | undefined,
) {
  const media = field(input, "projectMediaGeneration"),
    authority =
      options === undefined
        ? undefined
        : field(options, "projectMediaGenerationAuthority");
  if (media === undefined) {
    if (
      authority !== undefined ||
      (admission?.pluginId === "crewon.short-drama" &&
        admission.action === MEDIA_GENERATION_ACTION)
    )
      fail("authority_required");
    return null;
  }
  if (
    !enabled ||
    !admission ||
    !authority ||
    admission.pluginId !== "crewon.short-drama" ||
    admission.action !== MEDIA_GENERATION_ACTION
  )
    fail("unavailable");
  if (
    [
      input.projectGeneration,
      input.projectQuery,
      input.projectHistoricalQuery,
      input.projectStageAdmission,
      input.projectAssetStageAdmission,
      input.projectTextPlanAdmission,
      input.pluginQueryAdmission,
    ].some((v) => v !== undefined)
  )
    fail("task_invalid");
  const reference = parseProjectMediaGenerationReference(media),
    actor = Object.freeze({
      tenantId: admission.tenantId,
      spaceId: admission.spaceId,
      principalId: admission.principalId,
      actorId: admission.actorId,
    });
  return Object.freeze({
    reference,
    admission,
    authority: captureProjectMediaGenerationAuthority(
      authority,
      actor,
      reference,
    ),
  });
}
export function stripProjectMediaGenerationOptions(
  options: CommitExtensionTurnOptions | undefined,
) {
  if (
    options === undefined ||
    field(options, "projectMediaGenerationAuthority") === undefined
  )
    return options;
  const rest: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string") fail("record_invalid");
    const value = field(options, key);
    if (key !== "projectMediaGenerationAuthority") rest[key] = value;
  }
  return Object.keys(rest).length
    ? (rest as CommitExtensionTurnOptions)
    : undefined;
}
/** Original Turn connection only; no file, HTTP, nested transaction or second pool borrow. */
export function* prepareProjectMediaGenerationTurn(
  d: AssetDialect,
  media: CapturedProjectMediaGenerationTurn,
  input: CommitExtensionTurnInput,
): ProjectMediaInputPlan<ProjectMediaGenerationLink> {
  const { reference: r, authority: a, admission } = media;
  const record = yield* qualifySavedProjectMediaInput(
    d,
    {
      actor: a.actor,
      projectId: r.projectId,
      mediaInputId: r.mediaInputId,
      inputRevision: r.inputRevision,
      expectedInputRevision: r.expectedInputRevision,
    },
    a.metadata,
    a.verifier,
  );
  if (
    record.contentDigest !== r.mediaInputDigest ||
    record.workflow.workflowId !== r.workflowId
  )
    fail("input_changed");
  const target = record.target.installation;
  if (
    Object.entries(target).some(
      ([k, v]) => admission[k as keyof PluginTaskAdmission] !== v,
    ) ||
    input.binding.configurationRevision !==
      record.target.configuration.revision ||
    input.binding.configurationDigest !==
      record.target.configuration.contentDigest
  )
    fail("target_changed");
  const byteDigests: string[] = [];
  for (let i = 0; i < record.references.length; i++) {
    const saved = record.references[i]!,
      expected = r.materials[i]!;
    const material = yield* loadMaterialPreparation(
      d,
      saved.preparation,
      a.verifier,
    );
    if (
      !material ||
      material.event.phase !== "verified" ||
      material.event.observation === null ||
      material.initial.intentId !== expected.intentId ||
      material.initial.contentDigest !== expected.initialDigest ||
      material.event.revision !== expected.eventRevision ||
      mediaInputDigest(material.event) !== expected.eventDigest ||
      !mediaInputSame(material.initial.target, record.target) ||
      saved.role !== expected.role
    )
      fail("material_changed");
    byteDigests.push(material.initial.source.source.byteDigest);
    assertProjectMediaGenerationActive(a);
  }
  if (
    r.workflowId === "flux2-three-reference-storyboard" &&
    byteDigests[1] === byteDigests[2]
  )
    fail("characters_duplicated");
  const occupied = yield* assetQuery(
    d,
    `SELECT run_id FROM ${d.prefix}project_media_generation_links WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3 AND principal_id=$4 AND actor_id=$5 AND execution_id=$6`,
    [
      a.actor.tenantId,
      a.actor.spaceId,
      r.projectId,
      a.actor.principalId,
      a.actor.actorId,
      r.executionId,
    ],
  );
  if (occupied.length) fail("execution_occupied");
  const body = {
    schemaVersion: "crewon.project-media-generation-link.v1",
    actor: a.actor,
    reference: r,
    binding: input.binding,
    admission,
    receipt: input.receipt,
  };
  return parseProjectMediaGenerationLink({
    ...body,
    contentDigest: mediaInputDigest(body),
  });
}
export function mediaGenerationLinkValues(link: ProjectMediaGenerationLink) {
  const r = link.reference,
    a = link.actor;
  return [
    a.tenantId,
    a.spaceId,
    r.projectId,
    r.mediaInputId,
    r.inputRevision,
    r.mediaInputDigest,
    a.principalId,
    a.actorId,
    r.executionId,
    link.binding.pluginId,
    link.binding.runId,
    "task",
    link.receipt.idempotencyKey,
    link.receipt.requestDigest,
    link.contentDigest,
    extensionCanonicalJson(link),
  ];
}
export function* saveProjectMediaGenerationTurn(
  d: AssetDialect,
  link: ProjectMediaGenerationLink,
): ProjectMediaInputPlan<void> {
  yield* assetQuery(
    d,
    `INSERT INTO ${d.prefix}project_media_generation_links VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    mediaGenerationLinkValues(link),
  );
  for (const m of link.reference.materials)
    yield* assetQuery(
      d,
      `INSERT INTO ${d.prefix}project_media_generation_materials VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        link.actor.tenantId,
        link.binding.runId,
        m.role,
        m.intentId,
        m.initialDigest,
        m.eventRevision,
        "verified",
      ],
    );
}
export function assertProjectMediaGenerationReplay(
  media: CapturedProjectMediaGenerationTurn | null,
  saved: ProjectMediaGenerationLink | null,
  input: Pick<CommitExtensionTurnInput, "binding" | "receipt">,
) {
  if (media === null) {
    if (saved !== null) fail("replay_conflict");
    return;
  }
  if (
    !saved ||
    !mediaInputSame(saved.reference, media.reference) ||
    !mediaInputSame(saved.actor, media.authority.actor) ||
    !mediaInputSame(saved.binding, input.binding) ||
    !mediaInputSame(saved.receipt, input.receipt)
  )
    fail("replay_conflict");
}
