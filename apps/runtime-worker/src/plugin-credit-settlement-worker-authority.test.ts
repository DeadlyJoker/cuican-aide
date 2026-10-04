import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createPluginCreditSettlementWorkerAuthority } from "./plugins/plugin-credit-settlement-worker-authority.ts";
import {
  deferred,
  financialAuthorization,
  financialConfig,
  financialDecision,
  financialDigest,
  financialEnvironment,
  financialEvidence,
  financialResponse,
  financialScope,
} from "./plugin-credit-settlement-worker.test-support.ts";

test("financial authority facade has frozen own data methods and preserves the private HTTP receiver", async () => {
  const authority = createPluginCreditSettlementWorkerAuthority(
    financialConfig(),
    async () => financialResponse(financialAuthorization()),
  );
  assert.equal(Object.getPrototypeOf(authority), Object.prototype);
  assert.equal(Object.isFrozen(authority), true);
  assert.deepEqual(Object.keys(authority).sort(), [
    "assertCurrent",
    "authorize",
    "close",
    "decide",
  ]);
  for (const name of [
    "authorize",
    "assertCurrent",
    "decide",
    "close",
  ] as const) {
    const field = Object.getOwnPropertyDescriptor(authority, name);
    assert.ok(field && Object.hasOwn(field, "value"));
    assert.equal(typeof field.value, "function");
    assert.equal(field.enumerable, true);
    assert.equal(field.writable, false);
    assert.equal(field.configurable, false);
  }
  const { authorize, assertCurrent, close } = authority;
  assert.throws(assertCurrent, /not_authorized/u);
  await authorize(new AbortController().signal);
  assertCurrent();
  await close();
  assert.throws(assertCurrent, /closed/u);
});

