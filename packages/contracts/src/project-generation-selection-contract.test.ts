import assert from "node:assert/strict";
import { test } from "node:test";
import { ContractValidationError } from "./contract-validation-error.ts";
import {
  parseGetConceptSelectionResponse,
  parseSelectConceptImageRequest,
  parseSelectConceptImageResponse,
} from "./project-generation-selection-contract.ts";
import {
  parseProjectGenerationSelectionUiActionRequest,
  parseProjectGenerationSelectionUiActionResponse,
  PROJECT_GENERATION_SELECTION_UI_ACTIONS,
} from "./project-generation-selection-ui-action-contract.ts";

const reference = {
  projectId: "project",
  assetId: "concept",
  assetRevision: 2,
  expectedProjectRevision: 7,
  expectedAssetMetadataRevision: 4,
};
const request = {
  reference,
  operationId: "11111111-1111-1111-1111-111111111111",
  expectedOperationRevision: 3,
  resultIndex: 2,
  expectedSelectionRevision: 0,
};
const selected = {
  reference: { projectId: "project", assetId: "concept", assetRevision: 2 },
  operationId: request.operationId,
  operationRevision: 3,
  resultIndex: 2,
  filename: "second.png",
  url: "https://provider.test/view?file=second.png",
  selectedAt: "2026-10-04T00:00:00.000Z",
};
const receipt = {
  disposition: "committed",
  selectionRevision: 1,
  selection: selected,
};
const invalid = (callback: () => unknown) =>
  assert.throws(callback, ContractValidationError);

test("exact raw image index, independent CAS and historical input survive detached parsing", () => {
  const input = structuredClone(request);
  const checked = parseSelectConceptImageRequest(input);
  input.reference.assetRevision = 99;
  assert.equal(checked.reference.assetRevision, 2);
  assert.equal(checked.resultIndex, 2);
  assert.ok(Object.isFrozen(checked.reference));
  assert.deepEqual(parseSelectConceptImageResponse(receipt, request), receipt);
});

test("verified provider display names survive publication without title normalization", () => {
  for (const filename of [" ", "　", "画面😀.png", "provider/path/image.png"])
    assert.equal(
      parseSelectConceptImageResponse(
        { ...receipt, selection: { ...selected, filename } },
        request,
      ).selection.filename,
      filename,
    );
  for (const filename of ["", "x\n.png", "\ud800", "\udfff", "x".repeat(1025)])
    invalid(() =>
      parseSelectConceptImageResponse({
        ...receipt,
        selection: { ...selected, filename },
      }),
    );
});

test("public image URLs preserve the canonical URL verified before commit", () => {
  const url = "https://provider.test/%E7%94%BB%E9%9D%A2.png";
  assert.equal(
    parseSelectConceptImageResponse({
      ...receipt,
      selection: { ...selected, url },
    }).selection.url,
    url,
  );
  for (const url of [
    "https://provider.test/画面.png",
    "HTTPS://provider.test/image.png",
    "https://provider.test:443/image.png",
    "https://provider.test/\ud800",
  ])
    invalid(() =>
      parseSelectConceptImageResponse({
        ...receipt,
        selection: { ...selected, url },
      }),
    );
});

test("UI read and write stay separate from generation and query protocols", () => {
  const read = parseProjectGenerationSelectionUiActionRequest({
    action: PROJECT_GENERATION_SELECTION_UI_ACTIONS[0],
    input: { projectId: "project", assetId: "concept" },
  });
  assert.deepEqual(
    parseProjectGenerationSelectionUiActionResponse(read, {
      selectionRevision: 0,
      current: null,
    }),
    { selectionRevision: 0, current: null },
  );
  const write = parseProjectGenerationSelectionUiActionRequest({
    action: PROJECT_GENERATION_SELECTION_UI_ACTIONS[1],
    input: { ...request, idempotencyKey: "select-one" },
  });
  assert.deepEqual(
    parseProjectGenerationSelectionUiActionResponse(write, receipt),
    receipt,
  );
  invalid(() =>
    parseProjectGenerationSelectionUiActionRequest({
      action: "crewon.project-generations.v1.generateConcept",
      input: request,
    }),
  );
  invalid(() => parseProjectGenerationSelectionUiActionResponse(read, receipt));
  invalid(() =>
    parseProjectGenerationSelectionUiActionResponse(write, {
      selectionRevision: 0,
      current: null,
    }),
  );
});

test("immutable replay receipt can coexist with a newer current pointer", () => {
  assert.deepEqual(
    parseSelectConceptImageResponse(
      { ...receipt, disposition: "replayed" },
      request,
    ),
    { ...receipt, disposition: "replayed" },
  );
  const current = { ...selected, resultIndex: 1, requiresConfirmation: true };
  assert.deepEqual(
    parseGetConceptSelectionResponse(
      { selectionRevision: 5, current },
      { projectId: reference.projectId, assetId: reference.assetId },
    ),
    { selectionRevision: 5, current },
  );
  invalid(() =>
    parseSelectConceptImageResponse(
      { ...receipt, selectionRevision: 5 },
      request,
    ),
  );
  invalid(() =>
    parseSelectConceptImageResponse(
      { ...receipt, selection: { ...selected, requiresConfirmation: false } },
      request,
    ),
  );
});

