import assert from "node:assert/strict";
import test from "node:test";
import {
  CREWON_PROJECT_GENERATION_READS_SERVICE,
  CREWON_PROJECT_GENERATION_READS_API_VERSION,
  PROJECT_GENERATION_READ_UI_ACTIONS,
  parseProjectGenerationReadUiActionRequest,
  parseProjectGenerationReadUiActionResponse,
} from "./project-generation-read-ui-action-contract.ts";
import { PROJECT_GENERATION_UI_ACTIONS } from "./project-generation-ui-action-contract.ts";
import { CREATIVE_PROJECT_UI_ACTIONS } from "./creative-project-ui-action-contract.ts";

const action = "crewon.project-generation-reads.v1.getConceptGeneration";
const locator = {
  projectId: "项目/原始 %2F",
  assetId: "概念\\1",
  assetRevision: 2,
};
function response() {
  return {
    generation: {
      ...locator,
      briefRevision: 1,
      createdAt: "2026-10-03T00:00:00.000Z",
      task: {
        runId: "original-run",
        threadId: "original-thread",
        pluginId: "crewon.comfyui-krea2",
        pluginVersion: "1.0.0",
        configurationRevision: 1,
        runStatus: "completed",
        sourceRunId: null,
        operations: [],
        truncated: false,
      },
    },
  };
}

test("saved generation reads use a separate protocol without changing metadata or paid actions", () => {
  assert.equal(
    CREWON_PROJECT_GENERATION_READS_SERVICE,
    "crewon.project-generation-reads",
  );
  assert.equal(CREWON_PROJECT_GENERATION_READS_API_VERSION, "1");
  assert.deepEqual(PROJECT_GENERATION_READ_UI_ACTIONS, [action]);
  assert.deepEqual(PROJECT_GENERATION_UI_ACTIONS, [
    "crewon.project-generations.v1.generateConcept",
  ]);
  assert.equal(CREATIVE_PROJECT_UI_ACTIONS.length, 14);
  const input = { ...locator };
  const request = parseProjectGenerationReadUiActionRequest({ action, input });
  input.assetRevision = 8;
  assert.deepEqual(request.input, locator);
  assert.ok(Object.isFrozen(request.input));
  for (const wrong of [
    "crewon.project-generation-reads.v2.getConceptGeneration",
    "crewon.project-generations.v1.getConceptGeneration",
    "crewon.creative-projects.v1.getConceptGeneration",
    "crewon.project-generation-reads.v1.queryTask",
  ])
    assert.throws(() =>
      parseProjectGenerationReadUiActionRequest({
        action: wrong,
        input: locator,
      }),
    );
});

test("read requests cannot choose task, identity, draft, query or metadata CAS", () => {
  for (const field of [
    "runId",
    "pluginId",
    "actor",
    "prompt",
    "query",
    "idempotencyKey",
    "expectedProjectRevision",
  ])
    assert.throws(() =>
      parseProjectGenerationReadUiActionRequest({
        action,
        input: { ...locator, [field]: "injected" },
      }),
    );
  let getters = 0;
  assert.throws(() =>
    parseProjectGenerationReadUiActionRequest({
      action,
      input: {
        ...locator,
        get assetRevision() {
          getters++;
          return 2;
        },
      },
    }),
  );
  assert.equal(getters, 0);
  assert.throws(() =>
    parseProjectGenerationReadUiActionRequest({
      action,
      input: { ...locator, assetRevision: "2" },
    }),
  );
});

test("read response uses the validated source expectation even for null and rejects private authority", () => {
  const request = parseProjectGenerationReadUiActionRequest({
    action,
    input: locator,
  });
  assert.deepEqual(
    parseProjectGenerationReadUiActionResponse(request, { generation: null }),
    { generation: null },
  );
  const raw = response();
  const result = parseProjectGenerationReadUiActionResponse(request, raw);
  raw.generation.task.runId = "mutated";
  assert.equal(result.generation!.task.runId, "original-run");
  assert.ok(Object.isFrozen(result.generation!.task));
  const foreign = response();
  foreign.generation.assetRevision = 3;
  assert.throws(() =>
    parseProjectGenerationReadUiActionResponse(request, foreign),
  );
  assert.throws(() =>
    parseProjectGenerationReadUiActionResponse(
      { action, input: { ...locator, assetRevision: 0 } },
      { generation: null },
    ),
  );
  assert.throws(() =>
    parseProjectGenerationReadUiActionResponse(request, {
      ...response(),
      creditAdmission: {},
    }),
  );
});
