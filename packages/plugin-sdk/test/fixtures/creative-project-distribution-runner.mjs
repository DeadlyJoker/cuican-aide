import assert from "node:assert/strict";
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
