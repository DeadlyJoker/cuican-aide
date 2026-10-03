import assert from "node:assert/strict";
import test from "node:test";
import {
  CREWON_PROJECT_GENERATION_CONTEXTS_SERVICE,
  CREWON_PROJECT_GENERATION_CONTEXTS_API_VERSION,
  PROJECT_GENERATION_CONTEXT_UI_ACTIONS,
  parseProjectGenerationContextUiActionRequest,
  parseProjectGenerationContextUiActionResponse,
} from "./project-generation-context-ui-action-contract.ts";
import { PROJECT_GENERATION_UI_ACTIONS } from "./project-generation-ui-action-contract.ts";

const action = "crewon.project-generation-contexts.v1.getReadiness";
const reference = {
  projectId: "项目/%2F",
  assetId: "概念\\1",
  assetRevision: 2,
  expectedProjectRevision: 7,
  expectedAssetMetadataRevision: 3,
};
const request = () =>
  parseProjectGenerationContextUiActionRequest({
    action,
    input: { reference },
  });

test("generation readiness has a separate single-action protocol and detached saved source", () => {
  assert.equal(
    CREWON_PROJECT_GENERATION_CONTEXTS_SERVICE,
    "crewon.project-generation-contexts",
  );
  assert.equal(CREWON_PROJECT_GENERATION_CONTEXTS_API_VERSION, "1");
  assert.deepEqual(PROJECT_GENERATION_CONTEXT_UI_ACTIONS, [action]);
  assert.deepEqual(PROJECT_GENERATION_UI_ACTIONS, [
    "crewon.project-generations.v1.generateConcept",
  ]);
  const source = { ...reference };
  const captured = parseProjectGenerationContextUiActionRequest({
    action,
    input: { reference: source },
  });
  source.assetRevision = 9;
  assert.deepEqual(captured.input.reference, reference);
  for (const value of [captured, captured.input, captured.input.reference])
    assert.ok(Object.isFrozen(value));
});

test("readiness cannot select thread, target, wallet, identity, draft or execution capability", () => {
  for (const field of [
    "threadId",
    "target",
    "payer",
    "actor",
    "prompt",
    "idempotencyKey",
    "capability",
    "price",
    "pluginId",
  ]) {
    assert.throws(() =>
      parseProjectGenerationContextUiActionRequest({
        action,
        input: { reference, [field]: "injected" },
      }),
    );
    assert.throws(() =>
      parseProjectGenerationContextUiActionRequest({
        action,
        input: { reference: { ...reference, [field]: "injected" } },
      }),
    );
  }
  for (const field of Object.keys(reference)) {
    const incomplete: Record<string, unknown> = { ...reference };
    delete incomplete[field];
    assert.throws(() =>
      parseProjectGenerationContextUiActionRequest({
        action,
        input: { reference: incomplete },
      }),
    );
  }
  for (const wrong of [
    "getReadiness",
    "crewon.project-generations.v1.getReadiness",
    "crewon.project-generation-contexts.v2.getReadiness",
    "crewon.project-generation-contexts.v1.generateConcept",
  ])
    assert.throws(() =>
      parseProjectGenerationContextUiActionRequest({
        action: wrong,
        input: { reference },
      }),
    );
});

test("ready and known unavailable responses exactly echo all five original source fields", () => {
  const values = [
    { outcome: "ready" },
    ...[
      "project_generation_input_unavailable",
      "project_generation_configuration_unavailable",
      "project_generation_runtime_unavailable",
    ].map((reasonCode) => ({ outcome: "unavailable", reasonCode })),
  ];
  for (const readiness of values) {
    const result = parseProjectGenerationContextUiActionResponse(request(), {
      reference,
      readiness,
    });
    assert.deepEqual(result, { reference, readiness });
    assert.ok(Object.isFrozen(result.readiness));
  }
  for (const field of Object.keys(reference))
    assert.throws(() =>
      parseProjectGenerationContextUiActionResponse(request(), {
        reference: {
          ...reference,
          [field]:
            typeof reference[field as keyof typeof reference] === "number"
              ? 99
              : "foreign",
        },
        readiness: { outcome: "ready" },
      }),
    );
  for (const readiness of [
    { outcome: "ready", reasonCode: "project_generation_input_unavailable" },
    { outcome: "unavailable" },
    { outcome: "unavailable", reasonCode: "insufficient_credits" },
    { outcome: "ready", price: 0 },
    null,
  ])
    assert.throws(() =>
      parseProjectGenerationContextUiActionResponse(request(), {
        reference,
        readiness,
      }),
    );
  assert.throws(() =>
    parseProjectGenerationContextUiActionResponse(request(), {
      reference,
      readiness: { outcome: "ready" },
      authority: {},
    }),
  );
});

test("readiness request/response boundaries reject accessors, serialization hooks and oversized JSON without running hooks", () => {
  let hooks = 0;
  const raw = { action, input: { reference } };
  assert.throws(() =>
    parseProjectGenerationContextUiActionRequest({
      ...raw,
      get input() {
        hooks++;
        return raw.input;
      },
    }),
  );
  assert.throws(() =>
    parseProjectGenerationContextUiActionRequest({
      ...raw,
      toJSON() {
        hooks++;
        return raw;
      },
    }),
  );
  assert.throws(() =>
    parseProjectGenerationContextUiActionResponse(request(), {
      reference,
      get readiness() {
        hooks++;
        return { outcome: "ready" };
      },
    }),
  );
  assert.throws(
    () =>
      parseProjectGenerationContextUiActionRequest({
        action,
        input: { reference },
        extra: "中".repeat(8192),
      }),
    /plugin_ui_json_bytes_exceeded/,
  );
  assert.throws(
    () =>
      parseProjectGenerationContextUiActionResponse(request(), {
        reference,
        readiness: { outcome: "ready" },
        extra: "中".repeat(8192),
      }),
    /plugin_ui_json_bytes_exceeded/,
  );
  assert.equal(hooks, 0);
});
