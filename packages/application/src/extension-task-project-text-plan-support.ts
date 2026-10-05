import {
  createProjectTextPlanRunAdmission,
  parseProjectTextPlanRunAdmission,
  assertProjectTextPlanRunSources,
  extensionCanonicalJson,
  type ExtensionRunBinding,
  type ProjectStageRunAdmission,
  type ProjectTextPlanRunAdmission,
} from "@crewon/domain";
import type { ProjectTextPlanTurnCommitAuthority } from "./project-text-plan-store-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { CommitExtensionTurnResult } from "./extension-store-port.ts";
import { ApplicationError } from "./application-error.ts";
import { captureProjectTextPlanTurnCommitAuthority } from "./project-text-plan-authority.ts";
import { createProjectConversationTurnFromHost } from "./project-conversation-task-support.ts";

/** Keeps the existing TaskCore as the sole Run writer after independent plan qualification. */
export async function commitProjectTextPlanTurnFromHost(
  input: Omit<
    Parameters<typeof createProjectConversationTurnFromHost>[0],
    "create"
  > & {
    planAuthority: ProjectTextPlanTurnCommitAuthority;
    create: (
      task: Parameters<
        Parameters<typeof createProjectConversationTurnFromHost>[0]["create"]
      >[0],
      onStage: (stage: ProjectStageRunAdmission) => void,
      authority: ProjectTextPlanTurnCommitAuthority,
    ) => Promise<CommitExtensionTurnResult>;
  },
) {
  const q = captureProjectTextPlanTurnCommitAuthority(input.planAuthority);
  if (
    input.extensions.projectTextPlanAdmissionVersion !==
    "crewon.project-text-plan-run-admission.v1"
  )
    throw new ApplicationError(
      "conflict",
      "project_text_plan_admission_unavailable",
    );
  const result = await createProjectConversationTurnFromHost({
    actor: input.actor,
    command: input.command,
    task: input.task,
    extensions: input.extensions,
    digester: input.digester,
    create: (captured, onStage) => input.create(captured, onStage, q),
  });
  return {
    ...result,
    planAdmission: assertSavedProjectTextPlanTask(
      q,
      result.result,
      input.digester,
    ),
  };
}

export function projectTextPlanTaskAdmission(
  q: ProjectTextPlanTurnCommitAuthority,
  stage: ProjectStageRunAdmission,
  binding: ExtensionRunBinding,
  taskIdempotencyKey: string,
  at: string,
  digester: ContentDigester,
): ProjectTextPlanRunAdmission {
  const d = q.planRevision,
    s = q.step,
    baseline =
      d.baselines.find(
        (x) => x.kind === s.kind && x.episodeId === s.episodeId,
      ) ?? null;
  if (
    binding.configurationRevision !== d.configurationRevision ||
    binding.configurationDigest !== d.configurationDigest ||
    extensionCanonicalJson(binding.target) !== extensionCanonicalJson(d.target)
  )
    throw new ApplicationError(
      "conflict",
      "project_text_plan_configuration_changed",
    );
  const record = createProjectTextPlanRunAdmission(
    {
      planId: d.planId,
      planRevision: d.planRevision,
      planRevisionDigest: d.contentDigest,
      stepId: s.stepId,
      stepRevision: s.revision,
      attempt: s.attempt,
      actor: d.actor,
      installation: d.installation,
      projectId: d.projectId,
      threadId: d.threadId,
      bindingId: d.bindingId,
      bindingRevision: d.bindingRevision,
      workspaceId: d.workspaceId,
      configurationRevision: d.configurationRevision,
      configurationDigest: d.configurationDigest,
      runId: stage.runId,
      stageAdmissionDigest: stage.contentDigest,
      extensionBindingDigest: binding.bindingDigest,
      delegationDigest: digester.sha256(extensionCanonicalJson(d.delegation)),
      inputDigest: stage.userContentDigest,
      idempotencyKey: stage.idempotencyKey,
      taskIdempotencyKey,
      kind: s.kind,
      episodeId: s.episodeId,
      expectedEpisodeIds: s.kind === "outline" ? d.episodeIds : [],
      sources: stage.sources,
      baseline,
      createdAt: at,
    },
    digester,
  );
  assertProjectTextPlanRunSources(d, s, record, stage, digester);
  return record;
}
export function assertSavedProjectTextPlanTask(
  q: ProjectTextPlanTurnCommitAuthority,
  result: CommitExtensionTurnResult,
  digester: ContentDigester,
): ProjectTextPlanRunAdmission {
  if (result.projectTextPlanAdmission === undefined) denied();
  const record = parseProjectTextPlanRunAdmission(
    result.projectTextPlanAdmission,
    digester,
  );
  if (
    record.planId !== q.plan.planId ||
    record.planRevision !== q.planRevision.planRevision ||
    record.planRevisionDigest !== q.planRevision.contentDigest ||
    record.stepId !== q.step.stepId ||
    record.attempt !== q.step.attempt ||
    record.runId !== result.binding.runId ||
    record.extensionBindingDigest !== result.binding.bindingDigest
  )
    denied();
  return record;
}
function denied(): never {
  throw new ApplicationError("authorization", "project_text_plan_task_invalid");
}
