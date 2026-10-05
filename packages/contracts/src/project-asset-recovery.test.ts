import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProjectAssetRecoveryActionRequest as parseRequest,
  parseProjectAssetRecoveryActionResponse as parseResponse,
  projectAssetRecoveryCodec,
} from "./project-asset-recovery-contract.ts";
import {
  createPluginProjectAssetRecoveryClient,
  PROJECT_ASSET_RECOVERY_METHOD_ACTIONS,
} from "./project-asset-recovery-service.ts";
import {
  assetPublicFixture,
  assetPublicDigest as digest,
} from "./project-assets.test-support.ts";
const get = {
  action: PROJECT_ASSET_RECOVERY_METHOD_ACTIONS.getPending,
  input: {},
} as const;
function intent() {
  const f = assetPublicFixture();
  return {
    intentId: "intent",
    revision: 1,
    request: f.request,
    requestDigest: digest,
    phase: "pending",
    confirmed: null,
    refusalCode: null,
  };
}
function accepted() {
  return {
    ...intent(),
    phase: "accepted",
    revision: 2,
    confirmed: {
      kind: "save-content",
      assetId: "character",
      assetRevision: 1,
      contentRevision: 1,
      referenceRevision: null,
      requestDigest: digest,
      resultDigest: digest,
    },
  };
}
test("recovery routes have no caller project or identity selectors and remain independent from assets and text methods", () => {
  assert.deepEqual(parseRequest(get), get);
  const ack = {
    action: PROJECT_ASSET_RECOVERY_METHOD_ACTIONS.acknowledge,
    input: { intentId: "intent", expectedRevision: 2 },
  };
  assert.deepEqual(parseRequest(ack), ack);
  for (const input of [
    { projectId: "project" },
    { actorId: "actor" },
    { installation: {} },
  ])
    assert.throws(() => parseRequest({ ...get, input }));
  assert.throws(() =>
    parseRequest({ ...ack, input: { ...ack.input, projectId: "project" } }),
  );
  assert.throws(() =>
    parseRequest({
      action: "crewon.project-text-recovery.v1.getPending",
      input: {},
    }),
  );
  assert.throws(() =>
    parseRequest({ ...ack, input: { ...ack.input, intentId: "." } }),
  );
});
test("pending and accepted cold metadata retain the original project and request without becoming a new grant", () => {
  assert.deepEqual(parseResponse(get, { intent: null }), { intent: null });
  assert.deepEqual(parseResponse(get, { intent: intent() }), {
    intent: intent(),
  });
  assert.deepEqual(parseResponse(get, { intent: accepted() }), {
    intent: accepted(),
  });
  const otherProject = {
    ...intent(),
    request: {
      ...intent().request,
      input: { ...intent().request.input, projectId: "other" },
    },
  };
  assert.deepEqual(parseResponse(get, { intent: otherProject }), {
    intent: otherProject,
  });
  assert.throws(() =>
    parseResponse(get, { intent: { ...intent(), authority: true } }),
  );
  assert.throws(() =>
    parseResponse(get, {
      intent: {
        ...intent(),
        request: {
          action: "crewon.project-assets.v1.getAsset",
          input: { projectId: "project", assetId: "character" },
        },
      },
    }),
  );
});
test("confirmed summaries must match the original exact CAS, key-bound digest and five-action result variant", () => {
  const f = accepted();
  for (const confirmed of [
    { ...f.confirmed, assetRevision: 2 },
    { ...f.confirmed, contentRevision: null },
    { ...f.confirmed, referenceRevision: 1 },
    { ...f.confirmed, kind: "set-lock" },
    { ...f.confirmed, requestDigest: `sha256:${"b".repeat(64)}` },
    { ...f.confirmed, url: "https://image.example" },
  ])
    assert.throws(() => parseResponse(get, { intent: { ...f, confirmed } }));
  assert.throws(() =>
    parseResponse(get, {
      intent: { ...f, refusalCode: "project_asset_locked" },
    }),
  );
  assert.throws(() =>
    parseResponse(get, { intent: { ...intent(), confirmed: f.confirmed } }),
  );
});
test("ACK responses preserve exact intent and terminal revision and refusal never includes a fabricated receipt", () => {
  const ack = parseRequest({
    action: PROJECT_ASSET_RECOVERY_METHOD_ACTIONS.acknowledge,
    input: { intentId: "intent", expectedRevision: 2 },
  });
  for (const disposition of ["acknowledged", "replayed"])
    assert.deepEqual(
      parseResponse(ack, { intentId: "intent", revision: 3, disposition }),
      { intentId: "intent", revision: 3, disposition },
    );
  assert.throws(() =>
    parseResponse(ack, {
      intentId: "foreign",
      revision: 3,
      disposition: "acknowledged",
    }),
  );
  assert.throws(() =>
    parseResponse(ack, {
      intentId: "intent",
      revision: 4,
      disposition: "acknowledged",
    }),
  );
  const refused = {
    ...intent(),
    revision: 2,
    phase: "refused",
    refusalCode: "project_asset_locked",
  };
  assert.deepEqual(parseResponse(get, { intent: refused }), {
    intent: refused,
  });
  assert.throws(() =>
    parseResponse(get, {
      intent: { ...refused, refusalCode: "project_asset_store_unavailable" },
    }),
  );
  assert.throws(() =>
    parseResponse(get, {
      intent: { ...refused, confirmed: accepted().confirmed },
    }),
  );
});
test("recovery codec rejects accessors and unknown JSON without evaluating caller code", () => {
  let reads = 0;
  const input = Object.defineProperty({}, "projectId", {
    enumerable: true,
    get() {
      reads++;
      return "project";
    },
  });
  assert.throws(() => parseRequest({ ...get, input }));
  const output = Object.defineProperty({}, "intent", {
    enumerable: true,
    get() {
      reads++;
      return intent();
    },
  });
  assert.throws(() => parseResponse(get, output));
  assert.throws(() => parseRequest(Object.assign(Object.create({}), get)));
  assert.equal(reads, 0);
});
test("portable recovery client captures callbacks, preserves original errors and never retries or acknowledges automatically", async () => {
  const calls: unknown[] = [],
    services = {
      async invoke(...args: unknown[]) {
        calls.push(args);
        return { intent: intent() };
      },
    };
  const client = createPluginProjectAssetRecoveryClient(
    services,
    projectAssetRecoveryCodec,
  );
  services.invoke = async () => {
    throw new Error("replacement");
  };
  assert.deepEqual(await client.getPending({}), { intent: intent() });
  assert.deepEqual(calls, [[get.action, {}, {}]]);
  const original = new Error("unknown"),
    failed = createPluginProjectAssetRecoveryClient(
      {
        async invoke() {
          throw original;
        },
      },
      projectAssetRecoveryCodec,
    );
  await assert.rejects(failed.getPending({}), (error) => error === original);
});
test("portable recovery client cancels before IO and after a late reply without inventing terminal state", async () => {
  let calls = 0,
    reads = 0;
  const cancellation = new AbortController(),
    reason = new Error("abort");
  const client = createPluginProjectAssetRecoveryClient(
    {
      async invoke() {
        calls++;
        cancellation.abort(reason);
        return { intent: intent() };
      },
    },
    projectAssetRecoveryCodec,
  );
  await assert.rejects(
    client.getPending({}, { signal: cancellation.signal }),
    (error) => error === reason,
  );
  await assert.rejects(
    client.getPending({}, { signal: cancellation.signal }),
    (error) => error === reason,
  );
  const options = Object.defineProperty({}, "signal", {
    enumerable: true,
    get() {
      reads++;
      return undefined;
    },
  });
  await assert.rejects(client.getPending({}, options));
  assert.equal(calls, 1);
  assert.equal(reads, 0);
});
