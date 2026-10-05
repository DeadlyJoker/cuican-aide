import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  createPluginProjectTextRecoveryClient,
  PROJECT_TEXT_RECOVERY_REFUSAL_CODES,
} from "./plugin-project-text-recovery-service.ts";
import {
  parseProjectTextRecoveryActionRequest,
  parseProjectTextRecoveryActionResponse,
  projectTextRecoveryCodec,
} from "./plugin-project-text-recovery-contract.ts";
const digest = `sha256:${"a".repeat(64)}`;
const get = {
  action: "crewon.project-text-recovery.v1.getPending",
  input: { projectId: "project-1" },
} as const;
const original = {
  action: "crewon.project-texts.v1.saveOutlineCandidate",
  input: {
    projectId: "project-1",
    request: {
      expectedArtifactRevision: 0,
      briefRevision: 1,
      content: {
        title: "标题",
        logline: "一句话",
        synopsis: "剧情",
        episodes: [{ episodeId: "one", title: "一", summary: "简介" }],
      },
    },
    idempotencyKey: "once",
  },
} as const;
const common = {
  intentId: "intent-1",
  revision: 1,
  request: original,
  requestDigest: digest,
};
const pending = {
  intent: { ...common, phase: "pending", confirmed: null, refusalCode: null },
};
test("portable recovery protocol contains no imports or automatic replay", () => {
  const source = readFileSync(
    new URL("./plugin-project-text-recovery-service.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /^import\s/m);
});
test("strict requests admit only project read and original intent ACK locators", () => {
  assert.deepEqual(parseProjectTextRecoveryActionRequest(get), get);
  for (const input of [
    { ...get, input: { ...get.input, actorId: "forged" } },
    { ...get, action: "crewon.project-text-recovery.v1.stage" },
    { ...get, input: { projectId: ".." } },
    {
      action: "crewon.project-text-recovery.v1.acknowledge",
      input: {
        projectId: "project-1",
        intentId: "intent-1",
        expectedRevision: 0,
      },
    },
  ])
    assert.throws(() => parseProjectTextRecoveryActionRequest(input));
});
test("pending preserves one complete exact original request without private authority", () => {
  const result = parseProjectTextRecoveryActionResponse(get, pending);
  assert.deepEqual(result, pending);
  for (const value of [
    { intent: { ...pending.intent, actor: {} } },
    {
      intent: {
        ...pending.intent,
        request: {
          ...original,
          input: { ...original.input, projectId: "other" },
        },
      },
    },
    {
      intent: {
        ...pending.intent,
        request: { ...original, action: "crewon.project-texts.v1.getOutline" },
      },
    },
    { intent: { ...pending.intent, confirmed: {} } },
  ])
    assert.throws(() => parseProjectTextRecoveryActionResponse(get, value));
});
test("accepted requires the exact action kind and matching real receipt digests", () => {
  const confirmed = {
    kind: "save-outline",
    artifactId: "outline",
    artifactRevision: 1,
    contentRevision: 1,
    requestDigest: digest,
    resultDigest: digest,
  };
  const accepted = {
    intent: { ...common, phase: "accepted", confirmed, refusalCode: null },
  };
  assert.deepEqual(
    parseProjectTextRecoveryActionResponse(get, accepted),
    accepted,
  );
  for (const extra of [
    { kind: "set-lock" },
    { requestDigest: `sha256:${"b".repeat(64)}` },
    { contentRevision: null },
    { resultDigest: "sha256:bad" },
  ])
    assert.throws(() =>
      parseProjectTextRecoveryActionResponse(get, {
        intent: { ...accepted.intent, confirmed: { ...confirmed, ...extra } },
      }),
    );
});
test("refused accepts only proven business conflict codes", () => {
  for (const refusalCode of PROJECT_TEXT_RECOVERY_REFUSAL_CODES)
    assert.deepEqual(
      parseProjectTextRecoveryActionResponse(get, {
        intent: { ...common, phase: "refused", confirmed: null, refusalCode },
      }),
      { intent: { ...common, phase: "refused", confirmed: null, refusalCode } },
    );
  assert.throws(() =>
    parseProjectTextRecoveryActionResponse(get, {
      intent: {
        ...common,
        phase: "refused",
        confirmed: null,
        refusalCode: "network_timeout",
      },
    }),
  );
});
test("ACK reply binds original intent and exact next CAS revision", () => {
  const ack = {
    action: "crewon.project-text-recovery.v1.acknowledge",
    input: {
      projectId: "project-1",
      intentId: "intent-1",
      expectedRevision: 2,
    },
  } as const;
  for (const disposition of ["acknowledged", "replayed"])
    assert.deepEqual(
      parseProjectTextRecoveryActionResponse(ack, {
        intentId: "intent-1",
        revision: 3,
        disposition,
      }),
      { intentId: "intent-1", revision: 3, disposition },
    );
  for (const patch of [
    { intentId: "other" },
    { revision: 2 },
    { revision: 4 },
    { disposition: "accepted" },
  ])
    assert.throws(() =>
      parseProjectTextRecoveryActionResponse(ack, {
        intentId: "intent-1",
        revision: 3,
        disposition: "acknowledged",
        ...patch,
      }),
    );
});
test("client validates original input and reply, forwards signal once, never auto retries", async () => {
  const calls: unknown[] = [];
  const controller = new AbortController();
  const client = createPluginProjectTextRecoveryClient(
    {
      invoke: async (action, input, options) => {
        calls.push({ action, input, options });
        return pending;
      },
    },
    projectTextRecoveryCodec,
  );
  assert.deepEqual(
    await client.getPending(
      { projectId: "project-1" },
      { signal: controller.signal },
    ),
    pending,
  );
  assert.equal(calls.length, 1);
  await assert.rejects(client.getPending({ projectId: ".." }));
  assert.equal(calls.length, 1);
  controller.abort();
  await assert.rejects(
    client.getPending(
      { projectId: "project-1" },
      { signal: controller.signal },
    ),
    { name: "AbortError" },
  );
  assert.equal(calls.length, 1);
});
test("recovery enforces whole-response 60KiB and escaped original input bounds", () => {
  const content = {
    ...original.input.request.content,
    synopsis: "x".repeat(70 * 1024),
  };
  assert.throws(() =>
    parseProjectTextRecoveryActionResponse(get, {
      intent: {
        ...pending.intent,
        request: {
          ...original,
          input: {
            ...original.input,
            request: { ...original.input.request, content },
          },
        },
      },
    }),
  );
});
