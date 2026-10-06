import { extensionCanonicalJson } from "@crewon/domain";
import type {
  ProjectMaterialPreparationCommitAuthority,
  ProjectMaterialPreparationRequest,
} from "./project-material-preparation-port.ts";
import {
  materialPreparationFields,
  parseProjectMaterialPreparationRequest,
} from "./project-material-preparation-record.ts";

export function captureProjectMaterialPreparationAuthority(
  input: unknown,
  request: ProjectMaterialPreparationRequest,
): ProjectMaterialPreparationCommitAuthority {
  const a = materialPreparationFields(input, [
    "version",
    "request",
    "assertCurrent",
    "assertTransactionCurrent",
    "assertActive",
  ]);
  if (
    a.version !== "crewon.project-material-preparation-commit.v1" ||
    extensionCanonicalJson(
      parseProjectMaterialPreparationRequest(a.request),
    ) !== extensionCanonicalJson(request) ||
    typeof a.assertCurrent !== "function" ||
    typeof a.assertTransactionCurrent !== "function" ||
    typeof a.assertActive !== "function"
  )
    invalid();
  return Object.freeze({
    version: "crewon.project-material-preparation-commit.v1",
    request,
    assertCurrent: a.assertCurrent.bind(input),
    assertTransactionCurrent: a.assertTransactionCurrent.bind(input),
    assertActive: a.assertActive.bind(input),
  });
}
export function assertProjectMaterialPreparationActive(
  a: ProjectMaterialPreparationCommitAuthority,
): void {
  const value: unknown = a.assertActive();
  if (value === undefined) return;
  try {
    void Promise.prototype.then.call(
      value,
      () => undefined,
      () => undefined,
    );
  } catch {
    /* Never invoke an arbitrary thenable. */
  }
  invalid();
}
export async function assertProjectMaterialPreparationCurrent(
  a: ProjectMaterialPreparationCommitAuthority,
  phase: "before" | "transaction",
): Promise<void> {
  if (
    (await (phase === "before"
      ? a.assertCurrent()
      : a.assertTransactionCurrent())) !== undefined
  )
    invalid();
  assertProjectMaterialPreparationActive(a);
}
function invalid(): never {
  throw new Error("project_material_preparation_authority_invalid");
}
