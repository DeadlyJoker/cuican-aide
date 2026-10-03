import type { components } from "./generated/control-api.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import {
  creativeControlId,
  creativeControlRecord,
  creativeControlRevision,
  creativeControlText,
  creativeControlTimestamp,
} from "./creative-project-control-support.ts";
import {
  parseConceptGenerationLocator,
  type ConceptGenerationLocator,
} from "./project-generation-read-contract.ts";
import {
  parseProjectGenerationUiReference,
  type ProjectGenerationUiReference,
} from "./project-generation-ui-action-contract.ts";
import { parsePluginUiJsonValue } from "./plugin-ui-json.ts";

export const MAX_PROJECT_GENERATION_SELECTION_BYTES = 24 * 1024;
export type ConceptSelectionLocator = Readonly<{
  projectId: string;
  assetId: string;
}>;
export type SelectConceptImageRequest = Readonly<
  Omit<components["schemas"]["SelectConceptImageRequest"], "reference"> & {
    reference: ProjectGenerationUiReference;
  }
>;
export type PublicConceptImageSelection = Readonly<
  Omit<components["schemas"]["PublicConceptImageSelection"], "reference"> & {
    reference: ConceptGenerationLocator;
  }
>;
export type GetConceptSelectionResponse = Readonly<{
  selectionRevision: number;
  current:
    | (PublicConceptImageSelection &
        Readonly<{ requiresConfirmation: boolean }>)
    | null;
}>;
export type SelectConceptImageResponse = Readonly<{
  disposition: "committed" | "replayed";
  selectionRevision: number;
  selection: PublicConceptImageSelection;
}>;

function fail(): never {
  throw new ContractValidationError(
    "project_generation_selection_contract_invalid",
  );
}
function copy(input: unknown): unknown {
  try {
    return parsePluginUiJsonValue(input, {
      maxBytes: MAX_PROJECT_GENERATION_SELECTION_BYTES,
    });
  } catch {
    return fail();
  }
}
function operationId(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(input)
  )
    fail();
  return input;
}
function resultIndex(input: unknown): number {
  const value = creativeControlRevision(input, 0);
  if (value > 15) fail();
  return value;
}
function imageUrl(input: unknown): string {
  const value = creativeControlText(input, 2048);
  if (
    new TextEncoder().encode(value).byteLength > 2048 ||
    /[\u0000-\u0020\u007f]/u.test(value)
  )
    fail();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    value.includes("#") ||
    url.href !== value
  )
    fail();
  return value;
}
function filename(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 1024 ||
    /[\u0000-\u001f\u007f]/u.test(input)
  )
    fail();
  // copy() has already checked Unicode scalars. A provider's display filename
  // is not a user-entered title; preserve all valid nonempty names verbatim.
  return input;
}
function selection(
  input: unknown,
  requiresConfirmation: false,
): PublicConceptImageSelection;
function selection(
  input: unknown,
  requiresConfirmation: true,
): PublicConceptImageSelection & Readonly<{ requiresConfirmation: boolean }>;
function selection(
  input: unknown,
  requiresConfirmation: boolean,
):
  | PublicConceptImageSelection
  | (PublicConceptImageSelection &
      Readonly<{ requiresConfirmation: boolean }>) {
  const fields = [
    "reference",
    "operationId",
    "operationRevision",
    "resultIndex",
    "filename",
    "url",
    "selectedAt",
  ];
  const value = creativeControlRecord(
    input,
    requiresConfirmation ? [...fields, "requiresConfirmation"] : fields,
  );
  const parsed = {
    reference: parseConceptGenerationLocator(value.reference),
    operationId: operationId(value.operationId),
    operationRevision: creativeControlRevision(value.operationRevision),
    resultIndex: resultIndex(value.resultIndex),
    filename: filename(value.filename),
    url: imageUrl(value.url),
    selectedAt: creativeControlTimestamp(value.selectedAt),
  };
  if (!requiresConfirmation) return Object.freeze(parsed);
  if (typeof value.requiresConfirmation !== "boolean") fail();
  return Object.freeze({
    ...parsed,
    requiresConfirmation: value.requiresConfirmation,
  });
}
function assertLocator(
  value: ConceptGenerationLocator,
  expected: ConceptSelectionLocator,
): void {
  if (
    value.projectId !== expected.projectId ||
    value.assetId !== expected.assetId
  )
    fail();
}

export function parseConceptSelectionLocator(
  input: unknown,
): ConceptSelectionLocator {
  const value = creativeControlRecord(copy(input), ["projectId", "assetId"]);
  return Object.freeze({
    projectId: creativeControlId(value.projectId),
    assetId: creativeControlId(value.assetId),
  });
}

/** No URL, supplier identity, Run, configuration, account or price can be supplied. */
export function parseSelectConceptImageRequest(
  input: unknown,
): SelectConceptImageRequest {
  const value = creativeControlRecord(copy(input), [
    "reference",
    "operationId",
    "expectedOperationRevision",
    "resultIndex",
    "expectedSelectionRevision",
  ]);
  const expectedSelectionRevision = creativeControlRevision(
    value.expectedSelectionRevision,
    0,
  );
  if (expectedSelectionRevision === Number.MAX_SAFE_INTEGER) fail();
  return Object.freeze({
    reference: parseProjectGenerationUiReference(value.reference),
    operationId: operationId(value.operationId),
    expectedOperationRevision: creativeControlRevision(
      value.expectedOperationRevision,
    ),
    resultIndex: resultIndex(value.resultIndex),
    expectedSelectionRevision,
  });
}

/** A missing schema/capability is an error; revision zero represents an actual empty pointer. */
export function parseGetConceptSelectionResponse(
  input: unknown,
  expected?: ConceptSelectionLocator,
): GetConceptSelectionResponse {
  const locator =
    expected === undefined ? undefined : parseConceptSelectionLocator(expected);
  const value = creativeControlRecord(copy(input), [
    "selectionRevision",
    "current",
  ]);
  const selectionRevision = creativeControlRevision(value.selectionRevision, 0);
  if (value.current === null) {
    if (selectionRevision !== 0) fail();
    return Object.freeze({ selectionRevision, current: null });
  }
  if (selectionRevision === 0) fail();
  const current = selection(value.current, true);
  if (locator) assertLocator(current.reference, locator);
  return Object.freeze({ selectionRevision, current });
}

/** A replay is the immutable command receipt, independent of the current pointer. */
export function parseSelectConceptImageResponse(
  input: unknown,
  expected?: SelectConceptImageRequest,
): SelectConceptImageResponse {
  const request =
    expected === undefined
      ? undefined
      : parseSelectConceptImageRequest(expected);
  const value = creativeControlRecord(copy(input), [
    "disposition",
    "selectionRevision",
    "selection",
  ]);
  if (value.disposition !== "committed" && value.disposition !== "replayed")
    fail();
  const selectionRevision = creativeControlRevision(value.selectionRevision);
  const selected = selection(value.selection, false);
  if (request) {
    assertLocator(selected.reference, request.reference);
    if (
      selected.reference.assetRevision !== request.reference.assetRevision ||
      selected.operationId !== request.operationId ||
      selected.operationRevision !== request.expectedOperationRevision ||
      selected.resultIndex !== request.resultIndex ||
      selectionRevision !== request.expectedSelectionRevision + 1
    )
      fail();
  }
  return Object.freeze({
    disposition: value.disposition,
    selectionRevision,
    selection: selected,
  });
}
