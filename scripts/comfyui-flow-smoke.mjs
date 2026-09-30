import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  ComfyApi,
  comfyImagePath,
} from "../apps/runtime-worker/src/extensions/comfyui-api.ts";

// Explicit diagnostic harness: not a production HTTP transport or scheduler.
const { values } = parseArgs({
  options: {
    "base-url": { type: "string" },
    "workflow": { type: "string" },
    "prompt": { type: "string" },
    "output-dir": { type: "string" },
    "resume": { type: "boolean", default: false },
    "megapixels": { type: "string", default: "1" },
    "timeout-seconds": { type: "string", default: "240" },
  },
});
if (!values["output-dir"]) throw new Error("--output-dir is required");
const directory = resolve(values["output-dir"]);
const receiptPath = resolve(directory, "receipt.json");
await mkdir(directory, { recursive: true });
let receipt;
const exists = await stat(receiptPath).then(
  () => true,
  (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  },
);
if (values.resume) {
  if (!exists) throw new Error("No receipt to resume");
  receipt = JSON.parse(await readFile(receiptPath, "utf8"));
} else {
  if (exists)
    throw new Error(
      "Receipt already exists; use --resume to query without resubmitting",
    );
  if (!values["base-url"] || !values.workflow || !values.prompt?.trim())
    throw new Error("--base-url, --workflow and --prompt are required");
  const source = await readFile(resolve(values.workflow), "utf8");
  if (Buffer.byteLength(source) > 64 * 1024)
    throw new Error("Workflow too large");
  const workflow = JSON.parse(source);
  for (const [id, type] of [
    ["29", "SaveImage"],
    ["49", "ResolutionSelector"],
    ["51", "CLIPTextEncode"],
    ["52", "EmptyLatentImage"],
    ["53", "KSampler"],
  ])
    if (workflow[id]?.class_type !== type)
      throw new Error(`Expected ${type} at node ${id}`);
  const megapixels = Number(values.megapixels);
  if (
    !Number.isFinite(megapixels) ||
    megapixels < 0.1 ||
    megapixels > 4 ||
    Buffer.byteLength(values.prompt) > 4_000
  )
    throw new Error("Smoke input out of bounds");
  const requestId = randomUUID();
  workflow["51"].inputs.text = values.prompt;
  workflow["49"].inputs.megapixels = megapixels;
  workflow["52"].inputs.batch_size = 1;
  workflow["29"].inputs.filename_prefix = `crewon-smoke-${requestId}`;
  await writeFile(
    resolve(directory, "request.json"),
    JSON.stringify(workflow, null, 2) + "\n",
    { flag: "wx" },
  );
  receipt = {
    schemaVersion: "crewon.comfyui-smoke.v0",
    baseUrl: values["base-url"],
    requestId,
    promptId: null,
    outputNodeId: "29",
    workflowDigest: `sha256:${createHash("sha256").update(JSON.stringify(workflow)).digest("hex")}`,
    state: "prepared",
    createdAt: new Date().toISOString(),
  };
}
const base = new URL(receipt.baseUrl);
if (
  base.protocol !== "https:" ||
  base.username ||
  base.password ||
  base.search ||
  base.hash ||
  base.pathname !== "/"
)
  throw new Error("A plain HTTPS service origin is required");
const timeoutSeconds = Number(values["timeout-seconds"]);
if (
  !Number.isFinite(timeoutSeconds) ||
  timeoutSeconds < 1 ||
  timeoutSeconds > 600
)
  throw new Error("Invalid timeout");
const endAt = Date.now() + timeoutSeconds * 1_000;
async function save() {
  receipt.updatedAt = new Date().toISOString();
  const temp = `${receiptPath}.tmp`;
  await writeFile(temp, JSON.stringify(receipt, null, 2) + "\n");
  await rename(temp, receiptPath);
}
async function boundedResponse(response, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("Response exceeds limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const client = new ComfyApi({
  request: async ({ method, path, body, signal }) => {
    const response = await fetch(new URL(path, base), {
      method,
      signal,
      redirect: "error",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await boundedResponse(response, 4 * 1024 * 1024);
    if (!response.ok) throw new Error(`ComfyUI HTTP ${response.status}`);
    return JSON.parse(data.toString("utf8"));
  },
});
if (!values.resume) {
  receipt.state = "submitting";
  await save();
  try {
    const submitted = await client.submit({
      workflow: JSON.parse(
        await readFile(resolve(directory, "request.json"), "utf8"),
      ),
      requestId: receipt.requestId,
      signal: AbortSignal.timeout(30_000),
    });
    receipt.promptId = submitted.promptId;
    receipt.state = "submitted";
    await save();
    console.log(
      JSON.stringify({ state: receipt.state, promptId: receipt.promptId }),
    );
  } catch (error) {
    receipt.state = "unknownOutcome";
    await save();
    throw error; // Never retry POST /prompt.
  }
}
while (Date.now() < endAt) {
  const observation = await client.observe({
    promptId: receipt.promptId ?? receipt.requestId,
    outputNodeId: receipt.outputNodeId,
    signal: AbortSignal.timeout(15_000),
  });
  const changed = receipt.state !== observation.status;
  receipt.state = observation.status;
  receipt.observation = observation;
  await save();
  if (changed)
    console.log(
      JSON.stringify({
        state: observation.status,
        promptId: receipt.promptId ?? receipt.requestId,
      }),
    );
  if (observation.status === "succeeded") {
    receipt.results = [];
    for (const [index, image] of observation.images.entries()) {
      const url = new URL(comfyImagePath(image), base);
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
      if (
        !response.ok ||
        response.headers.get("content-type")?.split(";")[0] !== "image/png"
      )
        throw new Error("Expected a PNG image");
      const bytes = await boundedResponse(response, 32 * 1024 * 1024);
      if (
        bytes.length < 24 ||
        bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
      )
        throw new Error("Invalid PNG");
      const path = resolve(directory, `image-${index + 1}.png`);
      await writeFile(path, bytes);
      receipt.results.push({
        path,
        url: url.href,
        bytes: bytes.length,
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    await save();
    console.log(
      JSON.stringify({
        state: "succeeded",
        receiptPath,
        results: receipt.results,
      }),
    );
    break;
  }
  if (
    observation.status === "failed" ||
    observation.status === "unknownOutcome"
  ) {
    process.exitCode = 2;
    break;
  }
  await delay(Math.min(3_000, Math.max(1, endAt - Date.now())));
}
if (receipt.state !== "succeeded") {
  console.log(
    JSON.stringify({
      state: receipt.state,
      receiptPath,
      next: "Resume using --resume; do not submit again",
    }),
  );
  process.exitCode = 2;
}
