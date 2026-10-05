import assert from "node:assert/strict";
import test from "node:test";
import {
  createExtensionRunBinding,
  extensionCanonicalJson,
  parseProjectStageRunAdmission,
  projectStageOperations,
} from "@crewon/domain";
import {
  InstalledPluginCreditQuoteAuthority,
  InstalledPluginTaskHttpAuthority,
} from "./installed-plugin-credit-quote-authority.ts";
import { InstalledProjectConversationCreditQuoteAuthority } from "./installed-project-conversation-credit-quote-authority.ts";
import {
  actor,
  binding as legacyBinding,
  digester,
  endpoint,
  quoteInput,
} from "./installed-plugin-task.test-support.ts";
const prompt = " 原话\n多行中文 ";
const { bindingDigest: _, ...legacyBody } = legacyBinding;
const binding = createExtensionRunBinding(
  { ...legacyBody, inputDigest: digester.sha256(prompt) },
  digester,
);
const stage = { kind: "discussion" as const },
  sources = { brief: null, outline: null };
const stageBody = {
  schemaVersion: "crewon.project-stage-run-admission.v1",
  actor,
  installation: {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    profileId: "fixture-profile",
    pluginId: binding.pluginId,
    publisherId: "fixture.publisher",
    version: "16.0.0",
    packageDigest: digester.sha256("package"),
    selectionRevision: 2,
  },
  runId: binding.runId,
  threadId: binding.threadId,
  projectId: "fixture-project",
  bindingId: "fixture-conversation",
  bindingRevision: 1,
  workspaceId: null,
  stage,
  sources,
  allowedOperations: projectStageOperations(stage),
  userContentDigest: binding.inputDigest,
  taskInputDigest: digester.sha256(
    extensionCanonicalJson({
      stage,
      sources,
      userContentDigest: binding.inputDigest,
    }),
  ),
  pluginTaskAdmissionDigest: digester.sha256("actual-named-admission"),
  extensionBindingDigest: binding.bindingDigest,
  requestDigest: quoteInput.commandRequestDigest,
  idempotencyKey: "original-key",
  createdAt: "2026-10-06T00:00:00.000Z",
};
function parsedStage(overrides: Partial<typeof stageBody> = {}) {
  const body = { ...stageBody, ...overrides };
  return parseProjectStageRunAdmission(
    { ...body, contentDigest: digester.sha256(extensionCanonicalJson(body)) },
    digester,
  );
}
const input = {
  actor,
  binding,
  input: { prompt },
  commandRequestDigest: quoteInput.commandRequestDigest,
  projectStageAdmission: parsedStage(),
};
const quoted = {
  poolId: "fixture-pool",
  priceRevision: 1,
  quotedCredits: "30",
};
test("explicit stage quote sends a versioned exact body and keeps the raw message digest; legacy canonical quote still rejects it", async () => {
  let calls = 0,
    checks = 0;
  const http = new InstalledPluginTaskHttpAuthority({
    timeoutMs: 1000,
    fetch: async (_url, init) => {
      calls++;
      assert.deepEqual(JSON.parse(String(init?.body)), {
        schemaVersion: "crewon.project-conversation-credit-quote.v1",
        ...input,
      });
      return Response.json(quoted);
    },
  });
  const deps = {
    endpoint,
    http,
    digester,
    currentSignal: () => new AbortController().signal,
    assertCurrent: async () => {
      checks++;
    },
  };
  const authority = new InstalledProjectConversationCreditQuoteAuthority(deps);
  assert.deepEqual(
    await authority.quoteProjectConversationGeneration(input),
    quoted,
  );
  assert.equal(calls, 1);
  assert.equal(checks, 2);
  const extraField = { ...input, projectStageAdmission: undefined };
  await assert.rejects(
    new InstalledPluginCreditQuoteAuthority(deps).quoteGeneration(extraField),
    /fields_invalid/,
  );
  const { projectStageAdmission: __, ...oldInput } = input;
  await assert.rejects(
    new InstalledPluginCreditQuoteAuthority(deps).quoteGeneration(oldInput),
    /extension_credit_quote_input_mismatch/,
  );
  assert.equal(calls, 1);
  await http.close();
});
test("qualified quotes reject mixed actors, scope/digests, unknown task fields and accessors before contacting price policy", async () => {
  let calls = 0,
    getters = 0;
  const http = new InstalledPluginTaskHttpAuthority({
    timeoutMs: 1000,
    fetch: async () => {
      calls++;
      return Response.json(quoted);
    },
  });
  const authority = new InstalledProjectConversationCreditQuoteAuthority({
    endpoint,
    http,
    digester,
    currentSignal: () => new AbortController().signal,
    assertCurrent: async () => {},
  });
  for (const value of [
    { ...input, actor: { ...actor, principalId: "foreign" } },
    { ...input, projectStageAdmission: parsedStage({ runId: "foreign-run" }) },
    {
      ...input,
      projectStageAdmission: parsedStage({
        requestDigest: digester.sha256("foreign-request"),
      }),
    },
    { ...input, input: { prompt: "different" } },
    { ...input, input: { prompt, stage: "discussion" } },
    {
      ...input,
      projectStageAdmission: {
        ...input.projectStageAdmission,
        contentDigest: digester.sha256("wrong"),
      },
    },
    { ...input, quotedCredits: "1" },
    Object.defineProperty({ ...input }, "input", {
      enumerable: true,
      get() {
        getters++;
        return input.input;
      },
    }),
  ])
    await assert.rejects(
      authority.quoteProjectConversationGeneration(value as typeof input),
    );
  assert.equal(calls, 0);
  assert.equal(getters, 0);
  await http.close();
});
test("withdrawal after the real quote response rejects rather than adopting a stale price", async () => {
  let checks = 0;
  const http = new InstalledPluginTaskHttpAuthority({
    timeoutMs: 1000,
    fetch: async () => Response.json(quoted),
  });
  const authority = new InstalledProjectConversationCreditQuoteAuthority({
    endpoint,
    http,
    digester,
    currentSignal: () => new AbortController().signal,
    assertCurrent: async () => {
      if (++checks === 2) throw new Error("withdrawn");
    },
  });
  await assert.rejects(
    authority.quoteProjectConversationGeneration(input),
    /withdrawn/,
  );
  await http.close();
});
