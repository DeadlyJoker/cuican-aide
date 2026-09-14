import { ContractValidationError } from "./contract-validation-error.ts";

export const BROWSER_OBSERVE_TOOL_NAME = "crewon_browser_observe" as const;
export const BROWSER_ACT_TOOL_NAME = "crewon_browser_act" as const;
export const BROWSER_ACT_SCOPED_TOOL_NAME =
  "crewon_browser_act_scoped" as const;
export const BROWSER_MAX_OUTPUT_BYTES = 9 * 1024;
export const BROWSER_MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
export const BROWSER_TIMEOUT_MS = 30_000;

export type BrowserObserveInput = Readonly<{ sessionId?: string }>;
export type BrowserTarget =
  | Readonly<{ targetId: string }>
  | Readonly<{ role: string; name: string }>;
type BrowserActionScope = Readonly<{
  sessionId: string;
  generation: number;
  observationId: string;
}>;
export type BrowserActInput = BrowserActionScope &
  (
    | Readonly<{ action: "navigate"; url: string }>
    | Readonly<{ action: "click" | "download"; target: BrowserTarget }>
    | Readonly<{
        action: "fill" | "select";
        target: BrowserTarget;
        value: string;
      }>
  );

/** Model-selected identities are locators; they never grant execution authority. */
export function parseBrowserObserveInput(input: unknown): BrowserObserveInput {
  const value = record(input);
  keys(value, "sessionId" in value ? ["sessionId"] : []);
  if ("sessionId" in value) opaque(value.sessionId);
  return structuredClone(value) as BrowserObserveInput;
}

export function parseBrowserTarget(input: unknown): BrowserTarget {
  const value = record(input);
  if ("targetId" in value) {
    keys(value, ["targetId"]);
    opaque(value.targetId);
  } else {
    keys(value, ["role", "name"]);
    if (
      typeof value.role !== "string" ||
      !/^[a-z][a-z0-9-]{0,31}$/u.test(value.role)
    )
      invalid();
    if (
      typeof value.name !== "string" ||
      value.name.trim().length === 0 ||
      value.name.length > 256 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(value.name)
    )
      invalid();
  }
  return structuredClone(value) as BrowserTarget;
}

export function parseBrowserActInput(input: unknown): BrowserActInput {
  const value = record(input);
  opaque(value.sessionId);
  opaque(value.observationId);
  if (!Number.isSafeInteger(value.generation) || Number(value.generation) < 0)
    invalid();
  const common = ["sessionId", "generation", "observationId", "action"];
  switch (value.action) {
    case "navigate":
      keys(value, [...common, "url"]);
      navigationUrl(value.url);
      break;
    case "click":
    case "download":
      keys(value, [...common, "target"]);
      parseBrowserTarget(value.target);
      break;
    case "fill":
    case "select":
      keys(value, [...common, "target", "value"]);
      parseBrowserTarget(value.target);
      if (
        typeof value.value !== "string" ||
        value.value.length > 512 ||
        value.value.includes("\0")
      )
        invalid();
      break;
    default:
      invalid();
  }
  return structuredClone(value) as BrowserActInput;
}

function navigationUrl(value: unknown): void {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !/^https?:\/\//u.test(value) ||
    /[\s\\\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
    invalid();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalid();
  }
  if (!parsed.hostname || parsed.username || parsed.password) invalid();
}
function record(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid();
  return value as Record<string, unknown>;
}
function keys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(","))
    invalid();
}
function opaque(value: unknown): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  )
    invalid();
}
function invalid(): never {
  throw new ContractValidationError("browser_execution_input_invalid");
}
