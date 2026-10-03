import assert from "node:assert/strict";
import test from "node:test";
import { ContractValidationError } from "./contract-validation-error.ts";
import {
  CREWON_PROJECT_GENERATION_QUERIES_SERVICE,
  CREWON_PROJECT_GENERATION_QUERIES_API_VERSION,
  PROJECT_GENERATION_QUERY_UI_ACTIONS,
  parseProjectGenerationQueryUiActionRequest,
  parseProjectGenerationQueryUiActionResponse,
} from "./project-generation-query-ui-action-contract.ts";
import { parseProjectGenerationUiActionRequest } from "./project-generation-ui-action-contract.ts";

const action = "crewon.project-generation-queries.v1.queryConceptGeneration";
function input() {
  return {
    reference: {
      projectId: "项目/中文 %2F",
      assetId: "概念\\旧版本",
      assetRevision: 2,
    },
    operationId: "00000000-0000-4000-8000-000000000123",
    threadId: "thread/原会话",
    expectedThreadRevision: 5,
    idempotencyKey: "one-explicit-query-intent",
  };
}
function request(value: unknown = input()) {
  return parseProjectGenerationQueryUiActionRequest({ action, input: value });
}
function receipt() {
  return {
    disposition: "committed" as const,
    threadId: input().threadId,
    threadRevision: 6,
    runId: "query-run-原操作",
    messageId: "query-message",
    configurationRevision: 4,
  };
}
function refuses(work: () => unknown) {
  assert.throws(work, ContractValidationError);
}

test("query is independently declared and references historical source without current metadata CAS", () => {
  assert.equal(
    CREWON_PROJECT_GENERATION_QUERIES_SERVICE,
    "crewon.project-generation-queries",
  );
  assert.equal(CREWON_PROJECT_GENERATION_QUERIES_API_VERSION, "1");
  assert.deepEqual(PROJECT_GENERATION_QUERY_UI_ACTIONS, [action]);
  const original = input();
  const captured = request(original);
  original.reference.assetRevision = 9;
  original.operationId = "00000000-0000-4000-8000-000000000999";
  assert.equal(captured.input.reference.assetRevision, 2);
  assert.equal(captured.input.operationId, input().operationId);
  assert.ok(Object.isFrozen(captured.input.reference));
  assert.ok(Object.isFrozen(captured.input));
  refuses(() => parseProjectGenerationUiActionRequest(captured));
  for (const wrong of [
    "crewon.project-generations.v1.queryConceptGeneration",
    "crewon.project-generation-queries.v2.queryConceptGeneration",
    "crewon.project-generation-queries.v1.generateConcept",
  ])
    refuses(() =>
      parseProjectGenerationQueryUiActionRequest({
        action: wrong,
        input: input(),
      }),
    );
});

test("query rejects caller-selected execution, billing, prompt and current metadata authority", () => {
  const original = input();
  for (const field of Object.keys(original)) {
    const value: Record<string, unknown> = { ...original };
    delete value[field];
    refuses(() => request(value));
  }
  for (const field of [
    "sourceRunId",
    "runId",
    "pluginId",
    "target",
    "actor",
    "payer",
    "price",
    "prompt",
    "configurationRevision",
    "expectedProjectRevision",
    "expectedAssetMetadataRevision",
  ]) {
    refuses(() => request({ ...original, [field]: "injected" }));
    refuses(() =>
      request({
        ...original,
        reference: { ...original.reference, [field]: "injected" },
      }),
    );
  }
});

test("operation identity and next thread revision are exact and bounded", () => {
  for (const operationId of [
    "",
    "uuid",
    input().operationId.toUpperCase().replace("123", "ABC"),
    `${input().operationId} `,
    ` ${input().operationId}`,
    null,
    123,
  ])
    refuses(() => request({ ...input(), operationId }));
  for (const revision of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER,
    "5",
  ])
    refuses(() => request({ ...input(), expectedThreadRevision: revision }));
  for (const revision of [0, -1, NaN, "2"])
    refuses(() =>
      request({
        ...input(),
        reference: { ...input().reference, assetRevision: revision },
      }),
    );
  const largest = request({
    ...input(),
    expectedThreadRevision: Number.MAX_SAFE_INTEGER - 1,
  });
  assert.equal(
    parseProjectGenerationQueryUiActionResponse(largest, {
      ...receipt(),
      threadRevision: Number.MAX_SAFE_INTEGER,
    }).threadRevision,
    Number.MAX_SAFE_INTEGER,
  );
});

test("untrusted query inputs do not evaluate hooks or admit oversized JSON", () => {
  let touched = 0;
  const malicious = { ...input() };
  Object.defineProperty(malicious, "operationId", {
    enumerable: true,
    get() {
      touched++;
      throw new Error("must not evaluate");
    },
  });
  refuses(() => request(malicious));
  refuses(() => request({ ...input(), idempotencyKey: "x".repeat(24 * 1024) }));
  refuses(() =>
    request(Object.assign(Object.create({ inherited: true }), input())),
  );
  refuses(() =>
    request({
      ...input(),
      toJSON() {
        touched++;
        return input();
      },
    }),
  );
  assert.equal(touched, 0);
});

test("response contains only the original accepted query receipt and safe matching thread CAS", () => {
  const accepted = parseProjectGenerationQueryUiActionResponse(
    request(),
    receipt(),
  );
  assert.deepEqual(accepted, receipt());
  assert.ok(Object.isFrozen(accepted));
  assert.equal(
    parseProjectGenerationQueryUiActionResponse(request(), {
      ...receipt(),
      disposition: "replayed",
    }).disposition,
    "replayed",
  );
  for (const extra of [
    "sourceRunId",
    "operationId",
    "images",
    "credits",
    "status",
    "projectId",
  ])
    refuses(() =>
      parseProjectGenerationQueryUiActionResponse(request(), {
        ...receipt(),
        [extra]: "injected",
      }),
    );
  for (const override of [
    { threadId: "another" },
    { threadRevision: 7 },
    { disposition: "accepted" },
    { configurationRevision: 2_147_483_648 },
    { runId: "" },
    { messageId: "" },
  ])
    refuses(() =>
      parseProjectGenerationQueryUiActionResponse(request(), {
        ...receipt(),
        ...override,
      }),
    );
});
