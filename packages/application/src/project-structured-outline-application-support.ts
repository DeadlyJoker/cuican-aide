import { ProjectTextError } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type {
  CreativeProjectCommitAuthority,
  CreativeProjectCommitOptions,
} from "./creative-project-store-port.ts";
import { projectTextInvalidStore } from "./project-text-application-support.ts";

export function optionsOf(
  authority: CreativeProjectCommitAuthority | undefined,
): CreativeProjectCommitOptions | undefined {
  return authority === undefined ? undefined : { authority };
}
export function method<T extends object, K extends keyof T>(
  input: T,
  key: K,
): T[K] {
  let current: object | null = input;
  for (
    let depth = 0;
    current !== null && depth < 8;
    depth++, current = Object.getPrototypeOf(current)
  ) {
    const property = Object.getOwnPropertyDescriptor(current, key);
    if (property === undefined) continue;
    if (
      !Object.hasOwn(property, "value") ||
      typeof property.value !== "function"
    )
      break;
    return property.value.bind(input) as T[K];
  }
  throw new ApplicationError(
    "internal",
    "project_outline_dependencies_invalid",
  );
}
export function dataFields(
  input: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (input === null || typeof input !== "object") projectTextInvalidStore();
  const fields: Record<string, unknown> = Object.create(null);
  if (Reflect.ownKeys(input).length !== allowed.length)
    projectTextInvalidStore();
  for (const key of allowed) {
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (
      field === undefined ||
      !Object.hasOwn(field, "value") ||
      !field.enumerable
    )
      projectTextInvalidStore();
    fields[key] = field.value;
  }
  return fields;
}
export async function outlineUseCase<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof ApplicationError) throw cause;
    const code =
      cause instanceof Error
        ? cause instanceof ProjectTextError
          ? cause.code
          : cause.message
        : "";
    if (
      [
        "project_text_revision_conflict",
        "project_text_idempotency_conflict",
        "project_text_locked",
        "project_text_dependencies_stale",
        "project_outline_inputs_stale",
        "project_outline_parameters_mismatch",
        "project_outline_parameters_incomplete",
        "project_outline_quality_failed",
        "project_outline_source_evidence_mismatch",
        "project_outline_base_required",
        "project_outline_base_digest_mismatch",
        "project_outline_item_not_found",
        "project_outline_confirmed_novel_required",
        "creative_project_archived",
      ].includes(code)
    )
      throw new ApplicationError("conflict", code, { cause });
    throw new ApplicationError(
      "internal",
      "project_outline_service_unavailable",
      { cause },
    );
  }
}
