import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProjectMediaInputUiRequest as parse,
  parseProjectMediaInputUiResponse,
  PROJECT_MEDIA_INPUT_UI_ACTIONS as actions,
  isProjectMediaInputUiNamespaceAction,
} from "./project-media-inputs-ui.ts";
import { pluginUiActionInputMaximumBytes } from "./plugin-project-texts-ui-service.ts";
const command = {
  projectId: "project",
  mediaInputId: null,
  expectedInputRevision: 0,
  item: { kind: "character-reference", assetId: "character" },
  briefRevision: 1,
  script: null,
  workflowId: "krea2-reference-four-view",
  configurationRevision: 1,
  prompt: "保持林予五官，四视图。",
  references: {
    character: {
      projectId: "project",
      assetId: "character",
      kind: "character",
      expectedAssetRevision: 4,
      contentRevision: 1,
      referenceRevision: 1,
    },
  },
  idempotencyKey: "manual-media-input",
};
test("UI actions share bounded original logical contract and leave older transport budgets intact", () => {
  const r = parse({ action: actions.saveInput, input: command });
  assert.deepEqual(r.input, command);
  assert.ok(Object.isFrozen(r.input.references));
  assert.equal(pluginUiActionInputMaximumBytes(actions.saveInput), 24 * 1024);
  assert.equal(
    pluginUiActionInputMaximumBytes(
      "crewon.project-texts.v1.saveScriptCandidate",
    ),
    60 * 1024,
  );
  assert.equal(pluginUiActionInputMaximumBytes("unknown.action"), 24 * 1024);
  assert.throws(() =>
    parse({
      action: actions.saveInput,
      input: { ...command, prompt: "界".repeat(2731) },
    }),
  );
  for (const patch of [
    { baseUrl: "https://provider.example/" },
    { graph: {} },
    { profileId: "ambient" },
    { credential: "ambient" },
  ])
    assert.throws(() =>
      parse({ action: actions.saveInput, input: { ...command, ...patch } }),
    );
});
test("read queries freeze exact historical revision and validate missing response", () => {
  const r = parse({
    action: actions.loadInput,
    input: { projectId: "project", mediaInputId: "input-1", inputRevision: 2 },
  });
  assert.deepEqual(parseProjectMediaInputUiResponse(r, { state: null }), {
    state: null,
  });
  assert.throws(() =>
    parseProjectMediaInputUiResponse(r, { state: null, runId: "fake" }),
  );
  for (const action of [
    "crewon.project-media-inputs",
    "crewon.project-media-inputs.v2.saveInput",
    "crewon.project-media-inputs.v1.execute",
  ])
    assert.throws(() => parse({ action, input: command }));
  assert.equal(
    isProjectMediaInputUiNamespaceAction(
      "crewon.project-media-inputs.v2.saveInput",
    ),
    true,
  );
  assert.equal(
    isProjectMediaInputUiNamespaceAction("crewon.project-media-inputs-foreign"),
    false,
  );
  let getters = 0;
  const value = Object.defineProperty({ action: actions.saveInput }, "input", {
    enumerable: true,
    get() {
      getters++;
      return command;
    },
  });
  assert.throws(() => parse(value));
  assert.equal(getters, 0);
});
