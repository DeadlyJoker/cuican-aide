import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { AgentKernelError, type KernelAgentEvent } from "@crewon/agent-kernel";
import { compileAgentVersion } from "@crewon/agent-version";

import { createAgentVersionRuntimeFactory } from "./runtime-binding-config.ts";

const gateway = "https://gateway.example/v1/responses";
const official = "https://api.openai.com/v1/responses";
type Profile = "standard" | "responsesLite";
type SequencePolicy = "required" | "whenPresent";

test("a portable Standard binding with optional sequences retains authoritative terminal identity", async () => {
  const fixture = await executionFixture({
    endpoint: gateway,
    requestProfile: "standard",
    sequencePolicy: "whenPresent",
    output: "empty",
    terminalId: "terminal-response",
  });
  await assertCompleted(fixture);
});

for (const boundary of [
  {
    name: "official endpoint",
    endpoint: official,
    sequencePolicy: "whenPresent",
  },
  {
    name: "required gateway sequences",
    endpoint: gateway,
    sequencePolicy: "required",
  },
] as const) {
  test(`Standard ${boundary.name} still rejects empty terminal output`, async () => {
    const fixture = await executionFixture({
      ...boundary,
      requestProfile: "standard",
      output: "empty",
    });
    await assertRejected(fixture, "responses_output_mismatch");
  });
}

test("portable Standard binding rejects conflicting nonempty terminal output", async () => {
  const fixture = await executionFixture({
    endpoint: gateway,
    requestProfile: "standard",
    sequencePolicy: "whenPresent",
    output: "conflicting",
  });
  await assertRejected(fixture, "responses_output_mismatch");
});

for (const endpoint of [official, gateway]) {
  test(`existing Lite binding retains empty-output compatibility and strict identity at ${endpoint}`, async () => {
    const config = {
      endpoint,
      requestProfile: "responsesLite",
      sequencePolicy: "whenPresent",
      output: "empty",
    } as const;
    await assertCompleted(await executionFixture(config));
    await assertRejected(
      await executionFixture({
        ...config,
        terminalId: "different-response",
      }),
      "responses_response_id_mismatch",
    );
  });
}

async function executionFixture(input: {
  endpoint: string;
  requestProfile: Profile;
  sequencePolicy: SequencePolicy;
  output: "empty" | "conflicting";
  terminalId?: string;
}) {
  const version = compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: "agent-profile",
      runtimeGeneration: "ts-v0",
      policySnapshotId: "policy",
      instructions: null,
      model: {
        adapterName: "direct-responses",
        adapterVersion:
          input.requestProfile === "standard" ? "1" : "1+responses-lite",
        modelId: "model",
        contextWindowTokens: 128000,
        autoCompactAtTokens: 96000,
      },
      execution: { streamMaxRetries: 0, maxToolRounds: 16 },
      resources: { workspaceRequired: false, governedContextDigest: null },
      tools: [],
    },
    {
      sha256: (value) =>
        `sha256:${createHash("sha256").update(value).digest("hex")}`,
    },
  );
  const methods: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const events: KernelAgentEvent[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    methods.push(init?.method ?? "GET");
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const wire = [
      { type: "response.created", response: { id: "response" } },
      { type: "response.output_text.delta", delta: "answer" },
      { type: "response.output_item.done", item: message("answer") },
      {
        type: "response.completed",
        response: {
          id: input.terminalId ?? "response",
          status: "completed",
          output: input.output === "empty" ? [] : [message("different output")],
        },
      },
    ]
      .map(
        (event, index) =>
          `data: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`,
      )
      .join("");
    return new Response(wire, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const runtime = await (async () => {
    try {
      return await createAgentVersionRuntimeFactory({
        config: {
          schemaVersion: "crewon.agent-version-runtime-bindings.v0",
          bindings: [
            {
              tenantId: "tenant",
              agentVersionId: version.agentVersionId,
              contentDigest: version.contentDigest,
              authorityId: "authority",
              workspaceBindingId: null,
              provider: {
                kind: "directResponses",
                endpoint: input.endpoint,
                apiKeyEnvironment: null,
                storeResponses: false,
                requestProfile: input.requestProfile,
                idleTimeoutMs: 60000,
                sequencePolicy: input.sequencePolicy,
              },
              mcpStdioConfigPath: null,
              deviceToolConfigPath: null,
              remoteMcpConfigPath: null,
            },
          ],
        },
        environment: {},
      }).create({ tenantId: "tenant", version });
    } finally {
      globalThis.fetch = originalFetch;
    }
  })();
  assert.deepEqual(runtime.kernel.modelIdentity, {
    adapterName: version.model.adapterName,
    adapterVersion: version.model.adapterVersion,
    modelId: version.model.modelId,
  });
  const execute = async () => {
    try {
      for await (const event of runtime.kernel.runSegment(
        {
          schemaVersion: "crewon.agent-segment.v0",
          purpose: "agent",
          runId: "run-binding-profile",
          segmentId: "segment",
          attempt: 1,
          agentVersionId: version.agentVersionId,
          policySnapshotId: version.policySnapshotId,
          collaborationMode: "default",
          allowedTools: null,
          history: [{ type: "message", role: "user", content: "hello" }],
          continuation: { kind: "manual" },
          budget: { maxOutputBytes: 8192 },
        },
        new AbortController().signal,
      ))
        events.push(event);
    } finally {
      await runtime.close?.();
    }
  };
  return {
    execute,
    methods,
    bodies,
    events,
    requestProfile: input.requestProfile,
  };
}

function message(text: string) {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
}

async function assertCompleted(
  fixture: Awaited<ReturnType<typeof executionFixture>>,
) {
  await fixture.execute();
  assertOnePost(fixture);
  assert.deepEqual(fixture.events.at(-1)?.data, { output: "answer" });
  assert.equal(
    fixture.events.filter((event) => event.type === "segment.completed").length,
    1,
  );
}

async function assertRejected(
  fixture: Awaited<ReturnType<typeof executionFixture>>,
  code: string,
) {
  await assert.rejects(
    fixture.execute,
    (error) =>
      error instanceof AgentKernelError &&
      error.code === code &&
      !error.retryable,
  );
  assertOnePost(fixture);
  assert.equal(
    fixture.events.some(
      (event) =>
        event.type === "segment.completed" || event.type === "usage.recorded",
    ),
    false,
  );
}

function assertOnePost(fixture: Awaited<ReturnType<typeof executionFixture>>) {
  assert.deepEqual(fixture.methods, ["POST"]);
  assert.equal(
    fixture.events.some(
      (event) =>
        event.type === "model.sampling.retry" ||
        event.type === "segment.provider_response_created" ||
        event.type === "segment.checkpointed",
    ),
    false,
  );
  const body = fixture.bodies[0]!;
  assert.equal(body.store, false);
  assert.equal(Object.hasOwn(body, "previous_response_id"), false);
  for (const key of ["reasoning", "parallel_tool_calls"])
    assert.equal(
      Object.hasOwn(body, key),
      fixture.requestProfile === "responsesLite",
    );
}
