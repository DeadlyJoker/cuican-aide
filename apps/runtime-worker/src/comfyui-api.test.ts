import assert from "node:assert/strict";
import test from "node:test";
import {
  ComfyApi,
  comfyImagePath,
  type ComfyJsonHttpPort,
} from "./extensions/comfyui-api.ts";

const id = "da7b2922-e9a1-4dda-9020-528bfbe197d0";
const signal = () => new AbortController().signal;
const image = {
  filename: "result 1.png",
  subfolder: "crewon",
  type: "output" as const,
};

test("submit performs one POST and preserves correlation independently of the returned job ID", async () => {
  const mintedId = "ba7b2922-e9a1-4dda-9020-528bfbe197d1";
  const requests: unknown[] = [];
  const api = new ComfyApi({
    request: async (input) => {
      requests.push(input);
      return { prompt_id: mintedId, node_errors: {} };
    },
  });
  assert.deepEqual(
    await api.submit({
      workflow: { "29": {} },
      requestId: id,
      signal: signal(),
    }),
    { promptId: mintedId },
  );
  assert.equal(requests.length, 1);
  assert.deepEqual((requests[0] as { body: unknown }).body, {
    prompt: { "29": {} },
    prompt_id: id,
    client_id: id,
    extra_data: { crewon_request_id: id },
  });
});

test("does not resubmit when the POST response is lost", async () => {
  let sends = 0;
  const api = new ComfyApi({
    request: async () => {
      sends++;
      throw new Error("connection lost after send");
    },
  });
  await assert.rejects(
    api.submit({ workflow: {}, requestId: id, signal: signal() }),
    /connection lost/u,
  );
  assert.equal(sends, 1);
});

test("reports queued and running separately from completed tool submission", async () => {
  for (const status of ["queued", "running"] as const) {
    const api = new ComfyApi({
      request: async ({ path }) =>
        path.startsWith("/history/")
          ? {}
          : {
              queue_running: status === "running" ? [[0, id]] : [],
              queue_pending: status === "queued" ? [[0, id]] : [],
            },
    });
    assert.deepEqual(
      await api.observe({ promptId: id, outputNodeId: "29", signal: signal() }),
      { status, images: [] },
    );
  }
});

test("returns only verified images for the requested job and output node", async () => {
  const paths: string[] = [];
  const api = new ComfyApi({
    request: async ({ path }) => {
      paths.push(path);
      return completed({
        "29": { images: [image] },
        "99": { images: [{ filename: "other.png" }] },
      });
    },
  });
  assert.deepEqual(
    await api.observe({ promptId: id, outputNodeId: "29", signal: signal() }),
    { status: "succeeded", images: [image] },
  );
  assert.deepEqual(paths, [`/history/${id}`]);
  assert.equal(
    comfyImagePath(image),
    "/view?filename=result+1.png&subfolder=crewon&type=output",
  );
});

test("missing history and queue is unknown, never proof of safe resubmission", async () => {
  const api = new ComfyApi({
    request: async ({ path }) =>
      path.startsWith("/history/")
        ? { unrelated: completed({}) }
        : { queue_running: [], queue_pending: [] },
  });
  assert.deepEqual(
    await api.observe({ promptId: id, outputNodeId: "29", signal: signal() }),
    { status: "unknownOutcome", images: [] },
  );
});

test("provider error is failed and success without output is rejected", async () => {
  const failed = new ComfyApi({
    request: async () => ({
      [id]: { status: { status_str: "error", completed: false } },
    }),
  });
  assert.deepEqual(
    await failed.observe({
      promptId: id,
      outputNodeId: "29",
      signal: signal(),
    }),
    { status: "failed", images: [] },
  );
  const empty = new ComfyApi({
    request: async () => completed({ "29": { images: [] } }),
  });
  await assert.rejects(
    empty.observe({ promptId: id, outputNodeId: "29", signal: signal() }),
    /comfy_images_invalid/u,
  );
});

test("rejects provider image traversal and input-file references", async () => {
  for (const patch of [
    { filename: "../private.png" },
    { subfolder: "../private" },
    { subfolder: "/absolute" },
    { type: "input" },
  ]) {
    const api = new ComfyApi({
      request: async () =>
        completed({ "29": { images: [{ ...image, ...patch }] } }),
    });
    await assert.rejects(
      api.observe({ promptId: id, outputNodeId: "29", signal: signal() }),
      /comfy_image_reference_invalid/u,
    );
  }
});

test("invalid identities fail before any request and node rejection is not success", async () => {
  const never: ComfyJsonHttpPort = {
    request: async () => {
      assert.fail("must not request");
    },
  };
  await assert.rejects(
    new ComfyApi(never).observe({
      promptId: "../history",
      outputNodeId: "29",
      signal: signal(),
    }),
    /comfy_prompt_id_invalid/u,
  );
  const rejected = new ComfyApi({
    request: async () => ({
      prompt_id: id,
      node_errors: { "29": { error: "invalid" } },
    }),
  });
  await assert.rejects(
    rejected.submit({ workflow: {}, requestId: id, signal: signal() }),
    /comfy_prompt_rejected/u,
  );
});

function completed(outputs: unknown) {
  return {
    [id]: { status: { completed: true, status_str: "success" }, outputs },
  };
}
