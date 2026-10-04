import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PLUGIN_CREDIT_READ_RESPONSE_BYTES,
  type PluginCreditAccountView,
  type PluginCreditAccountsResponse,
  type PluginCreditEntriesResponse,
} from "@crewon/contracts";
import {
  ControlApiClient,
  ControlApiClientError,
  ControlApiProtocolError,
} from "./control-api-client.ts";
import type {
  PluginCreditAccountsClientQuery,
  PluginCreditEntriesClientQuery,
} from "./plugin-credit-control-client.ts";

const poolId = "本人/图像 😀?x=%&";
const account: PluginCreditAccountView = {
  poolId,
  revision: 4,
  availableCredits: "82",
  reservedCredits: "0",
  spentCredits: "18",
  grantedCredits: "100",
};
const granted = {
  ...account,
  revision: 2,
  availableCredits: "100",
  spentCredits: "0",
};
const reserved = {
  ...granted,
  revision: 3,
  availableCredits: "70",
  reservedCredits: "30",
};
function accounts(): PluginCreditAccountsResponse {
  return {
    schemaVersion: "crewon.plugin-credit-accounts.v1",
    state: "ready",
    accounts: [account],
    nextPoolId: null,
  };
}
function entries(): PluginCreditEntriesResponse {
  return {
    schemaVersion: "crewon.plugin-credit-entries.v1",
    state: "ready",
    account,
    entries: [
      { revision: 2, kind: "grant", credits: "100", account: granted },
      { revision: 3, kind: "reserve", credits: "30", account: reserved },
      { revision: 4, kind: "settle", credits: "18", account },
    ],
    nextRevision: null,
  };
}
function client(
  fetch: typeof globalThis.fetch,
  csrfToken: string | null = "csrf",
) {
  return new ControlApiClient({
    baseUrl: "https://control.example.test",
    accessToken: "current-user-token",
    origin: "https://ui.example.test",
    csrfToken,
    fetch,
  });
}
function protocol(code: string) {
  return (error: unknown) =>
    error instanceof ControlApiProtocolError && error.code === code;
}

test("the cached credit getter is lazy and uses only the original authenticated GET transport", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const controller = new AbortController();
  const api = client(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return Response.json(calls.length === 1 ? accounts() : entries());
  });
  assert.equal(api.pluginCredits, api.pluginCredits);
  assert.equal(calls.length, 0);
  assert.deepEqual(
    await api.pluginCredits.listAccounts({}, { signal: controller.signal }),
    accounts(),
  );
  assert.deepEqual(
    await api.pluginCredits.getEntries(
      { poolId },
      { signal: controller.signal },
    ),
    entries(),
  );
  assert.equal(
    calls[0]?.url,
    "https://control.example.test/api/v1/plugins/credits/accounts?limit=16",
  );
  assert.equal(
    calls[1]?.url,
    `https://control.example.test/api/v1/plugins/credits/entries?${new URLSearchParams({ poolId, afterRevision: "0", limit: "50" })}`,
  );
  for (const { url, init } of calls) {
    const headers = new Headers(init.headers);
    assert.equal(new URL(url).origin, "https://control.example.test");
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    assert.equal(init.credentials, "include");
    assert.equal(init.signal, controller.signal);
    assert.equal(init.redirect, "manual");
    assert.equal(headers.get("authorization"), "Bearer current-user-token");
    assert.equal(headers.get("origin"), "https://ui.example.test");
    assert.equal(headers.get("accept"), "application/json");
    for (const field of [
      "content-type",
      "x-csrf-token",
      "idempotency-key",
      "x-actor-id",
      "x-tenant-id",
      "x-principal-id",
    ])
      assert.equal(headers.get(field), null);
  }
});