test("financial authorization binds exact scope/authority and its decision request retains original evidence", async () => {
  const requests: { url: string; payload: unknown }[] = [];
  const owner = createPluginCreditSettlementWorkerAuthority(
    financialConfig(),
    async (url, init) => {
      const actual = String(url);
      requests.push({ url: actual, payload: JSON.parse(String(init?.body)) });
      assert.equal(init?.redirect, "error");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.cache, "no-store");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${actual.endsWith("authorize") ? financialEnvironment.NAMED_FINANCIAL_AUTHORIZATION_TOKEN : financialEnvironment.NAMED_FINANCIAL_DECISION_TOKEN}`,
      );
      return financialResponse(
        actual.endsWith("authorize")
          ? financialAuthorization()
          : financialDecision(),
      );
    },
  );
  const signal = new AbortController().signal;
  try {
    await assert.rejects(
      owner.decide({ evidence: financialEvidence(), signal }),
      /not_authorized/u,
    );
    assert.equal(requests.length, 0);
    await owner.authorize(signal);
    owner.assertCurrent();
    assert.deepEqual(
      await owner.decide({ evidence: financialEvidence(), signal }),
      financialDecision(),
    );
    assert.deepEqual(requests[0]?.payload, {
      schemaVersion: "crewon.plugin-credit-settlement-authorization.v1",
      scope: financialScope,
      authorityId: "financial-test-authority",
      authorityRevision: "financial-test-policy-1",
    });
    assert.deepEqual(requests[1]?.payload, {
      schemaVersion: "crewon.plugin-credit-settlement-decision-request.v1",
      scope: financialScope,
      authorityId: "financial-test-authority",
      authorityRevision: "financial-test-policy-1",
      authorityEpoch: "financial-test-epoch-1",
      evidence: financialEvidence(),
    });
  } finally {
    await owner.close();
  }
});

for (const outcome of [
  { kind: "settle", actualCredits: "0" },
  { kind: "release" },
  { kind: "hold" },
] as const) {
  test(`financial ${outcome.kind} is an explicit bounded authority outcome`, async () => {
    const owner = createPluginCreditSettlementWorkerAuthority(
      financialConfig(),
      async (url) =>
        financialResponse(
          String(url).endsWith("authorize")
            ? financialAuthorization()
            : financialDecision(outcome),
        ),
    );
    const signal = new AbortController().signal;
    try {
      await owner.authorize(signal);
      assert.deepEqual(
        await owner.decide({ evidence: financialEvidence(), signal }),
        outcome.kind === "hold" ? { kind: "hold" } : financialDecision(outcome),
      );
    } finally {
      await owner.close();
    }
  });
}

test("deny and epoch change permanently withdraw an owner; explicit new owner can authorize the new epoch", async () => {
  let epoch = "financial-test-epoch-1",
    count = 0;
  const fetch: typeof globalThis.fetch = async () => {
    count += 1;
    return financialResponse(financialAuthorization({ authorityEpoch: epoch }));
  };
  const owner = createPluginCreditSettlementWorkerAuthority(
    financialConfig(),
    fetch,
  );
  const signal = new AbortController().signal;
  await owner.authorize(signal);
  epoch = "financial-test-epoch-2";
  await assert.rejects(owner.authorize(signal), /epoch_changed/u);
  assert.throws(() => owner.assertCurrent(), /epoch_changed/u);
  await assert.rejects(owner.authorize(signal), /epoch_changed/u);
  assert.equal(count, 2);
  await owner.close();
  const replacement = createPluginCreditSettlementWorkerAuthority(
    financialConfig(),
    fetch,
  );
  await replacement.authorize(signal);
  replacement.assertCurrent();
  await replacement.close();
  const denied = createPluginCreditSettlementWorkerAuthority(
    financialConfig(),
    async () =>
      financialResponse({
        schemaVersion: "crewon.plugin-credit-settlement-authorization.v1",
        scope: financialScope,
        authorityId: "financial-test-authority",
        authorityRevision: "financial-test-policy-1",
        outcome: "deny",
      }),
  );
  await assert.rejects(denied.authorize(signal), /denied/u);
  assert.throws(() => denied.assertCurrent(), /denied/u);
  await denied.close();
});

for (const [name, patch] of [
  ["foreign scope", { scope: { ...financialScope, profileId: "foreign" } }],
  ["foreign authority", { authorityId: "foreign" }],
  ["foreign revision", { authorityRevision: "foreign" }],
  ["missing epoch", { authorityEpoch: undefined }],
  ["expired grant", { expiresAt: "2026-01-01T00:00:00.000Z" }],
  ["unbounded age", { expiresAt: "2099-01-01T00:00:00.000Z" }],
  ["non-UTC deadline", { expiresAt: "2099-01-01T01:00:00+01:00" }],
  ["extra permission", { execute: "allow" }],
] as const) {
  test(`financial authorization rejects ${name}`, async () => {
    const owner = createPluginCreditSettlementWorkerAuthority(
      financialConfig(),
      async () => financialResponse(financialAuthorization(patch)),
    );
    await assert.rejects(owner.authorize(new AbortController().signal));
    assert.throws(() => owner.assertCurrent());
    await owner.close();
  });
}

for (const [name, make] of [
  [
    "another evidence",
    () =>
      financialDecision(undefined, {
        evidenceDigest: `sha256:${"b".repeat(64)}`,
      }),
  ],
  [
    "another issuer",
    () => financialDecision(undefined, { authorityId: "foreign" }),
  ],
  [
    "another policy",
    () => financialDecision(undefined, { authorityRevision: "foreign" }),
  ],
  [
    "above quote",
    () => financialDecision({ kind: "settle", actualCredits: "31" }),
  ],
  [
    "negative",
    () => financialDecision({ kind: "settle", actualCredits: "-1" }),
  ],
  [
    "decimal",
    () => financialDecision({ kind: "settle", actualCredits: "1.5" }),
  ],
  [
    "number",
    () => financialDecision({ kind: "settle", actualCredits: 1 } as never),
  ],
  [
    "release with amount",
    () => financialDecision({ kind: "release", actualCredits: "0" } as never),
  ],
  ["bare hold", () => ({ kind: "hold" })],
] as const) {
  test(`financial decision rejects ${name} and revokes the deployment fence`, async () => {
    const owner = createPluginCreditSettlementWorkerAuthority(
      financialConfig(),
      async (url) =>
        financialResponse(
          String(url).endsWith("authorize") ? financialAuthorization() : make(),
        ),
    );
    const signal = new AbortController().signal;
    await owner.authorize(signal);
    await assert.rejects(
      owner.decide({ evidence: financialEvidence(), signal }),
    );
    assert.throws(() => owner.assertCurrent());
    await owner.close();
  });
}

test("UTC deadline expiry remains revoked when wall clock moves backwards", async (t) => {
  const wall = Date.now(),
    deadline = wall + 200;
  const owner = createPluginCreditSettlementWorkerAuthority(
    financialConfig(),
    async () =>
      financialResponse(
        financialAuthorization({ expiresAt: new Date(deadline).toISOString() }),
      ),
  );
  await owner.authorize(new AbortController().signal);
  t.mock.method(Date, "now", () => wall - 60_000);
  await delay(250);
  assert.throws(() => owner.assertCurrent(), /authorization_expired/u);
  await owner.close();
});

test("refresh crossing the previous grant deadline permanently withdraws the owner and waits for the actual response", async () => {
  const entered = deferred<void>(),
    response = deferred<Response>();
  let count = 0,
    finished = false;
  let httpSignal!: AbortSignal;
  const owner = createPluginCreditSettlementWorkerAuthority(
    financialConfig(),
    async (_url, init) => {
      count += 1;
      if (count === 1)
        return financialResponse(
          financialAuthorization({
            expiresAt: new Date(Date.now() + 200).toISOString(),
          }),
        );
      httpSignal = init!.signal!;
      entered.resolve();
      return response.promise;
    },
  );
  const signal = new AbortController().signal;
  try {
    await owner.authorize(signal);
    const pending = owner.authorize(signal);
    const rejected = assert.rejects(pending, /authorization_expired/u);
    void pending.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    await entered.promise;
    assert.throws(() => owner.assertCurrent(), /not_authorized/u);
    await delay(250);
    assert.equal(httpSignal.aborted, true);
    assert.equal(finished, false);
    assert.throws(() => owner.assertCurrent(), /authorization_expired/u);
    await assert.rejects(owner.authorize(signal), /authorization_expired/u);
    assert.equal(count, 2);
    response.resolve(financialResponse(financialAuthorization()));
    await rejected;
    assert.equal(finished, true);
    assert.throws(() => owner.assertCurrent(), /authorization_expired/u);
  } finally {
    response.resolve(financialResponse(financialAuthorization()));
    await owner.close();
  }
});

test("refresh cannot replace a UTC-expired grant before its expiry timer runs", async (t) => {
  const wall = Date.now(),
    deadline = wall + 2000;
  let count = 0;
  const owner = createPluginCreditSettlementWorkerAuthority(
    financialConfig(),
    async () => {
      count += 1;
      if (count === 2) t.mock.method(Date, "now", () => deadline + 1);
      return financialResponse(
        financialAuthorization({
          expiresAt: new Date(
            count === 1 ? deadline : deadline + 1000,
          ).toISOString(),
        }),
      );
    },
  );
  const signal = new AbortController().signal;
  try {
    await owner.authorize(signal);
    await assert.rejects(owner.authorize(signal), /authorization_expired/u);
    assert.throws(() => owner.assertCurrent(), /authorization_expired/u);
    await assert.rejects(owner.authorize(signal), /authorization_expired/u);
    assert.equal(count, 2);
  } finally {
    await owner.close();
  }
});

test("timeout aborts and revokes but the physical fetch promise and close remain pending until actual completion", async () => {
  const entered = deferred<void>(),
    response = deferred<Response>();
  let httpSignal!: AbortSignal;
  const owner = createPluginCreditSettlementWorkerAuthority(
    financialConfig({ timeoutMs: 5 }),
    async (_url, init) => {
      httpSignal = init!.signal!;
      entered.resolve();
      return response.promise;
    },
  );
  let finished = false;
  const pending = owner.authorize(new AbortController().signal);
  const observed = pending.catch(() => {
    finished = true;
  });
  await entered.promise;
  await delay(15);
  assert.equal(httpSignal.aborted, true);
  assert.equal(finished, false);
  assert.throws(() => owner.assertCurrent(), /timeout/u);
  await assert.rejects(
    owner.authorize(new AbortController().signal),
    /timeout/u,
  );
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  response.resolve(financialResponse(financialAuthorization()));
  await observed;
  await closing;
  assert.equal(finished, true);
  assert.equal(closed, true);
});

test("physical body cancellation is joined after caller abort and no slot admits another request", async () => {
  const entered = deferred<void>(),
    canceled = deferred<void>(),
    cancelFinished = deferred<void>();
  const owner = createPluginCreditSettlementWorkerAuthority(
    financialConfig(),
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            entered.resolve();
          },
          async cancel() {
            canceled.resolve();
            await cancelFinished.promise;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  const caller = new AbortController();
  const pending = owner.authorize(caller.signal);
  const rejected = assert.rejects(pending);
  await entered.promise;
  await assert.rejects(owner.authorize(new AbortController().signal), /busy/u);
  caller.abort();
  await canceled.promise;
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  cancelFinished.resolve();
  await rejected;
  await closing;
  assert.equal(closed, true);
});

test("reentrant close during fetch withdraws synchronously and joins the registered physical request", async () => {
  const response = deferred<Response>();
  let closing!: Promise<void>,
    closed = false;
  const owner = createPluginCreditSettlementWorkerAuthority(
    financialConfig(),
    async () => {
      closing = owner.close().then(() => {
        closed = true;
      });
      return response.promise;
    },
  );
  const pending = owner.authorize(new AbortController().signal);
  const rejected = assert.rejects(pending);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert.throws(() => owner.assertCurrent(), /closed/u);
  response.resolve(financialResponse(financialAuthorization()));
  await rejected;
  await closing;
  assert.equal(closed, true);
});

for (const [name, response] of [
  ["HTTP failure", () => financialResponse({}, { status: 503 })],
  [
    "wrong media",
    () => new Response("{}", { headers: { "content-type": "text/plain" } }),
  ],
  [
    "oversized declaration",
    () => financialResponse({}, { headers: { "content-length": "16385" } }),
  ],
  ["oversized stream", () => financialResponse({ data: "x".repeat(16385) })],
  [
    "invalid UTF-8",
    () =>
      new Response(new Uint8Array([0xff]), {
        headers: { "content-type": "application/json" },
      }),
  ],
] as const) {
  test(`financial HTTP rejects ${name}`, async () => {
    const owner = createPluginCreditSettlementWorkerAuthority(
      financialConfig(),
      async () => response(),
    );
    await assert.rejects(owner.authorize(new AbortController().signal));
    assert.throws(() => owner.assertCurrent());
    await owner.close();
  });
}

test("transport error text and credential data are not exposed; evidence getters are never invoked", async () => {
  const owner = createPluginCreditSettlementWorkerAuthority(
    financialConfig(),
    async () => {
      throw new Error(financialEnvironment.NAMED_FINANCIAL_DECISION_TOKEN);
    },
  );
  await assert.rejects(
    owner.authorize(new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "plugin_credit_settlement_worker_authority_unavailable",
      );
      assert.equal("cause" in error, false);
      return true;
    },
  );
  await owner.close();
  let calls = 0;
  const configured = createPluginCreditSettlementWorkerAuthority(
    financialConfig(),
    async () => financialResponse(financialAuthorization()),
  );
  await configured.authorize(new AbortController().signal);
  const getter = {
    ...financialEvidence(),
    get evidenceDigest() {
      calls += 1;
      return financialDigest;
    },
  };
  await assert.rejects(
    configured.decide({
      evidence: getter,
      signal: new AbortController().signal,
    }),
  );
  assert.equal(calls, 0);
  await configured.close();
});
