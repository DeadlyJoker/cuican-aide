import assert from "node:assert/strict";
import {
  PROJECT_FOUNDATION_UI_METHOD_ACTIONS,
  createPluginProjectFoundationClient,
} from "@crewon/plugin-sdk/project-foundation-ui";
import { createPortableFoundationClient } from "./dist/external-project-foundation.js";
import {
  createNativeFoundationClient,
  readFoundationWithNativeSignal,
} from "./dist/external-project-foundation-ui.js";
import {
  foundation,
  projectId,
  vectors,
} from "./project-foundation-responses.mjs";

for (const create of [
  createPortableFoundationClient,
  createNativeFoundationClient,
]) {
  for (const [method, input, output] of vectors) {
    let calls = 0;
    const controller = new AbortController();
    const services = {
      async invoke(action, json, options) {
        assert.equal(this, services);
        assert.equal(action, PROJECT_FOUNDATION_UI_METHOD_ACTIONS[method]);
        assert.deepEqual(json, input);
        assert.equal(options.signal, controller.signal);
        calls++;
        return output;
      },
    };
    const client = create(services);
    assert.equal(calls, 0);
    assert.deepEqual(
      await client[method](input, { signal: controller.signal }),
      output,
    );
    assert.equal(calls, 1);
    const reason = new Error("external_foundation_cancelled");
    controller.abort(reason);
    await assert.rejects(
      client[method](input, { signal: controller.signal }),
      (error) => error === reason,
    );
    assert.equal(calls, 1);
  }
}
let calls = 0;
const client = createPluginProjectFoundationClient({
  async invoke() {
    calls++;
    return { foundation };
  },
});
assert.deepEqual(
  await readFoundationWithNativeSignal(
    client,
    { projectId },
    new AbortController().signal,
  ),
  { foundation },
);
await assert.rejects(
  client.getFoundation(
    { projectId },
    {
      signal: {
        aborted: false,
        addEventListener() {},
        removeEventListener() {},
      },
    },
  ),
);
assert.equal(calls, 1);
console.log(
  "Independent foundation client compiled without DOM and with original UI services, invoked twelve bounded actions and enforced native cancellation.",
);