test("read APIs need no CSRF and preserve exact 48-digit amounts without numeric conversion", async () => {
  const amount = "9".repeat(48);
  const large = {
    ...account,
    revision: 2,
    availableCredits: amount,
    spentCredits: "0",
    grantedCredits: amount,
  };
  const api = client(async (_url, init = {}) => {
    assert.equal(new Headers(init.headers).get("x-csrf-token"), null);
    return Response.json({
      ...entries(),
      account: large,
      entries: [
        { revision: 2, kind: "grant", credits: amount, account: large },
      ],
    });
  }, null);
  const response = await api.pluginCredits.getEntries({ poolId });
  assert.equal(response.account?.availableCredits, amount);
  assert.equal(response.entries[0]?.credits, amount);
  assert.equal(typeof response.entries[0]?.credits, "string");
});

test("opaque cursor and pool identities are query encoded, never treated as route segments", async () => {
  const calls: URL[] = [];
  const injectedPool = "../ui/mounts/x/actions?tenantId=other&poolId=foreign";
  const api = client(async (url) => {
    const target = new URL(String(url));
    calls.push(target);
    if (target.pathname.endsWith("/accounts"))
      return Response.json({ ...accounts(), accounts: [], nextPoolId: null });
    return Response.json({
      ...entries(),
      account: { ...account, poolId: injectedPool },
      entries: [],
    });
  });
  await api.pluginCredits.listAccounts({ afterPoolId: poolId, limit: 1 });
  await api.pluginCredits.getEntries({
    poolId: injectedPool,
    afterRevision: 4,
    limit: 1,
  });
  assert.equal(calls[0]?.pathname, "/api/v1/plugins/credits/accounts");
  assert.deepEqual(
    [...calls[0]!.searchParams],
    [
      ["afterPoolId", poolId],
      ["limit", "1"],
    ],
  );
  assert.equal(calls[1]?.pathname, "/api/v1/plugins/credits/entries");
  assert.deepEqual(
    [...calls[1]!.searchParams],
    [
      ["poolId", injectedPool],
      ["afterRevision", "4"],
      ["limit", "1"],
    ],
  );
});

test("unknown owner selectors, accessors and invalid bounded queries fail before fetch", async () => {
  let fetches = 0;
  let getters = 0;
  const api = client(async () => {
    fetches++;
    return Response.json(accounts());
  });
  const getter = Object.defineProperty({}, "poolId", {
    enumerable: true,
    get() {
      getters++;
      return poolId;
    },
  });
  const unknownGetter = Object.defineProperty({ poolId }, "principalId", {
    enumerable: true,
    get() {
      getters++;
      return "other";
    },
  });
  const entryInputs: unknown[] = [
    {},
    null,
    [],
    getter,
    unknownGetter,
    { poolId, tenantId: "other" },
    { poolId, principalId: "other" },
    { poolId, actorId: "other" },
    { poolId, spaceId: "other" },
    { poolId, profileId: "other" },
    { poolId, limit: 0 },
    { poolId, limit: 51 },
    { poolId, limit: "1" },
    { poolId, afterRevision: -1 },
    { poolId, afterRevision: 2_147_483_648 },
    { poolId: "x".repeat(129) },
    { poolId: "bad\u0000" },
    { poolId: "bad\ud800" },
    { poolId, [Symbol("owner")]: "other" },
    Object.create({ poolId }),
  ];
  for (const input of entryInputs)
    await assert.rejects(
      api.pluginCredits.getEntries(input as PluginCreditEntriesClientQuery),
      protocol("control_client_plugin_credit_query_invalid"),
    );
  const accountInputs: unknown[] = [
    { tenantId: "other" },
    { principalId: "other" },
    { poolId },
    { limit: 17 },
    { limit: 0 },
    { afterPoolId: "" },
    { afterPoolId: "x".repeat(129) },
    null,
    [],
    Object.defineProperty({}, "limit", {
      enumerable: true,
      get() {
        getters++;
        return 1;
      },
    }),
  ];
  for (const input of accountInputs)
    await assert.rejects(
      api.pluginCredits.listAccounts(input as PluginCreditAccountsClientQuery),
      protocol("control_client_plugin_credit_query_invalid"),
    );
  assert.equal(getters, 0);
  assert.equal(fetches, 0);
});

