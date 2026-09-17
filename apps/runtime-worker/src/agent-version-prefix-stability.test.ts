import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AgentSegmentContract,
  KernelAgentEvent,
} from "@crewon/agent-kernel";
import { DirectResponsesTransport } from "@crewon/agent-responses";
import {
  compileAgentVersion,
  createAgentVersionAsset,
  parseAgentVersionAsset,
  type AgentVersionSource,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import { SqliteRunStore } from "@crewon/store";
import { InMemoryToolBroker } from "@crewon/tool-broker";

import { ConfiguredAgentVersionRuntimeFactory } from "./configured-agent-version-runtime-factory.ts";
import { validateAgentVersionRuntime } from "./agent-version-runtime.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

for (const rejectCheckpoint of [false, true]) {
  test(`canonical AgentVersion retains HTTP bytes across SQLite reopen and ${rejectCheckpoint ? "rejected" : "accepted"} provider continuation`, async (context) => {
    const requests: string[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push(raw);
      if (
        rejectCheckpoint &&
        JSON.parse(raw).previous_response_id !== undefined
      ) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              code: "previous_response_not_found",
              param: "previous_response_id",
            },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const events = responseEvents(`response-${requests.length}`);
      // Deliver the output delta before completion, through the actual HTTP transport.
      response.write(events.slice(0, 2).join(""));
      setImmediate(() => response.end(events.slice(2).join("")));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    context.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}/v1/responses`;
    const directory = await mkdtemp(join(tmpdir(), "crewon-version-prefix-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "test.sqlite");
    let store = new SqliteRunStore(path);
    context.after(() => store.close());
    const source = versionSource();
    const compiled = compileAgentVersion(source, digester);
    const permuted = compileAgentVersion(
      reverseObjectKeys(source) as AgentVersionSource,
      digester,
    );
    const asset = createAgentVersionAsset({
      tenantId: "tenant-1",
      version: compiled,
      createdAt: "2026-09-15T00:00:00Z",
    });
    await store.registerAgentVersion(asset);

    const firstEvents = await sample(compiled, endpoint, contract());
    const checkpoint = firstEvents.find(
      (event) => event.type === "segment.checkpointed",
    );
    assert.ok(checkpoint?.type === "segment.checkpointed");
    await store.close();
    store = new SqliteRunStore(path);
    const loaded = await store.loadAgentVersion({
      tenantId: "tenant-1",
      agentVersionId: compiled.agentVersionId,
    });
    assert.deepEqual(loaded, asset);
    const reopened = parseAgentVersionAsset(loaded!, digester);
    for (const version of [permuted, reopened]) {
      assert.equal(version.contentDigest, compiled.contentDigest);
      await sample(version, endpoint, contract());
    }
    assert.equal(requests.length, 3);
    assert.equal(
      requests[1],
      requests[0],
      "object insertion order must not change the HTTP body",
    );
    assert.equal(
      requests[2],
      requests[0],
      "reopening a durable version must not change the HTTP body",
    );

    const resumedContract: AgentSegmentContract = {
      ...contract(),
      runId: "run-2",
      segmentId: "segment-2",
      history: [
        ...contract().history,
        { type: "message", role: "assistant", content: "answer\n  exact" },
        { type: "message", role: "user", content: "next\n  保留空格" },
      ],
      continuation: {
        kind: "providerCheckpoint",
        checkpoint: checkpoint.data.checkpoint,
        newHistoryStartIndex: 2,
      },
    };
    const historyBefore = JSON.stringify(resumedContract.history);
    const resumedEvents = await sample(reopened, endpoint, resumedContract);
    assert.equal(JSON.stringify(resumedContract.history), historyBefore);
    assert.equal(requests.length, rejectCheckpoint ? 5 : 4);
    const firstBody = JSON.parse(requests[0]);
    const deltaBody = JSON.parse(requests[3]);
    assert.equal(deltaBody.previous_response_id, "response-1");
    assert.deepEqual(deltaBody.input, [
      { role: "user", content: "next\n  保留空格" },
    ]);
    for (const raw of requests.slice(1)) {
      const body = JSON.parse(raw);
      const {
        input: _input,
        previous_response_id: _previous,
        ...configuration
      } = body;
      const { input: _firstInput, ...firstConfiguration } = firstBody;
      assert.equal(
        JSON.stringify(configuration),
        JSON.stringify(firstConfiguration),
      );
      assert.equal(JSON.stringify(body.tools), JSON.stringify(firstBody.tools));
      assert.equal(body.instructions, source.instructions);
    }
    if (rejectCheckpoint) {
      const replay = JSON.parse(requests[4]);
      assert.equal(replay.previous_response_id, undefined);
      assert.deepEqual(
        replay.input,
        resumedContract.history.map(({ type: _type, ...item }) => item),
      );
      assert.equal(
        resumedEvents.filter(
          (event) => event.type === "model.transport.fallback",
        ).length,
        1,
      );
    }
    await store.close();
  });
}

test("runtime catalog validation accepts JSON-equivalent definitions and rejects semantic or array-order drift", async () => {
  const source = versionSource();
  const first = source.tools[0];
  assert.ok(first.kind === "function");
  const tools = [
    { ...first, inputSchema: { ...first.inputSchema, default: -0 } },
    source.tools[1],
  ];
  const version = compileAgentVersion({ ...source, tools }, digester);
  const runtime = await createRuntime(
    version,
    "http://127.0.0.1:9/v1/responses",
  );
  try {
    validateAgentVersionRuntime(
      { ...runtime, toolRuntime: new InMemoryToolBroker(tools) },
      digester,
    );
    validateAgentVersionRuntime(
      {
        ...runtime,
        toolRuntime: new InMemoryToolBroker(
          reverseObjectKeys(tools) as typeof tools,
        ),
      },
      digester,
    );
    for (const altered of [
      tools.slice(0, 1),
      [...tools].reverse(),
      [...tools, { ...first, name: "extra" }],
      [{ ...first, description: "changed" }, tools[1]],
      [
        { ...first, inputSchema: { ...first.inputSchema, default: 1 } },
        tools[1],
      ],
      [
        {
          ...first,
          inputSchema: {
            ...first.inputSchema,
            required: ["mode", "path"],
            default: 0,
          },
        },
        tools[1],
      ],
    ]) {
      assert.throws(
        () =>
          validateAgentVersionRuntime(
            { ...runtime, toolRuntime: new InMemoryToolBroker(altered) },
            digester,
          ),
        { code: "agent_version_runtime_tools_mismatch" },
      );
    }
  } finally {
    await runtime.close?.();
  }
});

async function sample(
  version: CompiledAgentVersion,
  endpoint: string,
  segment: AgentSegmentContract,
): Promise<KernelAgentEvent[]> {
  const runtime = await createRuntime(version, endpoint);
  try {
    const events: KernelAgentEvent[] = [];
    for await (const event of runtime.kernel.runSegment(
      segment,
      new AbortController().signal,
    ))
      events.push(event);
    assert.equal(
      events
        .filter((event) => event.type === "model.output.delta")
        .map((event) => event.data.delta)
        .join(""),
      "answer\n  exact",
    );
    assert.equal(events.at(-1)?.type, "segment.completed");
    return events;
  } finally {
    await runtime.close?.();
  }
}

async function createRuntime(version: CompiledAgentVersion, endpoint: string) {
  const factory = new ConfiguredAgentVersionRuntimeFactory([
    {
      tenantId: "tenant-1",
      agentVersionId: version.agentVersionId,
      contentDigest: version.contentDigest,
      authorityId: "authority-1",
      workspaceBindingId: null,
      materializationDigest: `sha256:${"d".repeat(64)}`,
      executionAuthority: "crewonKernel",
      createTransport: () =>
        new DirectResponsesTransport({
          endpoint,
          model: version.model.modelId,
          storeResponses: true,
        }),
      createToolRuntime: () => new InMemoryToolBroker(version.tools),
    },
  ]);
  return factory.create({ tenantId: "tenant-1", version });
}

function contract(): AgentSegmentContract {
  return {
    schemaVersion: "crewon.agent-segment.v0",
    purpose: "agent",
    runId: "run-1",
    segmentId: "segment-1",
    attempt: 1,
    agentVersionId: "canonical-agent",
    policySnapshotId: "canonical-policy",
    collaborationMode: "default",
    allowedTools: null,
    history: [
      { type: "message", role: "user", content: "hello\n  exact input" },
    ],
    continuation: { kind: "manual" },
    budget: { maxOutputBytes: 32 * 1024 },
  };
}

function versionSource(): AgentVersionSource {
  return {
    schemaVersion: "crewon.agent-version-source.v0",
    agentVersionId: "canonical-agent",
    runtimeGeneration: "ts-v0",
    policySnapshotId: "canonical-policy",
    instructions: "Stable instructions\n  中文 🧰",
    model: {
      adapterName: "direct-responses",
      adapterVersion: "1",
      modelId: "fixture-model",
      contextWindowTokens: 128_000,
      autoCompactAtTokens: 96_000,
    },
    execution: { streamMaxRetries: 0, maxToolRounds: 16 },
    resources: { workspaceRequired: false, governedContextDigest: null },
    tools: [
      {
        schemaVersion: "crewon.tool-definition.v0",
        kind: "function",
        name: "z_read",
        description: "Read file",
        execution: "parallel",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Exact path" },
            mode: { enum: ["z", "a"], type: "string" },
          },
          required: ["path", "mode"],
          additionalProperties: false,
        },
      },
      {
        schemaVersion: "crewon.tool-definition.v0",
        kind: "custom",
        name: "a_patch",
        description: "Patch file",
        execution: "serial",
        inputFormat: "text",
      },
    ],
  };
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [key, reverseObjectKeys(item)]),
  );
}

function responseEvents(id: string): string[] {
  const message = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "answer\n  exact" }],
  };
  return [
    { type: "response.created", sequence_number: 0, response: { id } },
    {
      type: "response.output_text.delta",
      sequence_number: 1,
      delta: "answer\n  exact",
    },
    { type: "response.output_item.done", sequence_number: 2, item: message },
    {
      type: "response.completed",
      sequence_number: 3,
      response: { id, status: "completed", output: [message] },
    },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
}
