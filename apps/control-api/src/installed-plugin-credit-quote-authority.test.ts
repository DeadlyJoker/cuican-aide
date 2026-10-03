import assert from "node:assert/strict";
import test from "node:test";
import {
  InstalledPluginCreditQuoteAuthority,
  InstalledPluginTaskHttpAuthority,
} from "./installed-plugin-credit-quote-authority.ts";
import {
  deferred,
  digester,
  endpoint,
  quoteInput,
} from "./installed-plugin-task.test-support.ts";

// Explicit authority/amount fixtures, not a real tariff, wallet balance or funding source.
const quoted = {
  poolId: "fixture-personal-pool",
  priceRevision: 7,
  quotedCredits: "30",
};
function response(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}
test("quotes only the verified binding/input and current actual actor; preserves authority's exact amount and revision", async () => {
  let currentChecks = 0,
    calls = 0;
  const http = new InstalledPluginTaskHttpAuthority({
    timeoutMs: 1000,
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, endpoint.url);
      assert.equal(options?.redirect, "error");
      assert.equal(options?.cache, "no-store");
      assert.deepEqual(JSON.parse(options!.body as string), quoteInput);
      return response(quoted);
    },
  });
  const authority = new InstalledPluginCreditQuoteAuthority({
    endpoint,
    http,
    digester,
    currentSignal: () => new AbortController().signal,
    assertCurrent: async () => {
      currentChecks++;
    },
  });
  assert.deepEqual(await authority.quoteGeneration(quoteInput), quoted);
  assert.equal(calls, 1);
  assert.equal(currentChecks, 2);
  await http.close();
});
test("rejects caller price/payer, getters, a different body and foreign actor before contacting authority", async () => {
  let calls = 0,
    getters = 0;
  const http = new InstalledPluginTaskHttpAuthority({
    timeoutMs: 1000,
    fetch: async () => {
      calls++;
      return response(quoted);
    },
  });
  const authority = new InstalledPluginCreditQuoteAuthority({
    endpoint,
    http,
    digester,
    currentSignal: () => new AbortController().signal,
    assertCurrent: async () => {},
  });
  for (const input of [
    { ...quoteInput, quotedCredits: "1" },
    { ...quoteInput, principalId: "payer" },
    { ...quoteInput, input: { prompt: "drift" } },
    { ...quoteInput, actor: { ...quoteInput.actor, tenantId: "foreign" } },
    Object.defineProperty({ ...quoteInput }, "input", {
      enumerable: true,
      get() {
        getters++;
        return quoteInput.input;
      },
    }),
  ])
    await assert.rejects(authority.quoteGeneration(input));
  assert.equal(calls, 0);
  assert.equal(getters, 0);
  await http.close();
});
test("invalid/unavailable quotations never fall back to a default or free price", async () => {
  for (const result of [
    null,
    { ...quoted, priceRevision: 0 },
    { ...quoted, quotedCredits: "0" },
    { ...quoted, quotedCredits: "1.5" },
    { ...quoted, quotedCredits: "01" },
    { ...quoted, quotedCredits: 30 },
    { ...quoted, quotedCredits: "9".repeat(49) },
    { ...quoted, principalId: "forged" },
  ]) {
    const http = new InstalledPluginTaskHttpAuthority({
      timeoutMs: 1000,
      fetch: async () => response(result),
    });
    const authority = new InstalledPluginCreditQuoteAuthority({
      endpoint,
      http,
      digester,
      currentSignal: () => new AbortController().signal,
      assertCurrent: async () => {},
    });
    await assert.rejects(authority.quoteGeneration(quoteInput));
    await http.close();
  }
  const failed = new InstalledPluginTaskHttpAuthority({
    timeoutMs: 1000,
    fetch: async () => {
      throw new Error("fixture-unavailable");
    },
  });
  const authority = new InstalledPluginCreditQuoteAuthority({
    endpoint,
    http: failed,
    digester,
    currentSignal: () => new AbortController().signal,
    assertCurrent: async () => {},
  });
  await assert.rejects(
    authority.quoteGeneration(quoteInput),
    /installed_plugin_task_authority_unavailable/,
  );
  await failed.close();
});
test("a response after current permission changed is rejected", async () => {
  let allowed = true;
  const http = new InstalledPluginTaskHttpAuthority({
    timeoutMs: 1000,
    fetch: async () => {
      allowed = false;
      return response(quoted);
    },
  });
  const authority = new InstalledPluginCreditQuoteAuthority({
    endpoint,
    http,
    digester,
    currentSignal: () => new AbortController().signal,
    assertCurrent: async () => {
      if (!allowed) throw new Error("fixture-revoked");
    },
  });
  await assert.rejects(
    authority.quoteGeneration(quoteInput),
    /fixture-revoked/,
  );
  await http.close();
});
test("bounded HTTP rejects redirects/status, oversized/non-JSON and non-finite JSON responses", async () => {
  for (const make of [
    () =>
      new Response("{}", {
        status: 302,
        headers: {
          "content-type": "application/json",
          "location": "https://foreign.example",
        },
      }),
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
    () =>
      new Response(" ".repeat(16385), {
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response('{"quotedCredits":1e999}', {
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response("{}", {
        headers: { "content-type": "application/json", "content-length": "3" },
      }),
  ]) {
    const http = new InstalledPluginTaskHttpAuthority({
      timeoutMs: 1000,
      fetch: async () => make(),
    });
    await assert.rejects(
      http.post(endpoint, {}, new AbortController().signal),
      /authority_unavailable/,
    );
    await http.close();
  }
});
test("close withdraws logical admission immediately and joins physical response/body cleanup", async () => {
  const entered = deferred(),
    release = deferred();
  let cancelled = 0,
    sent = 0;
  const http = new InstalledPluginTaskHttpAuthority({
    timeoutMs: 1000,
    fetch: async () => {
      sent++;
      entered.resolve();
      await release.promise;
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled++;
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const work = http.post(endpoint, {}, new AbortController().signal);
  const rejected = assert.rejects(work, /authority_unavailable/);
  await entered.promise;
  let settled = false;
  const closing = http.close().then(() => {
    settled = true;
  });
  await rejected;
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(settled, false);
  await assert.rejects(http.post(endpoint, {}, new AbortController().signal));
  assert.equal(sent, 1);
  release.resolve();
  await closing;
  assert.equal(cancelled, 1);
});
test("synchronous fetch reentry cannot close before its physical operation is registered", async () => {
  const entered = deferred(),
    release = deferred();
  let closed = false,
    closing!: Promise<void>;
  let http!: InstalledPluginTaskHttpAuthority;
  http = new InstalledPluginTaskHttpAuthority({
    timeoutMs: 1000,
    fetch: async () => {
      closing = http.close().then(() => {
        closed = true;
      });
      entered.resolve();
      await release.promise;
      return response(quoted);
    },
  });
  const work = http.post(endpoint, {}, new AbortController().signal),
    rejected = assert.rejects(work);
  await entered.promise;
  await rejected;
  assert.equal(closed, false);
  release.resolve();
  await closing;
});
test("abort actively cancels a stalled body and close joins the actual underlying cancel", async () => {
  const readStarted = deferred(),
    cancelStarted = deferred(),
    release = deferred();
  let closed = false;
  const http = new InstalledPluginTaskHttpAuthority({
    timeoutMs: 1000,
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            readStarted.resolve();
          },
          async cancel() {
            cancelStarted.resolve();
            await release.promise;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  const work = http.post(endpoint, {}, new AbortController().signal),
    rejected = assert.rejects(work);
  await readStarted.promise;
  const closing = http.close().then(() => {
    closed = true;
  });
  await rejected;
  await cancelStarted.promise;
  assert.equal(closed, false);
  release.resolve();
  await closing;
});
test("zero-byte chunk floods are bounded and raw transport errors never expose authority secrets", async () => {
  let chunks = 0,
    cancellations = 0;
  const http = new InstalledPluginTaskHttpAuthority({
    timeoutMs: 1000,
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            chunks++;
            controller.enqueue(new Uint8Array(0));
          },
          cancel() {
            cancellations++;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  await assert.rejects(http.post(endpoint, {}, new AbortController().signal));
  await http.close();
  assert.ok(chunks <= 16386);
  assert.equal(cancellations, 1);
  const hostile = new InstalledPluginTaskHttpAuthority({
    timeoutMs: 1000,
    fetch: async () => {
      throw new Error(`${endpoint.url} ${endpoint.serviceToken}`);
    },
  });
  await assert.rejects(
    hostile.post(endpoint, {}, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.cause, undefined);
      assert.ok(!error.message.includes(endpoint.serviceToken));
      assert.ok(!error.message.includes(endpoint.url));
      return true;
    },
  );
  await hostile.close();
});
