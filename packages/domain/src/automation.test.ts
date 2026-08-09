import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AutomationDefinitionError,
  MAX_AUTOMATION_INSTRUCTION_BYTES,
  createAutomationDefinition,
  parseAutomationDefinition,
  parseAutomationInvocationBinding,
  parseAutomationInvocationOrigin,
  renderAutomationInstruction,
  type CreateAutomationDefinitionInput,
} from "./automation.ts";

test("creates one exact immutable manual-only Automation definition", () => {
  const definition = createAutomationDefinition(definitionInput());

  assert.deepEqual(definition, definitionFixture());
  assert.deepEqual(parseAutomationDefinition(definition), definition);
  assert.match(
    renderAutomationInstruction(definition),
    /^<automation_run automation_id="automation-1" automation_revision="1">/u,
  );
});

test("rejects extra fields at every Automation definition boundary", () => {
  assert.throws(
    () =>
      createAutomationDefinition({
        ...definitionInput(),
        unexpected: true,
      } as never),
    hasCode("automation_definition_input_invalid"),
  );
  assert.throws(
    () =>
      createAutomationDefinition({
        ...definitionInput(),
        schedule: { ...definitionInput().schedule, unexpected: true },
      } as never),
    hasCode("automation_schedule_invalid"),
  );
  assert.throws(
    () =>
      parseAutomationDefinition({ ...definitionFixture(), unexpected: true }),
    hasCode("automation_state_invalid"),
  );
});

test("validates IDs, immutable state and strict UTC timestamps", () => {
  for (const input of [
    { ...definitionInput(), automationId: "automation/invalid" },
    { ...definitionInput(), agentVersionId: null },
    { ...definitionInput(), createdAt: "2026-02-30T00:00:00Z" },
    {
      ...definitionInput(),
      schedule: {
        ...definitionInput().schedule,
        nextRunAt: "2026-08-10T10:00:00+08:00",
      },
    },
  ]) {
    assert.throws(
      () => createAutomationDefinition(input as never),
      AutomationDefinitionError,
    );
  }
  assert.throws(
    () =>
      parseAutomationDefinition({
        ...definitionFixture(),
        executionMode: "scheduled",
      }),
    hasCode("automation_state_invalid"),
  );
  assert.throws(
    () =>
      parseAutomationDefinition({
        ...definitionFixture(),
        updatedAt: "2026-08-09T00:00:01Z",
      }),
    hasCode("automation_state_invalid"),
  );
});

test("enforces the rendered instruction UTF-8 boundary without truncation", () => {
  const oneByte = createAutomationDefinition({
    ...definitionInput(),
    prompt: "x",
  });
  const fixedBytes = byteLength(renderAutomationInstruction(oneByte)) - 1;
  const boundaryPrompt = "x".repeat(
    MAX_AUTOMATION_INSTRUCTION_BYTES - fixedBytes,
  );
  const boundary = createAutomationDefinition({
    ...definitionInput(),
    prompt: boundaryPrompt,
  });

  assert.equal(
    byteLength(renderAutomationInstruction(boundary)),
    MAX_AUTOMATION_INSTRUCTION_BYTES,
  );
  assert.equal(boundary.prompt, boundaryPrompt);
  assert.throws(
    () =>
      createAutomationDefinition({
        ...definitionInput(),
        prompt: `${boundaryPrompt}x`,
      }),
    hasCode("automation_instruction_too_large"),
  );
});

