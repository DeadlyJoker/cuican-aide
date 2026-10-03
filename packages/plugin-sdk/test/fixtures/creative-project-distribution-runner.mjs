import assert from "node:assert/strict";
import { createMetadataClient } from "./dist/external-creative-project-ui.js";
import {
  requirement,
  getRequest,
} from "./dist/external-creative-project-contracts.js";
import { project, projectId, vectors } from "./creative-project-responses.mjs";

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
