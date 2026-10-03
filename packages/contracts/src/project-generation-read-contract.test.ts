import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CREATIVE_PROJECT_RESPONSE_BYTES } from "./creative-project-control-types.ts";
import { parseGetExtensionTaskResponse } from "./extension-read-contract.ts";
import {
  parseConceptGenerationLocator,
  parseGetConceptGenerationResponse,
} from "./project-generation-read-contract.ts";

const locator = { projectId: "项目 / %", assetId: "概念\\1", assetRevision: 2 };
const at = "2026-10-03T00:00:00.000Z";
function response() {
  return {
    generation: {
      ...locator,
      briefRevision: 1,
      createdAt: at,
      task: {
        runId: "original-run",
        threadId: "original-thread",
        pluginId: "crewon.comfyui-krea2",
        pluginVersion: "1.0.0",
        configurationRevision: 1,
        runStatus: "completed",
        sourceRunId: null,
        operations: [
          {
            operationId: "00000000-0000-0000-0000-000000000001",
            sourceRunId: "original-run",
            status: "succeeded",
            observedAt: at,
            operationRevision: 3,
            images: [
              {
                url: "https://comfy.test/view?filename=a.png",
                filename: "a.png",
                resultIndex: 0,
              },
            ],
          },
        ],
        truncated: false,
      },
    },
  };
}

test("generation read copies the exact immutable source and original task without execution selectors", () => {
  assert.deepEqual(parseConceptGenerationLocator(locator), locator);
  const raw = response();
  const parsed = parseGetConceptGenerationResponse(raw, locator);
  assert.deepEqual(parsed, raw);
  raw.generation.task.operations[0]!.images[0]!.filename = "changed.png";
  assert.equal(
    parsed.generation!.task.operations[0]!.images[0]!.filename,
    "a.png",
  );
  assert.ok(Object.isFrozen(parsed.generation!.task.operations[0]!.images[0]));
  assert.deepEqual(
    parseGetConceptGenerationResponse({ generation: null }, locator),
    { generation: null },
  );
});

test("the locator rejects account, target, Run, selectors and unsafe numeric revisions", () => {
  for (const field of [
    "actor",
    "tenantId",
    "principalId",
    "pluginId",
    "runId",
    "prompt",
    "executionPin",
    "url",
  ]) {
    assert.throws(() =>
      parseConceptGenerationLocator({ ...locator, [field]: "injected" }),
    );
  }
  for (const revision of [0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() =>
      parseConceptGenerationLocator({ ...locator, assetRevision: revision }),
    );
  }
  let calls = 0;
  assert.throws(() =>
    parseConceptGenerationLocator({
      ...locator,
      get assetRevision() {
        calls++;
        return 2;
      },
    }),
  );
  assert.equal(calls, 0);
});

test("null and populated responses validate the expected locator before publishing", () => {
  for (const expected of [
    { ...locator, runId: "injected" },
    { ...locator, assetRevision: "2" },
  ])
    assert.throws(() =>
      parseGetConceptGenerationResponse(
        { generation: null },
        expected as unknown as typeof locator,
      ),
    );
  for (const expected of [
    { ...locator, assetRevision: 1 },
    { ...locator, projectId: "other" },
    { ...locator, assetId: "other" },
  ])
    assert.throws(() =>
      parseGetConceptGenerationResponse(response(), expected),
    );
});

test("unknown private fields and forged projections never enter the public response", () => {
  assert.throws(() =>
    parseGetConceptGenerationResponse({ generation: null, actor: {} }),
  );
  for (const level of ["generation", "task", "operation", "image"] as const) {
    const raw = response();
    const target =
      level === "generation"
        ? raw.generation
        : level === "task"
          ? raw.generation.task
          : level === "operation"
            ? raw.generation.task.operations[0]!
            : raw.generation.task.operations[0]!.images[0]!;
    Object.assign(target, { binding: {} });
    assert.throws(() => parseGetConceptGenerationResponse(raw));
  }
  for (const source of ["query-parent", "original-run"]) {
    const raw = response();
    Object.assign(raw.generation.task, { sourceRunId: source });
    assert.throws(() => parseGetConceptGenerationResponse(raw));
  }
});

