import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  createPluginMediaInputUiClient,
  type MediaInputUiJson,
} from "./project-media-inputs-ui-client.ts";
import { projectMediaInputsUiCodec } from "../../../examples/plugins/short-drama/src/project-media-inputs-ui-codec.mjs";
import { parseProjectMediaInputUiRequest } from "./project-media-inputs-ui.ts";

test("the portable client and copied strict codec agree with host actions and capture exact callbacks", async () => {
  assert.equal(
    await readFile(
      new URL("./project-media-inputs-ui-client.ts", import.meta.url),
      "utf8",
    ),
    await readFile(
      new URL(
        "../../../examples/plugins/short-drama/src/project-media-inputs-ui-client.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const calls: unknown[] = [];
  const services = {
    async invoke(action: string, input: unknown): Promise<MediaInputUiJson> {
      calls.push({ action, input });
      return action.endsWith("getOptions")
        ? { configuration: null }
        : { inputs: [], nextMediaInputId: null };
    },
  };
  const client = createPluginMediaInputUiClient(
    services,
    projectMediaInputsUiCodec,
  );
  services.invoke = async () => {
    throw Error("replacement must not be called");
  };
  await client.listInputs({
    projectId: "p",
    afterMediaInputId: null,
    limit: 8,
  });
  await client.getOptions({ projectId: "p" });
  for (const request of calls)
    assert.deepEqual(
      projectMediaInputsUiCodec.parseRequest(request),
      parseProjectMediaInputUiRequest(request),
    );
  await assert.rejects(
    client.listInputs({ projectId: "p", afterMediaInputId: null, limit: 17 }),
  );
  let getters = 0;
  const bad = Object.defineProperty({}, "invoke", {
    get() {
      getters++;
      return services.invoke;
    },
  });
  assert.throws(() =>
    createPluginMediaInputUiClient(
      bad as typeof services,
      projectMediaInputsUiCodec,
    ),
  );
  assert.equal(getters, 0);
  const signal = new AbortController();
  signal.abort();
  await assert.rejects(
    client.getOptions({ projectId: "p" }, { signal: signal.signal }),
  );
  assert.equal(calls.length, 2);
});
