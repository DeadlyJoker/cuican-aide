import type { ProjectPlanningCapability } from "@crewon/contracts/project-planning";
import type { RunState } from "@crewon/domain";
import type { WorkItemClaim } from "./durable-queue-port.ts";
import { ApplicationError } from "./application-error.ts";

export type ProjectPlanningRuntimeRead = Readonly<{
  run: RunState;
  claim: WorkItemClaim;
  signal: AbortSignal;
}>;

/** Current deployment identity and metadata approval only; no project or Node mutation methods. */
export type ProjectPlanningRuntimePort = Readonly<{
  version: "crewon.project-planning-runtime.v1";
  /** Coarse model publication only; never replaces actual actor/principal/PDP checks. */
  canPublish(run: RunState): boolean;
  assertActive(): void;
  assertCurrent(input: ProjectPlanningRuntimeRead): Promise<void>;
  readCapabilities(
    input: ProjectPlanningRuntimeRead,
  ): Promise<readonly ProjectPlanningCapability[]>;
}>;

/** Capture named deployment callbacks once, without evaluating caller getters. */
export function captureProjectPlanningRuntimePort(
  input: ProjectPlanningRuntimePort,
): ProjectPlanningRuntimePort {
  const expected = [
    "version",
    "canPublish",
    "assertActive",
    "assertCurrent",
    "readCapabilities",
  ];
  if (
    input === null ||
    typeof input !== "object" ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== expected.length
  )
    invalid();
  const fields = Object.getOwnPropertyDescriptors(input);
  for (const name of expected)
    if (
      fields[name] === undefined ||
      !("value" in fields[name]!) ||
      !fields[name]!.enumerable
    )
      invalid();
  if (fields.version!.value !== "crewon.project-planning-runtime.v1") invalid();
  for (const name of expected.slice(1))
    if (typeof fields[name]!.value !== "function") invalid();
  return Object.freeze({
    version: "crewon.project-planning-runtime.v1",
    canPublish: fields.canPublish!.value!.bind(input),
    assertActive: fields.assertActive!.value!.bind(input),
    assertCurrent: fields.assertCurrent!.value!.bind(input),
    readCapabilities: fields.readCapabilities!.value!.bind(input),
  });
}

function invalid(): never {
  throw new ApplicationError("validation", "project_planning_runtime_invalid");
}
