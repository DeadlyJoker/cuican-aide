import {
  parseSkillVersion,
  renderSkillInvocationContext,
  resolveAutomationSkillInvocation,
  resolveAutomationParameters,
  skillJson,
  SkillError,
  type AutomationDefinition,
  type AutomationSkillBinding,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { CreateAutomationCommand } from "./automation-store-port.ts";
import type { RunRoute } from "./run-commands.ts";
import type { SkillInvocationPort } from "./skill-invocation-port.ts";

type Dependencies = { skills?: SkillInvocationPort; digester: ContentDigester };

export async function prepareAutomationSkillBinding(
  deps: Dependencies,
  actor: ActorContext,
  command: CreateAutomationCommand,
  route: RunRoute,
): Promise<AutomationSkillBinding | undefined> {
  const template = command.skillInvocation;
  if (template === undefined) return undefined;
  assertTargetScope(actor, command.threadId, template.deliveryTarget);
  return mapErrors(async () => {
    const port = requirePort(deps.skills);
    const invocation = {
      ...template,
      parameters: resolveAutomationParameters(
        template.parameters,
        command.parameterBindings ?? {},
        command.schedule.nextRunAt,
        command.schedule.timezone,
      ),
    };
    const admission = await port.admitInvocation(actor, invocation, {
      purpose: "schedule",
      route,
    });
    const version = parseSkillVersion(admission.version, deps.digester);
    const context = renderSkillInvocationContext(version, invocation);
    if (
      admission.agentVersionId !== route.agentVersionId ||
      skillJson(admission.invocation) !== skillJson(invocation) ||
      admission.context !== context
    ) {
      throw new ApplicationError(
        "internal",
        "automation_skill_admission_invalid",
      );
    }
    return {
      schemaVersion: "crewon.automation-skill-binding.v1",
      invocation: structuredClone(template),
      version,
      parameterBindings: structuredClone(command.parameterBindings ?? {}),
    };
  });
}

export async function assertAutomationSkillExecution(
  deps: Dependencies,
  actor: ActorContext,
  definition: AutomationDefinition,
  route: RunRoute,
  scheduledFor: string,
): Promise<void> {
  const binding = definition.skillBinding;
  if (!binding) return;
  assertTargetScope(
    actor,
    definition.threadId,
    binding.invocation.deliveryTarget,
  );
  await mapErrors(async () => {
    const port = requirePort(deps.skills);
    parseSkillVersion(binding.version, deps.digester);
    const invocation = resolveAutomationSkillInvocation(
      binding,
      scheduledFor,
      definition.schedule.timezone,
    );
    const admission = await port.admitInvocation(actor, invocation, {
      purpose: "execute",
      route,
    });
    const version = parseSkillVersion(admission.version, deps.digester);
    if (
      skillJson(version) !== skillJson(binding.version) ||
      skillJson(admission.invocation) !== skillJson(invocation) ||
      admission.context !==
        renderSkillInvocationContext(binding.version, invocation) ||
      admission.agentVersionId !== route.agentVersionId
    ) {
      throw new ApplicationError(
        "conflict",
        "automation_skill_snapshot_mismatch",
      );
    }
  });
}
function requirePort(port?: SkillInvocationPort): SkillInvocationPort {
  if (!port)
    throw new ApplicationError("conflict", "automation_skill_unavailable");
  return port;
}
async function mapErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    if (
      error instanceof Error &&
      [
        "automation_parameter_bindings_invalid",
        "automation_timezone_invalid",
        "automation_scheduled_for_invalid",
      ].includes(error.message)
    )
      throw new ApplicationError("validation", error.message, { cause: error });
    if (error instanceof SkillError)
      throw new ApplicationError("conflict", error.code, { cause: error });
    throw new ApplicationError(
      "internal",
      "automation_skill_admission_failed",
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

function assertTargetScope(
  actor: ActorContext,
  threadId: string,
  target: import("@crewon/domain").DeliveryTargetRef | undefined,
): void {
  if (
    target &&
    (target.tenantId !== actor.tenantId ||
      target.spaceId !== actor.spaceId ||
      target.threadId !== threadId)
  ) {
    throw new ApplicationError(
      "authorization",
      "automation_delivery_target_mismatch",
    );
  }
}
