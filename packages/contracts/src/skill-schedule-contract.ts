import type { components } from "./generated/control-api.ts";
import { ContractValidationError } from "./contract-validation-error.ts";

/** Transport validation only. C02 owns declared parameter schemas and admission. */
export type SkillInvocationSpec = components["schemas"]["SkillInvocationSpec"];
export type AutomationParameterBindings =
  components["schemas"]["AutomationParameterBindings"];

export function parseSkillInvocationSpec(input: unknown): SkillInvocationSpec {
  const value = object(input);
  exact(value, [
    "schemaVersion",
    "skill",
    "parameters",
    "requiredToolRefs",
    ...(value.deliveryTarget === undefined ? [] : ["deliveryTarget"]),
  ]);
  if (value.schemaVersion !== "crewon.skill-invocation.v1") invalid();
  const ref = object(value.skill);
  exact(ref, ["skillId", "versionId", "contentDigest"]);
  for (const id of [ref.skillId, ref.versionId]) {
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id) ||
      id.toLowerCase() === "latest"
    )
      invalid();
  }
  if (
    typeof ref.contentDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(ref.contentDigest)
  )
    invalid();
  const parameters = object(value.parameters);
  if (
    Object.keys(parameters).length > 24 ||
    bytes(JSON.stringify(parameters)) > 4096
  )
    invalid();
  for (const [key, parameter] of Object.entries(parameters)) {
    if (["constructor", "prototype", "__proto__"].includes(key)) invalid();
    if (typeof parameter === "string") {
      if (bytes(parameter) > 2048) invalid();
    } else if (
      typeof parameter !== "boolean" &&
      !(typeof parameter === "number" && Number.isFinite(parameter))
    )
      invalid();
  }
  if (
    !Array.isArray(value.requiredToolRefs) ||
    value.requiredToolRefs.length > 24 ||
    new Set(value.requiredToolRefs).size !== value.requiredToolRefs.length ||
    value.requiredToolRefs.some(
      (v) => typeof v !== "string" || !v.trim() || bytes(v) > 256,
    )
  )
    invalid();
  if (value.deliveryTarget !== undefined) {
    const target = object(value.deliveryTarget);
    exact(target, [
      "schemaVersion",
      "tenantId",
      "spaceId",
      "threadId",
      "targetId",
    ]);
    if (
      target.schemaVersion !== "crewon.delivery-target.v1" ||
      target.targetId !== "thread-deliveries"
    )
      invalid();
    for (const key of ["tenantId", "spaceId", "threadId"] as const) {
      if (
        typeof target[key] !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(target[key])
      )
        invalid();
    }
  }
  return structuredClone(value) as SkillInvocationSpec;
}

export function parseAutomationParameterBindings(
  input: unknown,
): AutomationParameterBindings {
  const value = object(input);
  if (
    Object.keys(value).length > 24 ||
    Object.entries(value).some(
      ([key, rule]) =>
        !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key) ||
        ["constructor", "prototype", "__proto__"].includes(key) ||
        !["runDate", "previousWeekStart", "previousWeekEnd"].includes(
          rule as string,
        ),
    )
  )
    invalid();
  return structuredClone(value) as AutomationParameterBindings;
}
function object(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join() !== keys.sort().join()) invalid();
}
function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
function invalid(): never {
  throw new ContractValidationError("automation_skill_binding_invalid");
}
