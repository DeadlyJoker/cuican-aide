// Provider-format integration probe only. It does not create a project Run or a film.
import * as fs from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  NetworkEgressResolver,
  ProductionNetworkEgressPolicy,
} from "../../packages/media-runtime/src/network-egress.ts";
import { PinnedNodeHttpTransport } from "../../packages/media-runtime/src/pinned-node-http.ts";
import { renderComfyApiVideoGraph } from "../../examples/plugins/short-drama/build-support/comfyui-api-workflow-validation.mjs";
import { MediaReviewVideoInspector } from "../../apps/runtime-worker/src/media-review-video-inspector.ts";

const directory = dirname(fileURLToPath(import.meta.url));
const recordPath = join(directory, "comfy-video-protocol-probe-20261016.json");
const mode = process.argv[2];
if (!["submit", "observe"].includes(mode))
  throw new Error("Expected submit or observe");
const origin = new URL(
  (
    await fs.readFile(
      "/private/tmp/crewon-plugin-performance-20261015/saved-media-origin.txt",
      "utf8",
    )
  ).trim(),
);
if (
  origin.protocol !== "https:" ||
  origin.username ||
  origin.password ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash
)
  throw new Error("Invalid saved origin");
const digest = (b) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
const egress = new NetworkEgressResolver({
  policy: new ProductionNetworkEgressPolicy(),
});
const transport = new PinnedNodeHttpTransport();
let record;
try {
  record = JSON.parse(await fs.readFile(recordPath, "utf8"));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
async function save() {
  const temporary = recordPath + "." + randomUUID();
  const file = await fs.open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(record, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  await fs.rename(temporary, recordPath);
}
async function request(method, path, value, accept = "application/json") {
  const signal = AbortSignal.timeout(15_000);
  const endpoint = new URL(path, origin);
  if (endpoint.origin !== origin.origin)
    throw new Error("Foreign endpoint denied");
  const body =
    value === undefined ? undefined : Buffer.from(JSON.stringify(value));
  return transport.request(
    {
      method,
      target: await egress.resolve(
        {
          tenantId: "authorized-video-format-probe",
          scopeId: "saved-comfy-service",
          endpoint,
        },
        signal,
      ),
      headers: {
        "accept": accept,
        "accept-encoding": "identity",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
      maxRequestBytes: body?.byteLength ?? 0,
      maxResponseBytes: 1024 * 1024,
    },
    signal,
  );
}
async function json(method, path, value) {
  const response = await request(method, path, value);
  if (
    response.status !== 200 ||
    !/^application\/json(?:;|$)/iu.test(response.headers["content-type"] ?? "")
  )
    throw new Error(`Unexpected response status/type: ${response.status}`);
  return JSON.parse(Buffer.from(response.body).toString("utf8"));
}
if (!record) {
  if (mode !== "submit") throw new Error("No original probe exists");
  const objectInfo = {};
  for (const node of ["EmptyImage", "CreateVideo", "SaveVideo"])
    Object.assign(objectInfo, await json("GET", `/object_info/${node}`));
  const clientId = randomUUID(),
    prefix = `crewon-video-format-probe-${clientId}`;
  const graph = renderComfyApiVideoGraph(
    {
      1: {
        class_type: "EmptyImage",
        inputs: { width: 64, height: 64, batch_size: 2, color: 2306116 },
      },
      2: { class_type: "CreateVideo", inputs: { images: ["1", 0], fps: 24 } },
      3: {
        class_type: "SaveVideo",
        inputs: {
          "video": ["2", 0],
          "filename_prefix": "crewon-video-format-probe",
          "format": "mp4",
          "format.codec": "h264",
          "format.codec.encoding": "re-encode",
          "format.codec.encoding.crf": 18,
        },
      },
    },
    {
      outputNodeId: "3",
      prompt: null,
      outputPrefix: { nodeId: "3", input: "filename_prefix" },
      objectInfo,
    },
    { prompt: null, outputPrefix: prefix },
  );
  record = {
    schemaVersion: "crewon.comfy-video-format-probe.v1",
    createdAt: new Date().toISOString(),
    technicalOnly: true,
    narrativeGeneration: false,
    nativeProjectAcceptance: false,
    origin: origin.href,
    clientId,
    prefix,
    graph,
    graphDigest: digest(JSON.stringify(graph)),
    nodeSchemaDigests: Object.fromEntries(
      Object.entries(objectInfo).map(([k, v]) => [
        k,
        digest(JSON.stringify(v)),
      ]),
    ),
    phase: "prepared",
    submissionCount: 0,
  };
  // Persist before the single POST. A missing response is never permission to resubmit.
  await save();
} else if (record.origin !== origin.href)
  throw new Error("Saved probe origin changed");

try {
  if (mode === "submit") {
    if (record.submissionCount !== 0 || record.phase !== "prepared")
      throw new Error("Original probe already dispatched; observe it instead");
    record.phase = "dispatching";
    record.submissionCount = 1;
    record.dispatchedAt = new Date().toISOString();
    await save();
    const response = await json("POST", "/prompt", {
      prompt: record.graph,
      client_id: record.clientId,
    });
    record.submissionResponse = response;
    if (
      response.error ||
      (response.node_errors && Object.keys(response.node_errors).length)
    ) {
      record.phase = "rejected";
      await save();
      throw new Error("Comfy rejected the graph");
    }
    if (
      typeof response.prompt_id !== "string" ||
      !/^[a-f0-9-]{36}$/u.test(response.prompt_id)
    )
      throw new Error("Invalid returned prompt id");
    record.promptId = response.prompt_id;
    record.phase = "submitted";
    await save();
    console.log(
      JSON.stringify({
        phase: record.phase,
        promptId: record.promptId,
        submissionCount: record.submissionCount,
      }),
    );
  } else {
    if (!record.promptId)
      throw new Error("Original submission outcome unknown; POST is forbidden");
    if (record.phase === "verified") {
      console.log(
        JSON.stringify({
          phase: record.phase,
          promptId: record.promptId,
          replayed: true,
        }),
      );
      process.exit(0);
    }
    const history = await json("GET", `/history/${record.promptId}`);
    const item = history[record.promptId];
    if (!item?.status?.completed) {
      const queue = await json("GET", "/queue");
      const contains = (values) =>
        Array.isArray(values) &&
        values.some((row) => Array.isArray(row) && row[1] === record.promptId);
      record.phase =
        item?.status?.status_str === "error"
          ? "provider-failed"
          : contains(queue.queue_running)
            ? "running"
            : contains(queue.queue_pending)
              ? "queued"
              : "unknownOutcome";
      record.providerStatus = item?.status ?? null;
      await save();
      console.log(
        JSON.stringify({ phase: record.phase, promptId: record.promptId }),
      );
      process.exit(0);
    }
    record.providerStatus = item.status;
    record.outputNode = item.outputs?.["3"] ?? null;
    await save();
    if (item.status.status_str !== "success")
      throw new Error("Original provider job failed");
    const outputs = record.outputNode?.images ?? record.outputNode?.videos;
    if (!Array.isArray(outputs) || outputs.length !== 1)
      throw new Error("SaveVideo output shape needs explicit integration");
    const result = outputs[0];
    if (
      typeof result.filename !== "string" ||
      !result.filename.startsWith(record.prefix) ||
      !result.filename.endsWith(".mp4") ||
      /[\\/\u0000-\u001f\u007f]/u.test(result.filename) ||
      typeof result.subfolder !== "string" ||
      /[\\\u0000-\u001f\u007f]/u.test(result.subfolder) ||
      result.subfolder.startsWith("/") ||
      result.subfolder.split("/").some((s) => [".", ".."].includes(s)) ||
      result.type !== "output"
    )
      throw new Error("Invalid original video reference");
    const query = new URLSearchParams({
      filename: result.filename,
      subfolder: result.subfolder,
      type: "output",
    });
    const response = await request(
      "GET",
      `/view?${query}`,
      undefined,
      "video/mp4",
    );
    if (response.status !== 200) throw new Error("Video bytes unavailable");
    const bytes = Buffer.from(response.body),
      byteDigest = digest(bytes);
    const root =
      "/private/tmp/crewon-plugin-performance-20261015/video-format-probe-inspection";
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const inspector = new MediaReviewVideoInspector({
      ffmpegPath: "/opt/homebrew/bin/ffmpeg",
      ffprobePath: "/opt/homebrew/bin/ffprobe",
      tempRoot: await fs.realpath(root),
      maxInputBytes: 1024 * 1024,
    });
    try {
      const inspection = await inspector.inspect({
        bytes,
        expectedDigest: byteDigest,
        sampleTimesMs: [0, 41],
        signal: AbortSignal.timeout(120_000),
      });
      record.media = {
        contentType: response.headers["content-type"],
        byteLength: bytes.byteLength,
        byteDigest,
        metadata: inspection.metadata,
        fullDecode: inspection.fullDecode,
        frames: inspection.frames.map(({ bytes: _pixels, ...f }) => f),
      };
    } finally {
      await inspector.close();
    }
    const localPath = join(directory, "comfy-video-format-probe-20261016.mp4");
    await fs.writeFile(localPath, bytes, { flag: "wx", mode: 0o600 });
    record.phase = "verified";
    record.verifiedAt = new Date().toISOString();
    record.localPath = localPath;
    await save();
    console.log(
      JSON.stringify({
        phase: record.phase,
        promptId: record.promptId,
        media: record.media,
      }),
    );
  }
} catch (error) {
  record.lastError = {
    at: new Date().toISOString(),
    name: error.name,
    message: error.message,
  };
  if (record.phase === "dispatching") record.phase = "unknownOutcome";
  await save();
  throw error;
}
