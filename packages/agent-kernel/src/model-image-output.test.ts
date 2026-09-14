import assert from "node:assert/strict";
import test from "node:test";
import { CrewONAgentKernel } from "./crewon-agent-kernel.ts";
import {
  AgentKernelError,
  type KernelAgentEvent,
} from "./agent-kernel-port.ts";
import {
  ModelTransportError,
  type ModelTransportEvent,
  type ModelTransportPort,
} from "./model-transport-port.ts";

const generated = {
  type: "image.generated",
  itemId: "ig-1",
  artifactRef: "artifact-001",
  mimeType: "image/png",
  byteLength: 3_550_000,
} as const;
const contract = {
  schemaVersion: "crewon.agent-segment.v0",
  purpose: "agent",
  runId: "run-1",
  segmentId: "segment-1",
  attempt: 1,
  agentVersionId: "version-1",
  policySnapshotId: "policy-1",
  collaborationMode: "default",
  allowedTools: null,
  history: [{ type: "message", role: "user", content: "Generate an image." }],
  continuation: { kind: "manual" },
  budget: { maxOutputBytes: 1 },
} as const;

test("emits small image metadata without consuming the text budget or producing text deltas", async () => {
  const events = await run([
    { type: "image.progress", itemId: "ig-1", stage: "in_progress" },
    { type: "image.progress", itemId: "ig-1", stage: "generating" },
    { type: "image.progress", itemId: "ig-1", stage: "in_progress" },
    generated,
    generated,
    { type: "image.progress", itemId: "ig-1", stage: "completed" },
    { type: "completed", checkpoint: null },
  ]);
  assert.deepEqual(
    events.map(({ type }) => type),
    [
      "segment.started",
      "model.image.progress",
      "model.image.progress",
      "model.image.generated",
      "model.image.progress",
      "segment.completed",
    ],
  );
  assert.deepEqual(events.at(-1)?.data, { output: "" });
  assert.deepEqual(events[3]?.data, {
    itemId: "ig-1",
    artifactRef: "artifact-001",
    mimeType: "image/png",
    byteLength: 3_550_000,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(events)) < 2_000);
});

test("sampling retry preserves image deduplication and does not report discarded text", async () => {
  let calls = 0;
  const transport: ModelTransportPort = {
    adapterName: "image-fixture",
    adapterVersion: "1",
    modelId: "image-model",
    async *stream() {
      calls += 1;
      yield { type: "image.progress", itemId: "ig-1", stage: "generating" };
      yield generated;
      if (calls === 1)
        throw new ModelTransportError({
          category: "unavailable",
          code: "connection_reset",
          retryable: true,
        });
      yield { type: "completed", checkpoint: null };
    },
  };
  const events = await collect(
    new CrewONAgentKernel({
      transport,
      streamMaxRetries: 1,
      retryScheduler: { wait: async () => {} },
    }).runSegment(contract, new AbortController().signal),
  );
  assert.equal(calls, 2);
  assert.equal(
    events.filter(({ type }) => type === "model.image.generated").length,
    1,
  );
  assert.equal(
    events.filter(({ type }) => type === "model.image.progress").length,
    1,
  );
  const retry = events.find((event) => event.type === "model.sampling.retry");
  assert.equal(retry?.data.discardedOutput, false);
});

test("rejects image bytes, unsafe references, oversized images and conflicting artifacts without retry", async () => {
  for (const image of [
    { ...generated, base64: "aGVsbG8=" },
    { ...generated, artifactRef: "data:image/png;base64,aGVsbG8=" },
    { ...generated, byteLength: 8 * 1024 * 1024 + 1 },
  ]) {
    await assert.rejects(
      run([image as ModelTransportEvent]),
      (error) =>
        error instanceof AgentKernelError &&
        error.code === "model_image_metadata_invalid" &&
        error.retryable === false,
    );
  }
  await assert.rejects(
    run([generated, { ...generated, artifactRef: "artifact-002" }]),
    (error) =>
      error instanceof AgentKernelError &&
      error.code === "model_image_output_conflict" &&
      error.retryable === false,
  );
  await assert.rejects(
    run(
      Array.from({ length: 17 }, (_, i) => ({
        ...generated,
        itemId: `ig-${i}`,
      })),
    ),
    (error) =>
      error instanceof AgentKernelError &&
      error.code === "model_image_output_limit",
  );
});

test("compaction cannot inject image generation output", async () => {
  const transport: ModelTransportPort = {
    adapterName: "image-fixture",
    adapterVersion: "1",
    modelId: "image-model",
    async *stream() {
      yield generated;
    },
  };
  await assert.rejects(
    collect(
      new CrewONAgentKernel({ transport }).runSegment(
        { ...contract, purpose: "compaction" },
        new AbortController().signal,
      ),
    ),
    (error) =>
      error instanceof AgentKernelError &&
      error.code === "compaction_image_output_unsupported",
  );
});

async function run(
  events: readonly ModelTransportEvent[],
): Promise<KernelAgentEvent[]> {
  const transport: ModelTransportPort = {
    adapterName: "image-fixture",
    adapterVersion: "1",
    modelId: "image-model",
    async *stream() {
      yield* events;
    },
  };
  return collect(
    new CrewONAgentKernel({ transport, streamMaxRetries: 0 }).runSegment(
      contract,
      new AbortController().signal,
    ),
  );
}
async function collect(
  source: AsyncIterable<KernelAgentEvent>,
): Promise<KernelAgentEvent[]> {
  const events: KernelAgentEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}
