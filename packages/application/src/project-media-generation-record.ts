import {
  assertPluginTaskAdmission,
  parsePluginTaskAdmission,
  parseProjectConversationBinding,
  parseExtensionRunBinding,
  extensionCanonicalJson,
  projectAssetId,
  projectAssetRevision,
  projectAssetDigest,
} from "@crewon/domain";
import {
  materialPreparationFields as fields,
  materialPreparationDigester as hash,
} from "./project-material-preparation-record.ts";
import {
  mediaInputActor,
  mediaInputData,
  mediaInputDigest,
  mediaInputSame,
  mediaInputRoles,
  captureProjectMediaInputAuthority,
  assertProjectMediaInputActive,
  assertProjectMediaInputCurrent,
} from "./project-media-input-record.ts";
import type { ActorContext } from "./authorization-port.ts";
import { ApplicationError } from "./application-error.ts";
import { captureProjectGenerationImageResultVerifier } from "./project-generation-image-result-verifier.ts";
import type {
  ProjectMediaGenerationReference,
  ProjectMediaGenerationLink,
  ProjectMediaGenerationCommitAuthority,
} from "./project-media-generation-port.ts";
export const MEDIA_GENERATION_ACTION = "media.generate";
export const MEDIA_GENERATION_INPUT_KIND =
  "crewon.short-drama.reference-generation.v1";
