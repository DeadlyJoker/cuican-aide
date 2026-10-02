import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthorityPluginHostProfile,
  DynamicPluginUiAuthorization,
  type PluginUiPolicyDecisionPort,
} from "./plugin-security-adapters.ts";
import {
  HttpPluginProfileAuthorityPort,
  HttpPluginUiPolicyDecisionPort,
} from "./plugin-security-http-ports.ts";

const ACTOR = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
};
const SCOPE = {
  tenantId: ACTOR.tenantId,
  spaceId: ACTOR.spaceId,
  profileId: "profile-1",
};
const TOKEN = "fixture-security-service-token-at-least-32-characters";
const CONFIG = {
  url: "https://authority.example/plugins/authorize",
  serviceToken: TOKEN,
};
function policyRequest(): Parameters<PluginUiPolicyDecisionPort["decide"]>[0] {
  return {
    actor: ACTOR,
    action: "pluginUi:asset",
    resource: {
      kind: "pluginUi",
      ...SCOPE,
      pluginId: "studio.example",
      packageDigest: `sha256:${"1".repeat(64)}`,
      selectionRevision: 8,
      contributionId: "workbench",
    },
    signal: new AbortController().signal,
  };
}

test("UI HTTPS authority sends complete typed scope/action without leaking AbortSignal or browser fields", async () => {
  let calls = 0;
  const request = policyRequest();
  const policy = new HttpPluginUiPolicyDecisionPort({
    ...CONFIG,
    fetch: async (url, init) => {
      calls++;
      assert.equal(String(url), CONFIG.url);
      assert.equal(init?.method, "POST");
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.signal, request.signal);
      assert.deepEqual(init?.headers, {
        "accept": "application/json",
        "authorization": `Bearer ${TOKEN}`,
        "content-type": "application/json",
      });
      assert.deepEqual(JSON.parse(String(init?.body)), {
        actor: ACTOR,
        action: "pluginUi:asset",
        resource: request.resource,
      });
      return Response.json({
        outcome: "allow",
        authorityEpoch: "policy_revision_8",
      });
    },
  });
  assert.deepEqual(await policy.decide(request), {
    outcome: "allow",
    authorityEpoch: "policy_revision_8",
  });
  await policy.decide(request);
  assert.equal(calls, 2);
});

test("real adapters compose with HTTPS ports and strictly validate their authority responses", async () => {
  const profiles = new AuthorityPluginHostProfile({
    authority: new HttpPluginProfileAuthorityPort({
      ...CONFIG,
      url: "https://authority.example/plugins/current-profile",
      fetch: async (url, init) => {
        assert.equal(
          String(url),
          "https://authority.example/plugins/current-profile",
        );
        assert.deepEqual(JSON.parse(String(init?.body)), { actor: ACTOR });
        assert.ok(init?.signal instanceof AbortSignal);
        return Response.json(SCOPE);
      },
    }),
    timeoutMs: 1000,
  });
  assert.deepEqual(await profiles.resolve(ACTOR), SCOPE);
  const policy = new DynamicPluginUiAuthorization({
    policy: new HttpPluginUiPolicyDecisionPort({
      ...CONFIG,
      fetch: async () => Response.json({ outcome: "allow" }),
    }),
    timeoutMs: 1000,
  });
  const { signal: _signal, action: _action, ...request } = policyRequest();
  await assert.rejects(policy.authorize({ ...request, action: "mount" }));
});

test("authority transport rejects non-HTTPS endpoints, embedded credentials, query/fragment and invalid secrets", () => {
  for (const url of [
    "http://authority.example",
    "https://user:password@authority.example",
    "https://authority.example/?token=value",
    "https://authority.example/#fragment",
    "",
  ]) {
    assert.throws(() => new HttpPluginUiPolicyDecisionPort({ ...CONFIG, url }));
    assert.throws(() => new HttpPluginProfileAuthorityPort({ ...CONFIG, url }));
  }
  for (const serviceToken of [
    "short",
    "t".repeat(8193),
    "x".repeat(32) + "\n",
    "x".repeat(32) + " ",
  ]) {
    assert.throws(
      () => new HttpPluginUiPolicyDecisionPort({ ...CONFIG, serviceToken }),
      /plugin_security_authority_token_invalid/u,
    );
  }
});

