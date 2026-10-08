import { ContractValidationError } from "./contract-validation-error.ts";
import { creativeControlText } from "./creative-project-control-support.ts";
import type { ProjectSourceUploadFormat } from "./project-source-uploads-service.ts";

export class ProjectSourceUploadContractError extends ContractValidationError {
  constructor() {
    super("project_source_upload_contract_invalid");
    this.name = "ProjectSourceUploadContractError";
  }
}
export function uploadContractFail(): never {
  throw new ProjectSourceUploadContractError();
}
export function uploadContractChecked<T>(run: () => T): T {
  try {
    return run();
  } catch {
    return uploadContractFail();
  }
}
export function uploadContractNumber(
  input: unknown,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < minimum ||
    input > maximum
  )
    uploadContractFail();
  return input;
}
export function uploadContractEnum<const T extends readonly string[]>(
  input: unknown,
  values: T,
): T[number] {
  if (!values.some((value) => value === input)) uploadContractFail();
  return input as T[number];
}
export function uploadContractFileName(
  input: unknown,
  format: ProjectSourceUploadFormat,
): string {
  const name = creativeControlText(input, 510);
  if (
    name.trim() !== name ||
    /[\u0000-\u001f\u007f/\\]/u.test(name) ||
    [...name].length > 255 ||
    new TextEncoder().encode(name).byteLength > 1024 ||
    !{ txt: /\.txt$/iu, md: /\.(?:md|markdown)$/iu, html: /\.html?$/iu }[
      format
    ].test(name)
  )
    uploadContractFail();
  return name;
}