test("accounts for XML expansion and multibyte instruction content", () => {
  const escaped = createAutomationDefinition({
    ...definitionInput(),
    title: "&<>\"'",
    prompt: "'\"><&",
  });
  assert.equal(
    renderAutomationInstruction(escaped),
    [
      '<automation_run automation_id="automation-1" automation_revision="1">',
      "<title>&amp;&lt;&gt;&quot;&apos;</title>",
      "<task>&apos;&quot;&gt;&lt;&amp;</task>",
      "Record the result, next steps, and risks in this Automation result thread.",
      "</automation_run>",
    ].join("\n"),
  );
  assert.throws(
    () =>
      createAutomationDefinition({
        ...definitionInput(),
        prompt: "&<>\"'".repeat(400),
      }),
    hasCode("automation_instruction_too_large"),
  );

  const oneByte = createAutomationDefinition({
    ...definitionInput(),
    title: "每日总结",
    prompt: "x",
  });
  const fixedBytes = byteLength(renderAutomationInstruction(oneByte)) - 1;
  const emojiCount = Math.floor(
    (MAX_AUTOMATION_INSTRUCTION_BYTES - fixedBytes) / byteLength("🚀"),
  );
  const multibyte = createAutomationDefinition({
    ...definitionInput(),
    title: "每日总结",
    prompt: "🚀".repeat(emojiCount),
  });

  assert.ok(
    byteLength(renderAutomationInstruction(multibyte)) <=
      MAX_AUTOMATION_INSTRUCTION_BYTES,
  );
  assert.equal(multibyte.prompt, "🚀".repeat(emojiCount));
  assert.throws(
    () =>
      createAutomationDefinition({
        ...definitionInput(),
        title: "每日总结",
        prompt: "🚀".repeat(emojiCount + 1),
      }),
    hasCode("automation_instruction_too_large"),
  );
});

test("validates exact Automation invocation identity and digest provenance", () => {
  const binding = {
    automationId: "automation-1",
    automationRevision: 1 as const,
    definitionDigest: `sha256:${"a".repeat(64)}`,
    instructionDigest: `sha256:${"c".repeat(64)}`,
    invocationId: "invocation-1",
    runId: "run-1",
    routeDigest: `sha256:${"b".repeat(64)}`,
  };

  assert.deepEqual(parseAutomationInvocationBinding(binding), binding);
  for (const invalid of [
    { ...binding, automationId: "automation/invalid" },
    { ...binding, automationRevision: 2 },
    { ...binding, definitionDigest: `sha256:${"A".repeat(64)}` },
    { ...binding, instructionDigest: `sha256:${"C".repeat(64)}` },
    { ...binding, invocationId: "invocation invalid" },
    { ...binding, runId: "run invalid" },
    { ...binding, routeDigest: `sha256:${"B".repeat(64)}` },
    { ...binding, unexpected: true },
  ]) {
    assert.throws(
      () => parseAutomationInvocationBinding(invalid),
      hasCode("automation_invocation_binding_invalid"),
    );
  }

  const origin = { kind: "automation" as const, binding };
  assert.deepEqual(parseAutomationInvocationOrigin(origin), origin);
  for (const invalid of [
    { ...origin, kind: "human" },
    { ...origin, unexpected: true },
    { ...origin, binding: { ...binding, unexpected: true } },
  ]) {
    assert.throws(
      () => parseAutomationInvocationOrigin(invalid),
      hasCode("automation_invocation_origin_invalid"),
    );
  }
});

function definitionInput(): CreateAutomationDefinitionInput {
  return {
    automationId: "automation-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
    createdByActorId: "actor-1",
    threadId: "thread-1",
    title: "Daily summary",
    prompt: "Summarize the project.",
    agentVersionId: "agent-version-1",
    schedule: {
      scheduleType: "daily",
      nextRunAt: "2026-08-10T10:00:00Z",
      intervalSeconds: 86_400,
      time: "18:00",
      weekday: 0,
      timezone: "Asia/Shanghai",
    },
    createdAt: "2026-08-09T00:00:00Z",
  };
}

function definitionFixture() {
  return {
    schemaVersion: "crewon.automation.v0" as const,
    ...definitionInput(),
    executionMode: "manualOnly" as const,
    revision: 1 as const,
    updatedAt: definitionInput().createdAt,
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof AutomationDefinitionError && error.code === code;
}
