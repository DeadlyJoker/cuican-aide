import { matchesAutomationRunPermissionMode } from "@crewon/domain";
import {
  parseAutomationDefinition,
  parseAutomationInvocationBinding,
  parseSkillVersion,
  renderAutomationInstruction,
  type SkillInvocationSpec,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { AutomationStore } from "./automation-store-port.ts";
import type { RunStore } from "./run-store-port.ts";
import { canonicalJson } from "./canonical-json.ts";

export type AutomationRunSkillInvocation = Readonly<{
  tenantId: string;
  spaceId: string;
  threadId: string;
  runId: string;
  agentVersionId: string;
  automationId: string;
  invocationId: string;
  scheduledFor: string;
  invocation: SkillInvocationSpec;
}>;

/** Resolve only persisted Run origin + immutable Automation authority. This grants no permission. */
export async function resolveAutomationSkillForRun(
  dependencies: {
    store: AutomationStore & Pick<RunStore, "loadRun">;
    digester: ContentDigester;
  },
  actor: ActorContext,
  runId: string,
): Promise<AutomationRunSkillInvocation | null> {
  const run = await dependencies.store.loadRun({
    tenantId: actor.tenantId,
    runId,
  });
  if (!run || run.tenantId !== actor.tenantId || run.spaceId !== actor.spaceId)
    throw new ApplicationError("notFound", "run_not_found");
  if (run.origin?.kind !== "automation") return null;
  const binding = parseAutomationInvocationBinding(run.origin.binding);
  const record = await dependencies.store.loadAutomation({
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    automationId: binding.automationId,
  });
  if (!record) throw new ApplicationError("notFound", "automation_not_found");
  const definition = parseAutomationDefinition(record.definition);
  if (
    !matchesAutomationRunPermissionMode(definition, run.toolPermissionMode) ||
    definition.tenantId !== actor.tenantId ||
    definition.spaceId !== actor.spaceId ||
    definition.threadId !== run.threadId ||
    definition.agentVersionId !== run.agentVersionId ||
    binding.runId !== runId ||
    binding.automationRevision !== definition.revision ||
    record.definitionDigest !== binding.definitionDigest ||
    dependencies.digester.sha256(canonicalJson(definition)) !==
      record.definitionDigest ||
    binding.routeDigest !==
      dependencies.digester.sha256(
        canonicalJson({
          authorityId: run.authorityId,
          runtimeGeneration: run.runtimeGeneration,
          agentVersionId: run.agentVersionId,
          policySnapshotId: run.policySnapshotId,
          workspaceBindingId: run.workspaceBindingId,
        }),
      )
  ) {
    throw new ApplicationError("internal", "automation_run_binding_invalid");
  }
  if (!definition.skillBinding) return null;
  if (!binding.scheduledFor || !binding.skillInvocation)
    throw new ApplicationError("internal", "automation_scheduled_for_required");
  parseSkillVersion(definition.skillBinding.version, dependencies.digester);
  if (
    binding.instructionDigest !==
    dependencies.digester.sha256(
      renderAutomationInstruction(
        definition,
        binding.scheduledFor,
        binding.skillInvocation,
      ),
    )
  )
    throw new ApplicationError("internal", "automation_run_binding_invalid");
  return {
    tenantId: definition.tenantId,
    spaceId: definition.spaceId,
    threadId: definition.threadId,
    runId,
    agentVersionId: definition.agentVersionId,
    automationId: definition.automationId,
    invocationId: binding.invocationId,
    scheduledFor: binding.scheduledFor,
    invocation: structuredClone(binding.skillInvocation),
  };
}
