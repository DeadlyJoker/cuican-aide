import {
  parseSkillInvocationSpec,
  parseSkillVersionSnapshot,
  renderSkillInvocationContext,
  validateSkillInvocation,
  skillJson,
  type SkillInvocationSpec,
  type SkillVersion,
} from "./demonstrated-skill.ts";
import {
  parseAutomationParameterBindings,
  resolveAutomationParameters,
  type AutomationParameterBindings,
} from "./automation-parameter-bindings.ts";

export type AutomationSkillBinding = Readonly<{
  schemaVersion: "crewon.automation-skill-binding.v1";
  invocation: SkillInvocationSpec;
  version: SkillVersion;
  parameterBindings: AutomationParameterBindings;
}>;

export function parseAutomationSkillBinding(
  value: unknown,
): AutomationSkillBinding {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !==
      ["invocation", "parameterBindings", "schemaVersion", "version"].join()
  ) {
    throw new Error("automation_skill_binding_invalid");
  }
  const input = value as AutomationSkillBinding;
  if (input.schemaVersion !== "crewon.automation-skill-binding.v1")
    throw new Error("automation_skill_binding_invalid");
  const version = parseSkillVersionSnapshot(input.version);
  const invocation = parseSkillInvocationSpec(input.invocation);
  const parameterBindings = parseAutomationParameterBindings(
    input.parameterBindings,
  );
  if (skillJson(version.ref) !== skillJson(invocation.skill))
    throw new Error("automation_skill_snapshot_mismatch");
  for (const name of Object.keys(parameterBindings)) {
    const field = version.method.parameters.find((p) => p.name === name);
    if (!field || field.type !== "string" || field.enum !== undefined)
      throw new Error("automation_parameter_bindings_invalid");
  }
  return {
    schemaVersion: input.schemaVersion,
    invocation,
    version,
    parameterBindings,
  };
}

export function resolveAutomationSkillInvocation(
  binding: AutomationSkillBinding,
  scheduledFor: string,
  timezone: string,
): SkillInvocationSpec {
  const parameters = resolveAutomationParameters(
    binding.invocation.parameters,
    binding.parameterBindings,
    scheduledFor,
    timezone,
  );
  return validateSkillInvocation(binding.version.method, {
    ...binding.invocation,
    parameters,
  });
}

export function renderAutomationSkillContext(
  binding: AutomationSkillBinding,
  scheduledFor: string,
  timezone: string,
): string {
  return renderSkillInvocationContext(
    binding.version,
    resolveAutomationSkillInvocation(binding, scheduledFor, timezone),
  );
}