test("valid account and entry pages retain truthful cursors and historical balance snapshots", async () => {
  const response = {
    ...entries(),
    entries: [entries().entries[0]!],
    nextRevision: 2,
  };
  const api = client(async () => Response.json(response));
  assert.deepEqual(
    await api.pluginCredits.getEntries({ poolId, limit: 1 }),
    response,
  );
  assert.equal(response.entries[0]?.account.availableCredits, "100");
  assert.equal(response.account?.availableCredits, "82");
  const paged = client(async () =>
    Response.json({ ...accounts(), nextPoolId: poolId }),
  );
  assert.equal(
    (await paged.pluginCredits.listAccounts({ limit: 1 })).nextPoolId,
    poolId,
  );
});

test("foreign pools, dishonest cursors, money and public-field corruption are rejected", async () => {
  const invalidReplies: unknown[] = [
    { ...entries(), account: { ...account, poolId: "foreign" } },
    {
      ...entries(),
      entries: [
        {
          ...entries().entries[0]!,
          account: { ...granted, poolId: "foreign" },
        },
      ],
    },
    { ...entries(), nextRevision: 4 },
    { ...entries(), entries: [{ ...entries().entries[0]! }], nextRevision: 3 },
    { ...entries(), entries: [entries().entries[1]!, entries().entries[0]!] },
    { ...entries(), account: { ...account, availableCredits: "83" } },
    { ...entries(), account: { ...account, availableCredits: 82 } },
    { ...entries(), account: { ...account, tenantId: "private" } },
    {
      ...entries(),
      entries: [{ ...entries().entries[0]!, grantId: "private" }],
    },
    {
      ...entries(),
      entries: [
        {
          revision: 4,
          kind: "settle",
          credits: "18",
          account: { ...account, availableCredits: "81", spentCredits: "19" },
        },
      ],
    },
    { ...entries(), schemaVersion: "future" },
    { ...entries(), state: "unconfigured" },
  ];
  for (const reply of invalidReplies) {
    const api = client(async () => Response.json(reply));
    await assert.rejects(
      api.pluginCredits.getEntries({ poolId }),
      protocol("control_client_plugin_credit_response_invalid"),
    );
  }
  for (const reply of [
    { ...accounts(), nextPoolId: poolId },
    { ...accounts(), accounts: [account, account] },
    { ...accounts(), accounts: [{ ...account, principalId: "private" }] },
  ]) {
    const api = client(async () => Response.json(reply));
    await assert.rejects(
      api.pluginCredits.listAccounts(),
      protocol("control_client_plugin_credit_response_invalid"),
    );
  }
});

test("unconfigured and empty configured pages remain distinct and never invent a wallet", async () => {
  const unavailable = {
    schemaVersion: "crewon.plugin-credit-entries.v1",
    state: "unconfigured",
    account: null,
    entries: [],
    nextRevision: null,
  };
  assert.deepEqual(
    await client(async () =>
      Response.json(unavailable),
    ).pluginCredits.getEntries({ poolId }),
    unavailable,
  );
  const empty = { ...accounts(), accounts: [] };
  assert.deepEqual(
    await client(async () => Response.json(empty)).pluginCredits.listAccounts(),
    empty,
  );
  await assert.rejects(
    client(async () =>
      Response.json({ ...unavailable, state: "ready" }),
    ).pluginCredits.getEntries({ poolId }),
    protocol("control_client_plugin_credit_response_invalid"),
  );
});