test("authority HTTP responses require successful bounded JSON with valid UTF-8", async () => {
  const responses = [
    () =>
      new Response("{}", {
        status: 302,
        headers: {
          "content-type": "application/json",
          "location": "https://untrusted.example",
        },
      }),
    () =>
      new Response("{}", {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
    () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": "16385",
        },
      }),
    () =>
      new Response("{}", {
        headers: { "content-type": "application/json", "content-length": "-1" },
      }),
    () =>
      new Response("x".repeat(16385), {
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response("{", { headers: { "content-type": "application/json" } }),
    () =>
      new Response(new Uint8Array([0x22, 0xff, 0x22]), {
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response(null, { headers: { "content-type": "application/json" } }),
  ];
  for (const response of responses) {
    const policy = new HttpPluginUiPolicyDecisionPort({
      ...CONFIG,
      fetch: async () => response(),
    });
    await assert.rejects(
      policy.decide(policyRequest()),
      /plugin_ui_policy_authority_unavailable/u,
    );
  }
  const profiles = new HttpPluginProfileAuthorityPort({
    ...CONFIG,
    fetch: async () => {
      throw new Error("offline");
    },
  });
  await assert.rejects(
    profiles.resolve({ actor: ACTOR, signal: new AbortController().signal }),
    /plugin_profile_authority_unavailable/u,
  );
});

test("authority streaming JSON bounds actual chunks and cancels an oversized response", async () => {
  let cancelled = false;
  const policy = new HttpPluginUiPolicyDecisionPort({
    ...CONFIG,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(10000));
            controller.enqueue(new Uint8Array(10000));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  await assert.rejects(
    policy.decide(policyRequest()),
    /plugin_ui_policy_authority_unavailable/u,
  );
  assert.equal(cancelled, true);
});

test("HTTP input boundary rejects injected scopes/actions and never invokes accessors or fetch", async () => {
  let calls = 0;
  let getterCalls = 0;
  const policy = new HttpPluginUiPolicyDecisionPort({
    ...CONFIG,
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  const getter = Object.defineProperty({ ...policyRequest() }, "actor", {
    enumerable: true,
    get() {
      getterCalls++;
      return ACTOR;
    },
  });
  for (const input of [
    getter,
    { ...policyRequest(), actor: { ...ACTOR, role: "admin" } },
    { ...policyRequest(), action: "node:arbitraryService" },
    {
      ...policyRequest(),
      resource: { ...policyRequest().resource, path: "/private/install/root" },
    },
    { ...policyRequest(), signal: {} },
  ])
    await assert.rejects(
      policy.decide(
        input as Parameters<PluginUiPolicyDecisionPort["decide"]>[0],
      ),
    );
  const profile = new HttpPluginProfileAuthorityPort({
    ...CONFIG,
    fetch: async () => {
      calls++;
      return Response.json(SCOPE);
    },
  });
  await assert.rejects(
    profile.resolve({
      actor: ACTOR,
      signal: new AbortController().signal,
      profileId: "client-selected",
    } as never),
  );
  assert.equal(getterCalls, 0);
  assert.equal(calls, 0);
});

test("configured adapter deadline reaches HTTP fetch and aborts the actual pending authority request", async () => {
  let aborted = false;
  const adapter = new AuthorityPluginHostProfile({
    authority: new HttpPluginProfileAuthorityPort({
      ...CONFIG,
      fetch: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    }),
    timeoutMs: 5,
  });
  await assert.rejects(adapter.resolve(ACTOR), /security_authority_timeout/u);
  assert.equal(aborted, true);
});