for (const field of [
  "url",
  "filename",
  "sourceRunId",
  "configurationRevision",
  "providerReferenceJson",
  "payerPrincipalId",
  "price",
  "threadId",
  "prompt",
]) {
  test(`caller cannot supply ${field} as selection authority`, () => {
    invalid(() =>
      parseSelectConceptImageRequest({ ...request, [field]: "caller-value" }),
    );
    invalid(() =>
      parseProjectGenerationSelectionUiActionRequest({
        action: PROJECT_GENERATION_SELECTION_UI_ACTIONS[1],
        input: { ...request, idempotencyKey: "key", [field]: "caller-value" },
      }),
    );
  });
}

test("rejects unknown nested fields, accessors and oversize input without executing getters", () => {
  invalid(() =>
    parseSelectConceptImageRequest({
      ...request,
      reference: { ...reference, owner: "other" },
    }),
  );
  let invoked = false;
  const getter = Object.defineProperty({ ...request }, "resultIndex", {
    enumerable: true,
    get() {
      invoked = true;
      return 0;
    },
  });
  invalid(() => parseSelectConceptImageRequest(getter));
  assert.equal(invoked, false);
  invalid(() =>
    parseSelectConceptImageRequest({ ...request, url: "中".repeat(9000) }),
  );
});

test("selection CAS zero is valid; unsafe, missing and saturated CAS are rejected", () => {
  assert.equal(
    parseSelectConceptImageRequest(request).expectedSelectionRevision,
    0,
  );
  for (const expectedSelectionRevision of [
    -1,
    0.1,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    "0",
    undefined,
  ])
    invalid(() =>
      parseSelectConceptImageRequest({ ...request, expectedSelectionRevision }),
    );
  for (const resultIndex of [-1, 16, 0.1, "2"])
    invalid(() => parseSelectConceptImageRequest({ ...request, resultIndex }));
  for (const expectedOperationRevision of [
    0,
    0.1,
    "3",
    Number.MAX_SAFE_INTEGER + 1,
  ])
    invalid(() =>
      parseSelectConceptImageRequest({ ...request, expectedOperationRevision }),
    );
  invalid(() =>
    parseSelectConceptImageRequest({
      ...request,
      operationId: "AAAAAAAA-1111-1111-1111-111111111111",
    }),
  );
});

test("read null implies revision zero and never implies missing capability", () => {
  invalid(() =>
    parseGetConceptSelectionResponse({ selectionRevision: 1, current: null }),
  );
  invalid(() =>
    parseGetConceptSelectionResponse({
      selectionRevision: 0,
      current: { ...selected, requiresConfirmation: false },
    }),
  );
  invalid(() =>
    parseGetConceptSelectionResponse({
      selectionRevision: 1,
      current: { ...selected, requiresConfirmation: "false" },
    }),
  );
  invalid(() =>
    parseGetConceptSelectionResponse(
      {
        selectionRevision: 1,
        current: { ...selected, requiresConfirmation: false },
      },
      { projectId: "other", assetId: "concept" },
    ),
  );
});

test("receipt must match the selected source, operation revision and raw index", () => {
  for (const mismatch of [
    { operationId: "22222222-2222-2222-2222-222222222222" },
    { operationRevision: 4 },
    { resultIndex: 1 },
    { reference: { ...selected.reference, assetRevision: 3 } },
    { reference: { ...selected.reference, assetId: "another" } },
  ])
    invalid(() =>
      parseSelectConceptImageResponse(
        { ...receipt, selection: { ...selected, ...mismatch } },
        request,
      ),
    );
  invalid(() =>
    parseSelectConceptImageResponse(
      { ...receipt, disposition: "accepted" },
      request,
    ),
  );
});

test("public selection cannot carry unsafe media URLs or provider-private data", () => {
  for (const url of [
    "http://provider.test/img",
    "https://secret@provider.test/img",
    "https://provider.test/img#fragment",
    "https://provider.test/img#",
    "javascript:alert(1)",
    "https://provider.test/\nimg",
    "https://provider.test/" + "中".repeat(800),
  ])
    invalid(() =>
      parseSelectConceptImageResponse({
        ...receipt,
        selection: { ...selected, url },
      }),
    );
  invalid(() =>
    parseSelectConceptImageResponse({
      ...receipt,
      selection: { ...selected, providerReferenceJson: "{}" },
    }),
  );
  invalid(() =>
    parseSelectConceptImageResponse({
      ...receipt,
      selection: { ...selected, selectedAt: "2026-10-04" },
    }),
  );
});