test("successful responses accept exactly 64 KiB of actual JSON bytes and cancel excess declared or streamed bytes", async () => {
  const json = JSON.stringify(accounts());
  const exact =
    " ".repeat(
      MAX_PLUGIN_CREDIT_READ_RESPONSE_BYTES - Buffer.byteLength(json),
    ) + json;
  assert.deepEqual(
    await client(
      async () =>
        new Response(exact, {
          headers: { "content-type": "application/json" },
        }),
    ).pluginCredits.listAccounts(),
    accounts(),
  );
  for (const declared of [true, false]) {
    let cancelled = false;
    const api = client(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              if (!declared) {
                stream.enqueue(
                  new Uint8Array(MAX_PLUGIN_CREDIT_READ_RESPONSE_BYTES),
                );
                stream.enqueue(new Uint8Array(1));
              }
            },
            cancel() {
              cancelled = true;
            },
          }),
          {
            headers: {
              "content-type": "application/json",
              ...(declared
                ? {
                    "content-length": String(
                      MAX_PLUGIN_CREDIT_READ_RESPONSE_BYTES + 1,
                    ),
                  }
                : {}),
            },
          },
        ),
    );
    await assert.rejects(
      api.pluginCredits.listAccounts(),
      protocol("control_client_workspace_response_too_large"),
    );
    assert.equal(cancelled, true);
  }
});

test("pre-cancelled and late-cancelled requests cannot return a wallet or dispatch after cancellation", async () => {
  let calls = 0;
  const before = new AbortController();
  before.abort();
  const api = client(async () => {
    calls++;
    return Response.json(accounts());
  });
  await assert.rejects(
    api.pluginCredits.listAccounts({}, { signal: before.signal }),
    { name: "AbortError" },
  );
  await assert.rejects(
    api.pluginCredits.getEntries({ poolId }, { signal: before.signal }),
    { name: "AbortError" },
  );
  assert.equal(calls, 0);
  for (const lane of ["accounts", "entries"] as const) {
    const during = new AbortController();
    let enter!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const delayed = client(async (_url, init = {}) => {
      assert.equal(init.signal, during.signal);
      enter();
      await released;
      return Response.json(lane === "accounts" ? accounts() : entries());
    });
    const pending =
      lane === "accounts"
        ? delayed.pluginCredits.listAccounts({}, { signal: during.signal })
        : delayed.pluginCredits.getEntries(
            { poolId },
            { signal: during.signal },
          );
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await entered;
    during.abort();
    finish();
    await rejected;
  }
});

test("manual redirects and malformed or unexpected HTTP responses never produce a wallet", async () => {
  for (const reply of [
    new Response(null, {
      status: 302,
      headers: { location: "https://foreign.example.test/wallet" },
    }),
    new Response(null, { status: 204 }),
    Response.json(accounts(), { status: 201 }),
  ]) {
    const api = client(async (_url, init = {}) => {
      assert.equal(init.redirect, "manual");
      return reply;
    });
    await assert.rejects(
      api.pluginCredits.listAccounts(),
      protocol("control_api_error_envelope_invalid"),
    );
  }
  await assert.rejects(
    client(
      async () =>
        new Response("{}", { headers: { "content-type": "text/plain" } }),
    ).pluginCredits.listAccounts(),
    protocol("control_api_content_type_invalid"),
  );
  await assert.rejects(
    client(
      async () =>
        new Response("{", { headers: { "content-type": "application/json" } }),
    ).pluginCredits.listAccounts(),
    protocol("control_api_json_invalid"),
  );
});

test("public not-found and authorization error envelopes preserve HTTP status without leaking remote invalid bodies", async () => {
  for (const [status, category, code] of [
    [404, "notFound", "plugin_credit_account_not_found"],
    [403, "authorization", "plugin_credit_read_forbidden"],
  ] as const) {
    const api = client(async () =>
      Response.json(
        { error: { category, code, requestId: "request-public" } },
        { status },
      ),
    );
    await assert.rejects(
      api.pluginCredits.getEntries({ poolId }),
      (error: unknown) =>
        error instanceof ControlApiClientError &&
        error.status === status &&
        error.category === category &&
        error.code === code &&
        error.requestId === "request-public",
    );
  }
  const oversized = client(
    async () =>
      new Response(
        " ".repeat(MAX_PLUGIN_CREDIT_READ_RESPONSE_BYTES) +
          JSON.stringify({
            error: {
              category: "authorization",
              code: "private-detail",
              requestId: "request-public",
            },
          }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
  );
  await assert.rejects(
    oversized.pluginCredits.getEntries({ poolId }),
    protocol("control_api_error_envelope_invalid"),
  );
});
