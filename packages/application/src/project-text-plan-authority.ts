import { createHash } from "node:crypto";
import {
  extensionCanonicalJson,
  parseProjectTextPlan,
  parseProjectTextPlanRevision,
  parseProjectTextPlanStep,
  parseProjectTextPlanRunAdmission,
  parseProjectTextPlanResultReference,
  parseProjectTextPlanDelegation,
  parseProjectConversationBinding,
  parsePluginSelection,
  parseInstalledPluginPackage,
  validateCreativeProjectActor,
  projectTextOpaqueId,
  creativeProjectRevision,
  type ExtensionContentDigester,
} from "@crewon/domain";
import type {
  ProjectTextPlanCommitAuthority,
  ProjectTextPlanTurnCommitAuthority,
  ProjectTextPlanSelectionCommitAuthority,
} from "./project-text-plan-store-port.ts";
import { ApplicationError } from "./application-error.ts";
const digester: ExtensionContentDigester = {
  sha256: (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`,
};

export function captureProjectTextPlanCommitAuthority(
  input: unknown,
): ProjectTextPlanCommitAuthority {
  const v = fields(input, [
    "version",
    "actor",
    "binding",
    "selection",
    "package",
    "delegation",
    "backgroundAuthorization",
    "assertCurrent",
    "assertTransactionCurrent",
    "assertActive",
    ...(input !== null &&
    typeof input === "object" &&
    Object.hasOwn(input, "prepareModelSelection")
      ? ["prepareModelSelection"]
      : []),
  ]);
  if (
    v.version !== "crewon.project-text-plan-commit.v1" ||
    (v.backgroundAuthorization !== "available" &&
      v.backgroundAuthorization !== "unavailable")
  )
    denied();
  const actor = validateCreativeProjectActor(v.actor),
    binding = parseProjectConversationBinding(v.binding, digester),
    selection = parsePluginSelection(v.selection),
    pkg = parseInstalledPluginPackage(v.package),
    delegation =
      v.delegation === null
        ? null
        : parseProjectTextPlanDelegation(v.delegation),
    pin = binding.currentInstallation;
  if (
    binding.state !== "active" ||
    extensionCanonicalJson(actor) !== extensionCanonicalJson(binding.owner) ||
    selection.state !== "enabled" ||
    selection.revision !== pin.selectionRevision ||
    selection.selectedPackageDigest !== pin.packageDigest ||
    pkg.packageDigest !== pin.packageDigest ||
    pkg.version !== pin.version
  )
    denied();
  for (const key of [
    "tenantId",
    "spaceId",
    "profileId",
    "pluginId",
    "publisherId",
  ] as const)
    if (selection[key] !== pin[key] || pkg[key] !== pin[key]) denied();
  const current = method(v.assertCurrent),
    transaction = method(v.assertTransactionCurrent),
    active = method(v.assertActive);
  return Object.freeze({
    version: v.version,
    actor,
    binding,
    selection,
    package: pkg,
    delegation,
    backgroundAuthorization: v.backgroundAuthorization,
    ...(Object.hasOwn(v, "prepareModelSelection")
      ? {
          prepareModelSelection: method(v.prepareModelSelection).bind(
            input,
          ) as NonNullable<
            ProjectTextPlanCommitAuthority["prepareModelSelection"]
          >,
        }
      : {}),
    assertCurrent: async () => {
      if ((await current.call(input)) !== undefined) denied();
    },
    assertTransactionCurrent: async () => {
      if ((await transaction.call(input)) !== undefined) denied();
    },
    assertActive: () => {
      if (active.call(input) !== undefined) denied();
    },
  });
}
export function captureProjectTextPlanTurnCommitAuthority(
  input: unknown,
): ProjectTextPlanTurnCommitAuthority {
  const v = fields(input, [
    "version",
    "plan",
    "planRevision",
    "step",
    "authority",
  ]);
  if (v.version !== "crewon.project-text-plan-turn-commit.v1") denied();
  const plan = parseProjectTextPlan(v.plan, digester),
    planRevision = parseProjectTextPlanRevision(v.planRevision, digester),
    step = parseProjectTextPlanStep(v.step, digester),
    authority = captureProjectTextPlanCommitAuthority(v.authority);
  assertScope(plan, planRevision, step, authority);
  if (
    plan.state !== "ready" ||
    plan.activeStepId !== step.stepId ||
    step.state !== "ready" ||
    step.run !== null
  )
    denied();
  return Object.freeze({
    version: v.version,
    plan,
    planRevision,
    step,
    authority,
  });
}
export function captureProjectTextPlanSelectionCommitAuthority(
  input: unknown,
): ProjectTextPlanSelectionCommitAuthority {
  const v = fields(input, [
    "version",
    "plan",
    "planRevision",
    "step",
    "admission",
    "result",
    "input",
    "authority",
    "assertCurrent",
  ]);
  if (v.version !== "crewon.project-text-plan-selection-commit.v1") denied();
  const plan = parseProjectTextPlan(v.plan, digester),
    planRevision = parseProjectTextPlanRevision(v.planRevision, digester),
    step = parseProjectTextPlanStep(v.step, digester),
    authority = captureProjectTextPlanCommitAuthority(v.authority),
    admission = parseProjectTextPlanRunAdmission(v.admission, digester),
    result = parseProjectTextPlanResultReference(v.result);
  assertScope(plan, planRevision, step, authority);
  const request = fields(v.input, [
      "projectId",
      "artifactId",
      "contentRevision",
      "expectedArtifactRevision",
      "idempotencyKey",
    ]),
    capturedInput = Object.freeze({
      projectId: projectTextOpaqueId(request.projectId),
      artifactId: projectTextOpaqueId(request.artifactId),
      contentRevision: creativeProjectRevision(request.contentRevision),
      expectedArtifactRevision: creativeProjectRevision(
        request.expectedArtifactRevision,
      ),
      idempotencyKey: projectTextOpaqueId(request.idempotencyKey),
    });
  if (
    planRevision.adoption !== "whenUnchanged" ||
    plan.state !== "waitingSelection" ||
    plan.activeStepId !== step.stepId ||
    step.state !== "waitingSelection" ||
    step.terminal?.status !== "completed" ||
    step.result === null ||
    extensionCanonicalJson(step.result) !== extensionCanonicalJson(result) ||
    step.run?.planAdmissionDigest !== admission.contentDigest ||
    admission.planRevisionDigest !== planRevision.contentDigest ||
    admission.stepId !== step.stepId ||
    result.kind === "brief" ||
    capturedInput.projectId !== plan.projectId ||
    capturedInput.artifactId !== result.artifactId ||
    capturedInput.contentRevision !== result.contentRevision ||
    capturedInput.expectedArtifactRevision !== result.artifactRevision
  )
    denied();
  const current = method(v.assertCurrent);
  return Object.freeze({
    version: v.version,
    plan,
    planRevision,
    step,
    admission,
    result,
    input: capturedInput,
    authority,
    assertCurrent: async () => {
      if ((await current.call(input)) !== undefined) denied();
    },
  });
}
function assertScope(
  plan: ProjectTextPlanTurnCommitAuthority["plan"],
  definition: ProjectTextPlanTurnCommitAuthority["planRevision"],
  step: ProjectTextPlanTurnCommitAuthority["step"],
  authority: ProjectTextPlanCommitAuthority,
): void {
  if (
    plan.planId !== definition.planId ||
    step.planId !== plan.planId ||
    step.planRevision !== plan.currentPlanRevision ||
    definition.planRevision !== plan.currentPlanRevision ||
    plan.bindingId !== authority.binding.bindingId ||
    definition.bindingRevision !== authority.binding.revision ||
    extensionCanonicalJson(plan.owner) !==
      extensionCanonicalJson(authority.actor) ||
    extensionCanonicalJson(definition.installation) !==
      extensionCanonicalJson(authority.binding.currentInstallation) ||
    plan.threadId !== authority.binding.threadId ||
    plan.projectId !== authority.binding.projectId ||
    plan.workspaceId !== authority.binding.workspaceId
  )
    denied();
}
function fields(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    denied();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length) denied();
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const d = descriptors[key];
    if (!d?.enumerable || !Object.hasOwn(d, "value")) denied();
    output[key] = d.value;
  }
  return output;
}
function method(input: unknown): (...args: never[]) => unknown {
  if (typeof input !== "function") denied();
  return input as (...args: never[]) => unknown;
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "project_text_plan_authority_invalid",
  );
}
