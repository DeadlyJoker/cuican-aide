import assert from "node:assert/strict";
import {
  createPluginProjectSourceUploadsClient,
  PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS,
} from "@crewon/plugin-sdk/project-source-uploads";
import { createPortableSourceUploadClient } from "./dist/external-project-source-uploads.js";
import {
  createNativeSourceUploadClient,
  writeSourcePartWithNativeSignal,
} from "./dist/external-project-source-uploads-ui.js";
import {
  upload,
  uploadId,
  partLocator,
  writtenUpload,
  uploadVectors,
} from "./project-source-upload-responses.mjs";

for (const create of [
  createPortableSourceUploadClient,
  createNativeSourceUploadClient,
]) {
  for (const [method, input, output] of uploadVectors) {
    let calls = 0;
    const controller = new AbortController();
    const services = {
      async invoke(action, json, options) {
        assert.equal(this, services);
        assert.equal(action, PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS[method]);
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
    controller.abort(new Error("external_upload_cancelled"));
    await assert.rejects(client[method](input, { signal: controller.signal }));
    assert.equal(calls, 1);
  }
  let calls = 0;
  const raw = {
    async writePart(locator, bytes, options) {
      assert.equal(this, raw);
      assert.deepEqual(locator, partLocator);
      assert.deepEqual([...bytes], [1, 2, 3, 4, 5, 6, 7]);
      assert.equal(options.signal, controller.signal);
      calls++;
      return { disposition: "replayed", upload: writtenUpload };
    },
  };
  const controller = new AbortController();
  const services = {
    projectSourceUploads: raw,
    async invoke() {
      throw new Error("raw_is_not_json");
    },
  };
  const client =
    create === createNativeSourceUploadClient
      ? create(services)
      : create(services, raw);
  assert.deepEqual(
    await writeSourcePartWithNativeSignal(
      client,
      partLocator,
      new Uint8Array([1, 2, 3, 4, 5, 6, 7]),
      controller.signal,
    ),
    { disposition: "replayed", upload: writtenUpload },
  );
  await assert.rejects(client.writePart(partLocator, new Uint8Array(65_537)));
  await assert.rejects(
    client.writePart(partLocator, new Uint8Array(new SharedArrayBuffer(7))),
  );
  assert.equal(calls, 1);
}
const client = createPluginProjectSourceUploadsClient({
  async invoke() {
    return { upload };
  },
});
await assert.rejects(
  client.status(
    { uploadId },
    {
      signal: {
        aborted: false,
        addEventListener() {},
        removeEventListener() {},
      },
    },
  ),
);
await assert.rejects(
  client.writePart(partLocator, new Uint8Array(7)),
  /plugin_project_source_upload_raw_port_required/u,
);
console.log(
  "Independent upload client compiled without DOM and with original UI services, invoked four JSON actions and a separate bounded native byte port.",
);