test("operation and original result indices are bounded, unique and versioned", () => {
  for (const revision of [0, -1, 1.1, "3", Number.MAX_SAFE_INTEGER + 1]) {
    const raw = response();
    Object.assign(raw.generation.task.operations[0]!, {
      operationRevision: revision,
    });
    assert.throws(() => parseGetConceptGenerationResponse(raw));
  }
  for (const index of [-1, 16, 1.5, "0"]) {
    const raw = response();
    Object.assign(raw.generation.task.operations[0]!.images[0]!, {
      resultIndex: index,
    });
    assert.throws(() => parseGetConceptGenerationResponse(raw));
  }
  for (const indices of [
    [0, 0],
    [2, 1],
  ]) {
    const raw = response();
    raw.generation.task.truncated = true;
    raw.generation.task.operations[0]!.images = indices.map((resultIndex) => ({
      ...raw.generation.task.operations[0]!.images[0]!,
      resultIndex,
    }));
    assert.throws(() => parseGetConceptGenerationResponse(raw));
  }
  const duplicate = response();
  duplicate.generation.task.operations.push(
    structuredClone(duplicate.generation.task.operations[0]!),
  );
  assert.throws(() => parseGetConceptGenerationResponse(duplicate));
  const wrongRun = response();
  wrongRun.generation.task.operations[0]!.sourceRunId = "other-run";
  assert.throws(() => parseGetConceptGenerationResponse(wrongRun));
});

test("truncation retains original indices and never substitutes the displayed array position", () => {
  const raw = response();
  raw.generation.task.truncated = true;
  raw.generation.task.operations[0]!.images[0]!.resultIndex = 5;
  assert.equal(
    parseGetConceptGenerationResponse(raw).generation!.task.operations[0]!
      .images[0]!.resultIndex,
    5,
  );
  raw.generation.task.truncated = false;
  assert.throws(() => parseGetConceptGenerationResponse(raw));
});

test("CrewON run status remains separate from the supplier state", () => {
  const raw = response();
  raw.generation.task.operations[0]!.status = "running";
  raw.generation.task.operations[0]!.images = [];
  assert.equal(
    parseGetConceptGenerationResponse(raw).generation!.task.runStatus,
    "completed",
  );
  raw.generation.task.runStatus = "canceled";
  raw.generation.task.operations[0]!.status = "succeeded";
  assert.equal(
    parseGetConceptGenerationResponse(raw).generation!.task.operations[0]!
      .status,
    "succeeded",
  );
  raw.generation.task.operations[0]!.status = "unknownOutcome";
  raw.generation.task.operations[0]!.images = [
    { url: "https://comfy.test/result", filename: "a.png", resultIndex: 0 },
  ];
  assert.throws(() => parseGetConceptGenerationResponse(raw));
});

test("original task strictness still rejects new generation-only fields", () => {
  const task = response().generation.task;
  assert.throws(() => parseGetExtensionTaskResponse({ task }));
  const raw = response();
  raw.generation.task.operations[0]!.images[0]!.url =
    "https://user:password@comfy.test/view";
  assert.throws(() => parseGetConceptGenerationResponse(raw));
  raw.generation.task.operations[0]!.images[0]!.url =
    "https://comfy.test/view#secret";
  assert.throws(() => parseGetConceptGenerationResponse(raw));
});

test("the complete response obeys the existing project 60 KiB bound", () => {
  const raw = response();
  const original = raw.generation.task.operations[0]!;
  raw.generation.task.operations = Array.from({ length: 16 }, (_, i) => ({
    ...original,
    operationId: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    images: Array.from({ length: 16 }, (_, resultIndex) => ({
      url: "https://comfy.test/" + "x".repeat(1000),
      filename: "x".repeat(1000),
      resultIndex,
    })),
  }));
  assert.ok(
    new TextEncoder().encode(JSON.stringify(raw)).byteLength >
      MAX_CREATIVE_PROJECT_RESPONSE_BYTES,
  );
  assert.throws(() => parseGetConceptGenerationResponse(raw));
});
