import assert from "node:assert/strict";
import { createContextClient } from "./dist/external-project-generation-context-ui.js";
import {
  input as contextInput,
  context,
  requirement as contextRequirement,
} from "./dist/external-project-generation-context-contracts.js";
import { createMetadataClient } from "./dist/external-creative-project-ui.js";
import {
  requirement,
  getRequest,
} from "./dist/external-creative-project-contracts.js";
import { project, projectId, vectors } from "./creative-project-responses.mjs";
import { createGenerationClient } from "./dist/external-project-generation-ui.js";
import {
  generationInput,
  generationRequest,
  generationReceipt,
  requirement as generationRequirement,
} from "./dist/external-project-generation-contracts.js";
import { createReadClient } from "./dist/external-project-generation-read-ui.js";
import {
  locator,
  request as readRequest,
  response as readResponse,
  requirement as readRequirement,
} from "./dist/external-project-generation-read-contracts.js";
import { createSelectionClient } from "./dist/external-project-generation-selection-ui.js";
import {
  selectionInput,
  selectionReceipt,
  selectionRequest,
  requirement as selectionRequirement,
} from "./dist/external-project-generation-selection-contracts.js";

assert.deepEqual(selectionRequirement, {
  service: "crewon.project-generation-selections",
  apiVersion: "1",
  optional: true,
});
let selectionCalls = 0;
const selections = createSelectionClient({
  async invoke(action, input) {
    selectionCalls++;
    if (
      action === "crewon.project-generation-selections.v1.getConceptSelection"
    ) {
      assert.deepEqual(input, { projectId: "project", assetId: "asset" });
      return { selectionRevision: 0, current: null };
    }
    assert.equal(action, selectionRequest.action);
    assert.deepEqual(input, selectionInput);
    return selectionReceipt;
  },
});
assert.equal(selectionCalls, 0);
assert.deepEqual(
  await selections.getConceptSelection({
    projectId: "project",
    assetId: "asset",
  }),
  { selectionRevision: 0, current: null },
);
assert.deepEqual(
  await selections.selectConceptImage(selectionInput),
  selectionReceipt,
);
assert.equal(selectionCalls, 2);
console.log(
  "Independent image selection and current-pointer read work from the installed portable SDK.",
);

assert.deepEqual(requirement, {
  service: "crewon.creative-projects",
  apiVersion: "1",
  optional: false,
});
assert.deepEqual(getRequest, {
  action: "crewon.creative-projects.v1.getProject",
  input: { projectId },
});
let calls = 0;
const client = createMetadataClient({
  async invoke(action, input) {
    calls++;
    assert.equal(action, "crewon.creative-projects.v1.getProject");
    assert.deepEqual(input, { projectId });
    return { project };
  },
});
assert.equal(calls, 0);
assert.deepEqual(await client.getProject({ projectId }), { project });
assert.equal(calls, 1);
const refusal = new Error("fixture host permission denied");
await assert.rejects(
  createMetadataClient({
    async invoke() {
      throw refusal;
    },
  }).getProject({ projectId }),
  (error) => error === refusal,
);
for (const [method, input, response] of vectors) {
  const methods = createMetadataClient({
    async invoke(action) {
      assert.equal(action, `crewon.creative-projects.v1.${method}`);
      return response;
    },
  });
  assert.deepEqual(await methods[method](input), response);
}
console.log(
  "Creative project metadata contracts compiled without DOM; independent UI helper invoked fourteen existing-ABI actions.",
);
assert.deepEqual(generationRequirement, {
  service: "crewon.project-generations",
  apiVersion: "1",
  optional: true,
});
let generationCalls = 0;
const generationClient = createGenerationClient({
  async invoke(action, input) {
    generationCalls++;
    assert.equal(action, "crewon.project-generations.v1.generateConcept");
    assert.deepEqual(input, generationRequest.input);
    return generationReceipt;
  },
});
assert.equal(generationCalls, 0);
assert.deepEqual(
  await generationClient.generateConcept(generationInput),
  generationReceipt,
);
assert.equal(generationCalls, 1);
console.log(
  "Independent saved-source generation helper preserved the original task receipt.",
);
assert.deepEqual(readRequirement, {
  service: "crewon.project-generation-reads",
  apiVersion: "1",
  optional: true,
});
let readCalls = 0;
const readClient = createReadClient({
  async invoke(action, input) {
    readCalls++;
    assert.equal(
      action,
      "crewon.project-generation-reads.v1.getConceptGeneration",
    );
    assert.deepEqual(input, readRequest.input);
    return readResponse;
  },
});
assert.equal(readCalls, 0);
assert.deepEqual(await readClient.getConceptGeneration(locator), readResponse);
assert.equal(readCalls, 1);
console.log(
  "Independent saved-source read helper recovered the original task.",
);
assert.deepEqual(contextRequirement, {
  service: "crewon.project-generation-contexts",
  apiVersion: "1",
  optional: true,
});
assert.equal(context.threadReady, false);
let contextCalls = 0;
const ready = {
  reference: contextInput.reference,
  readiness: { outcome: "ready" },
};
const contexts = createContextClient({
  async invoke(action, input) {
    assert.equal(action, "crewon.project-generation-contexts.v1.getReadiness");
    assert.deepEqual(input, contextInput);
    contextCalls++;
    return ready;
  },
});
assert.equal(contextCalls, 0);
assert.deepEqual(await contexts.getReadiness(contextInput), ready);
assert.equal(contextCalls, 1);
console.log(
  "Independent readiness helper returned a bounded hint without submitting a task.",
);