export function mediaGenerationFail(code: string): never {
  const category = [
    "denied",
    "authority_required",
    "authority_invalid",
    "owner_mismatch",
  ].includes(code)
    ? "authorization"
    : [
          "input_changed",
          "material_changed",
          "target_changed",
          "execution_occupied",
          "replay_conflict",
          "materials_unavailable",
          "characters_duplicated",
        ].includes(code)
      ? "conflict"
      : [
            "reference_invalid",
            "task_invalid",
            "input_mismatch",
            "record_invalid",
          ].includes(code)
        ? "validation"
        : "internal";
  throw new ApplicationError(category, `project_media_generation_${code}`);
}
export function parseProjectMediaGenerationReference(
  input: unknown,
): ProjectMediaGenerationReference {
  const r = fields(mediaInputData(input, 16384), [
    "schemaVersion",
    "projectId",
    "mediaInputId",
    "inputRevision",
    "expectedInputRevision",
    "executionId",
    "mediaInputDigest",
    "workflowId",
    "materials",
  ]);
  if (
    r.schemaVersion !== "crewon.project-media-generation-reference.v1" ||
    (r.workflowId !== "krea2-reference-four-view" &&
      r.workflowId !== "flux2-three-reference-storyboard")
  )
    mediaGenerationFail("reference_invalid");
  const roles = mediaInputRoles(r.workflowId);
  if (!Array.isArray(r.materials) || r.materials.length !== roles.length)
    mediaGenerationFail("reference_invalid");
  const materials = r.materials.map((value, index) => {
    const m = fields(value, [
        "role",
        "intentId",
        "initialDigest",
        "eventRevision",
        "eventDigest",
      ]),
      revision = projectAssetRevision(m.eventRevision);
    if (m.role !== roles[index] || revision < 2 || revision > 4)
      mediaGenerationFail("reference_invalid");
    return Object.freeze({
      role: roles[index]!,
      intentId: projectAssetId(m.intentId),
      initialDigest: projectAssetDigest(m.initialDigest),
      eventRevision: revision,
      eventDigest: projectAssetDigest(m.eventDigest),
    });
  });
  if (new Set(materials.map((m) => m.intentId)).size !== roles.length)
    mediaGenerationFail("reference_invalid");
  return Object.freeze({
    schemaVersion: r.schemaVersion,
    projectId: projectAssetId(r.projectId),
    mediaInputId: projectAssetId(r.mediaInputId),
    inputRevision: projectAssetRevision(r.inputRevision),
    expectedInputRevision: projectAssetRevision(r.expectedInputRevision),
    executionId: projectAssetId(r.executionId),
    mediaInputDigest: projectAssetDigest(r.mediaInputDigest),
    workflowId: r.workflowId,
    materials: Object.freeze(materials),
  });
}
/** Only business selectors enter the Run message. Worker context will resolve original prompt/material paths. */
export function projectMediaGenerationTaskInput(
  reference: ProjectMediaGenerationReference,
) {
  const r = parseProjectMediaGenerationReference(reference);
  return Object.freeze({
    kind: MEDIA_GENERATION_INPUT_KIND,
    projectId: r.projectId,
    mediaInputId: r.mediaInputId,
    inputRevision: r.inputRevision,
    executionId: r.executionId,
    mediaInputDigest: r.mediaInputDigest,
  });
}
export function captureProjectMediaGenerationAuthority(
  input: unknown,
  actor: ActorContext,
  reference: ProjectMediaGenerationReference,
): ProjectMediaGenerationCommitAuthority {
  const a = fields(input, [
    "version",
    "actor",
    "reference",
    "metadata",
    "verifier",
    "assertCurrent",
    "assertTransactionCurrent",
    "assertActive",
    ...(Object.hasOwn(input as object, "conversation") ? ["conversation"] : []),
  ]);
  if (
    a.version !== "crewon.project-media-generation-commit.v1" ||
    !mediaInputSame(mediaInputActor(a.actor), actor) ||
    !mediaInputSame(
      parseProjectMediaGenerationReference(a.reference),
      reference,
    ) ||
    [a.assertCurrent, a.assertTransactionCurrent, a.assertActive].some(
      (f) => typeof f !== "function",
    )
  )
    mediaGenerationFail("authority_invalid");
  return Object.freeze({
    version: a.version,
    actor,
    reference,
    metadata: captureProjectMediaInputAuthority(
      a.metadata,
      actor,
      reference.projectId,
      "qualify",
    ),
    verifier: captureProjectGenerationImageResultVerifier(a.verifier as never),
    ...(!Object.hasOwn(a, "conversation")
      ? {}
      : {
          conversation: parseProjectConversationBinding(a.conversation, hash),
        }),
    assertCurrent: (a.assertCurrent as () => Promise<void>).bind(input),
    assertTransactionCurrent: (
      a.assertTransactionCurrent as () => Promise<void>
    ).bind(input),
    assertActive: (a.assertActive as () => void).bind(input),
  });
}
export function assertProjectMediaGenerationActive(
  a: ProjectMediaGenerationCommitAuthority,
) {
  assertProjectMediaInputActive(a.metadata);
  const result: unknown = a.assertActive();
  if (result === undefined) return;
  try {
    void Promise.prototype.then.call(
      result,
      () => undefined,
      () => undefined,
    );
  } catch {
    /* Never consume arbitrary thenables. */
  }
  mediaGenerationFail("authority_invalid");
}
export async function assertProjectMediaGenerationCurrent(
  a: ProjectMediaGenerationCommitAuthority,
  phase: "before" | "transaction",
) {
  assertProjectMediaGenerationActive(a);
  await assertProjectMediaInputCurrent(a.metadata, phase);
  if (
    (await (phase === "before"
      ? a.assertCurrent()
      : a.assertTransactionCurrent())) !== undefined
  )
    mediaGenerationFail("authority_invalid");
  assertProjectMediaGenerationActive(a);
}
export function parseProjectMediaGenerationLink(
  input: unknown,
): ProjectMediaGenerationLink {
  const r = fields(mediaInputData(input, 32768), [
    "schemaVersion",
    "actor",
    "reference",
    "binding",
    "admission",
    "receipt",
    "contentDigest",
  ]);
  const actor = mediaInputActor(r.actor),
    reference = parseProjectMediaGenerationReference(r.reference),
    binding = parseExtensionRunBinding(r.binding, hash),
    receiptFields = fields(r.receipt, [
      "actorId",
      "idempotencyKey",
      "requestDigest",
    ]),
    receipt = Object.freeze({
      actorId: projectAssetId(receiptFields.actorId),
      idempotencyKey: projectAssetId(receiptFields.idempotencyKey),
      requestDigest: projectAssetDigest(receiptFields.requestDigest),
    }),
    admission = assertPluginTaskAdmission(
      { admission: parsePluginTaskAdmission(r.admission), binding, receipt },
      hash,
    );
  if (
    r.schemaVersion !== "crewon.project-media-generation-link.v1" ||
    binding.pluginId !== "crewon.short-drama" ||
    binding.source !== null ||
    admission.action !== MEDIA_GENERATION_ACTION ||
    actor.tenantId !== binding.tenantId ||
    actor.spaceId !== binding.spaceId ||
    actor.actorId !== binding.actorId ||
    actor.actorId !== admission.actorId ||
    actor.principalId !== admission.principalId ||
    binding.inputDigest !==
      hash.sha256(
        extensionCanonicalJson(projectMediaGenerationTaskInput(reference)),
      )
  )
    mediaGenerationFail("link_invalid");
  const body = {
    schemaVersion: "crewon.project-media-generation-link.v1" as const,
    actor,
    reference,
    binding,
    admission,
    receipt,
  };
  if (r.contentDigest !== mediaInputDigest(body))
    mediaGenerationFail("digest_mismatch");
  return Object.freeze({ ...body, contentDigest: r.contentDigest });
}
