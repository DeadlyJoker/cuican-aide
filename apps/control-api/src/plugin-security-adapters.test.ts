import assert from "node:assert/strict";
import test from "node:test";
import type {
  ActorContext,
  PluginInstallationAuthorizationPort,
  PluginUiAuthorizationPort,
} from "@crewon/application";
import {
  AuthorityPluginHostProfile,
  DynamicPluginInstallationAuthorization,
  DynamicPluginUiAuthorization,
  type PluginProfileAuthorityPort,
  type PluginUiPolicyDecisionPort,
} from "./plugin-security-adapters.ts";
import {
  DynamicPolicyAuthorization,
  ProductionControlApiIdentity,
  type PolicyDecisionPort,
} from "./production-security-adapters.ts";
import { HttpPolicyDecisionPort } from "./production-http-security-ports.ts";

const ACTOR = {
  principalId: "person-alice",
  actorId: "browser-session-7",
  tenantId: "tenant-acme",
  spaceId: "space-creative",
} as const;
const SCOPE = {
  tenantId: ACTOR.tenantId,
  spaceId: ACTOR.spaceId,
  profileId: "profile-from-authority",
};
const DIGEST = `sha256:${"a".repeat(64)}`;
type UiRequest = Parameters<PluginUiAuthorizationPort["authorize"]>[0];
type InstallationRequest = Parameters<
  PluginInstallationAuthorizationPort["authorize"]
>[0];

function uiRequest(action: UiRequest["action"] = "mount"): UiRequest {
  return {
    actor: { ...ACTOR },
    action,
    resource: {
      kind: "pluginUi",
      ...SCOPE,
      pluginId: "studio.example",
      packageDigest: DIGEST,
      selectionRevision: 3,
      contributionId: "workbench",
    },
  };
}
function installationRequest(
  action: InstallationRequest["action"] = "pluginInstallation:install",
): InstallationRequest {
  return {
    actor: { ...ACTOR },
    action,
    resource: {
      kind: "pluginInstallation",
      ...SCOPE,
      pluginId: "studio.example",
      packageDigest: DIGEST,
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

test("installation actions use the existing policy wire without changing legacy decisions", async () => {
  const captured: unknown[] = [];
  const policy = new HttpPolicyDecisionPort({
    url: "https://policy.example/authorize",
    serviceToken: "fixture-service-credential-32-characters",
    fetch: async (_url, init) => {
      captured.push(JSON.parse(String(init?.body)));
      return Response.json({ outcome: "allow" });
    },
  });
  const adapter = new DynamicPluginInstallationAuthorization({
    policy,
    timeoutMs: 1000,
  });
  for (const action of [
    "pluginInstallation:read",
    "pluginInstallation:install",
    "pluginInstallation:select",
  ] as const) {
    const request = installationRequest(action);
    const result = await adapter.authorize(request);
    assert.deepEqual(result, { outcome: "allow" });
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(captured.at(-1), request);
  }
  const old = new DynamicPolicyAuthorization({ policy, timeoutMs: 1000 });
  const request = {
    actor: ACTOR,
    action: "thread:read" as const,
    resource: {
      kind: "thread" as const,
      tenantId: ACTOR.tenantId,
      spaceId: ACTOR.spaceId,
      threadId: "thread-1",
    },
  };
  assert.deepEqual(await old.authorize(request), { outcome: "allow" });
  assert.deepEqual(captured.at(-1), request);
});

test("installation authorization snapshots inputs and denies cross-scope before consulting policy", async () => {
  const gate = deferred<unknown>();
  let captured: Parameters<PolicyDecisionPort["decide"]>[0] | undefined;
  const adapter = new DynamicPluginInstallationAuthorization({
    timeoutMs: 1000,
    policy: {
      async decide(input) {
        captured = input;
        return gate.promise;
      },
    },
  });
  const request = structuredClone(installationRequest());
  const pending = adapter.authorize(request);
  Object.assign(request.actor, { principalId: "person-mallory" });
  Object.assign(request.resource, { profileId: "profile-swapped" });
  gate.resolve({ outcome: "deny", reasonCode: "installation_not_granted" });
  assert.deepEqual(await pending, {
    outcome: "deny",
    reasonCode: "installation_not_granted",
  });
  assert.equal(captured?.actor.principalId, ACTOR.principalId);
  assert.ok(captured?.resource.kind === "pluginInstallation");
  assert.equal(captured.resource.profileId, SCOPE.profileId);
  assert.ok(Object.isFrozen(captured?.actor));
  const previous = captured;
  assert.deepEqual(
    await adapter.authorize({
      ...installationRequest(),
      resource: { ...installationRequest().resource, tenantId: "tenant-other" },
    }),
    { outcome: "deny", reasonCode: "actor_scope_mismatch" },
  );
  assert.equal(captured, previous);
});

test("installation grant remains exact allow/deny and never reads authority getters", async () => {
  let getterCalls = 0;
  const getter = Object.defineProperty({}, "outcome", {
    enumerable: true,
    get() {
      getterCalls++;
      return "allow";
    },
  });
  for (const response of [
    { outcome: "allow", authorityEpoch: "cannot_extend_old_wire" },
    { outcome: "allow", role: "admin" },
    { outcome: "deny", reasonCode: "BadReason" },
    getter,
    Object.create({ outcome: "allow" }),
  ]) {
    const adapter = new DynamicPluginInstallationAuthorization({
      policy: {
        async decide() {
          return response;
        },
      },
      timeoutMs: 1000,
    });
    await assert.rejects(adapter.authorize(installationRequest()));
  }
  assert.equal(getterCalls, 0);
});

test("UI policy receives exact namespaced actions and numeric selection revision", async () => {
  const calls: Parameters<PluginUiPolicyDecisionPort["decide"]>[0][] = [];
  const adapter = new DynamicPluginUiAuthorization({
    policy: {
      async decide(input) {
        calls.push(input);
        return { outcome: "allow", authorityEpoch: "policy_generation_1" };
      },
    },
    timeoutMs: 1000,
  });
  for (const action of ["catalog", "mount", "asset", "invoke"] as const) {
    const request = uiRequest(action);
    const result = await adapter.authorize(request);
    assert.deepEqual(result, {
      outcome: "allow",
      authorityEpoch: "policy_generation_1",
    });
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(calls.at(-1), {
      ...request,
      action: `pluginUi:${action}`,
      signal: calls.at(-1)?.signal,
    });
    assert.equal(typeof calls.at(-1)?.resource.selectionRevision, "number");
  }
});

test("UI authorization has no grant cache and preserves authority revocation and new epochs", async () => {
  let calls = 0;
  let decision: unknown = { outcome: "allow", authorityEpoch: "epoch_1" };
  const adapter = new DynamicPluginUiAuthorization({
    policy: {
      async decide() {
        calls++;
        return decision;
      },
    },
    timeoutMs: 1000,
  });
  assert.deepEqual(await adapter.authorize(uiRequest()), decision);
  decision = { outcome: "deny", reasonCode: "access_revoked" };
  assert.deepEqual(await adapter.authorize(uiRequest("asset")), decision);
  decision = { outcome: "allow", authorityEpoch: "epoch_2" };
  assert.deepEqual(await adapter.authorize(uiRequest("invoke")), decision);
  assert.equal(calls, 3);
});

test("UI authorization rejects malformed grants without inferring an epoch", async () => {
  let getterCalls = 0;
  const getter = Object.defineProperty({ outcome: "allow" }, "authorityEpoch", {
    enumerable: true,
    get() {
      getterCalls++;
      return "epoch";
    },
  });
  const invalid = [
    null,
    { outcome: "allow" },
    { outcome: "allow", authorityEpoch: "" },
    { outcome: "allow", authorityEpoch: "x".repeat(129) },
    { outcome: "allow", authorityEpoch: "invalid epoch" },
    { outcome: "allow", authorityEpoch: "epoch", expiresAt: "later" },
    { outcome: "deny", reasonCode: "denied", authorityEpoch: "epoch" },
    { outcome: "deny", reasonCode: "" },
    getter,
    Object.assign(Object.create({ extra: true }), {
      outcome: "allow",
      authorityEpoch: "epoch",
    }),
  ];
  for (const response of invalid) {
    const adapter = new DynamicPluginUiAuthorization({
      policy: {
        async decide() {
          return response;
        },
      },
      timeoutMs: 1000,
    });
    await assert.rejects(adapter.authorize(uiRequest()));
  }
  assert.equal(getterCalls, 0);
});

test("UI request copies before awaits and rejects accessors, unknown fields and invalid identities", async () => {
  const gate = deferred<unknown>();
  let captured: Parameters<PluginUiPolicyDecisionPort["decide"]>[0] | undefined;
  const adapter = new DynamicPluginUiAuthorization({
    policy: {
      async decide(input) {
        captured = input;
        return gate.promise;
      },
    },
    timeoutMs: 1000,
  });
  const request = structuredClone(uiRequest());
  const pending = adapter.authorize(request);
  Object.assign(request.actor, { actorId: "swapped-actor" });
  Object.assign(request.resource, { selectionRevision: 99 });
  gate.resolve({ outcome: "allow", authorityEpoch: "current_epoch" });
  await pending;
  assert.equal(captured?.actor.actorId, ACTOR.actorId);
  assert.equal(captured?.resource.selectionRevision, 3);
  assert.ok(Object.isFrozen(captured?.resource));
  const prior = captured;
  let getterCalls = 0;
  const getter = Object.defineProperty({ ...uiRequest() }, "resource", {
    enumerable: true,
    get() {
      getterCalls++;
      return uiRequest().resource;
    },
  });
  for (const bad of [
    getter,
    { ...uiRequest(), profileId: "client-profile" },
    { ...uiRequest(), action: "node:anyService" },
    { ...uiRequest(), actor: { ...ACTOR, role: "admin" } },
    { ...uiRequest(), actor: { ...ACTOR, principalId: "lone\ud800" } },
    {
      ...uiRequest(),
      resource: {
        ...uiRequest().resource,
        selectionRevision: Number.MAX_SAFE_INTEGER + 1,
      },
    },
    {
      ...uiRequest(),
      resource: { ...uiRequest().resource, packageDigest: "not-a-digest" },
    },
  ])
    await assert.rejects(adapter.authorize(bad as UiRequest));
  assert.equal(getterCalls, 0);
  assert.equal(captured, prior);
});

test("UI cross-scope requests are denied locally with no authority call", async () => {
  let calls = 0;
  const adapter = new DynamicPluginUiAuthorization({
    policy: {
      async decide() {
        calls++;
        return { outcome: "allow", authorityEpoch: "epoch" };
      },
    },
    timeoutMs: 1000,
  });
  for (const resource of [
    { ...uiRequest().resource, tenantId: "other" },
    { ...uiRequest().resource, spaceId: "other" },
  ]) {
    assert.deepEqual(await adapter.authorize({ ...uiRequest(), resource }), {
      outcome: "deny",
      reasonCode: "actor_scope_mismatch",
    });
  }
  assert.equal(calls, 0);
});

test("profile authority supplies current server-owned scope without actor-derived defaults", async () => {
  const gate = deferred<unknown>();
  let captured:
    | Parameters<PluginProfileAuthorityPort["resolve"]>[0]
    | undefined;
  let calls = 0;
  let current: unknown = SCOPE;
  const adapter = new AuthorityPluginHostProfile({
    timeoutMs: 1000,
    authority: {
      async resolve(input) {
        calls++;
        captured = input;
        return calls === 1 ? gate.promise : current;
      },
    },
  });
  const actor = { ...ACTOR } as ActorContext;
  const pending = adapter.resolve(actor);
  Object.assign(actor, { principalId: "swapped" });
  gate.resolve(SCOPE);
  const first = await pending;
  assert.deepEqual(first, SCOPE);
  assert.notEqual(first.profileId, ACTOR.principalId);
  assert.equal(captured?.actor.principalId, ACTOR.principalId);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(captured?.actor));
  current = { ...SCOPE, profileId: "profile-now-selected-by-authority" };
  assert.deepEqual(await adapter.resolve(ACTOR), current);
  assert.equal(calls, 2);
});

test("profile missing, wrong scope and malformed outputs fail closed without reading getters", async () => {
  let getterCalls = 0;
  const getter = Object.defineProperty(
    { tenantId: ACTOR.tenantId, spaceId: ACTOR.spaceId },
    "profileId",
    {
      enumerable: true,
      get() {
        getterCalls++;
        return "profile";
      },
    },
  );
  for (const response of [
    null,
    { ...SCOPE, tenantId: "other" },
    { ...SCOPE, spaceId: "other" },
    { ...SCOPE, profileId: "" },
    { ...SCOPE, owner: ACTOR.principalId },
    getter,
    Object.assign(Object.create({ injected: true }), SCOPE),
  ]) {
    const adapter = new AuthorityPluginHostProfile({
      authority: {
        async resolve() {
          return response;
        },
      },
      timeoutMs: 1000,
    });
    await assert.rejects(adapter.resolve(ACTOR));
  }
  assert.equal(getterCalls, 0);
});

test("required authorities and bounded deadlines cannot silently default to grants or profiles", () => {
  assert.throws(
    () =>
      new DynamicPluginUiAuthorization({
        policy: undefined as never,
        timeoutMs: 1000,
      }),
    /plugin_ui_policy_required/u,
  );
  assert.throws(
    () =>
      new DynamicPluginInstallationAuthorization({
        policy: {} as never,
        timeoutMs: 1000,
      }),
    /plugin_installation_policy_required/u,
  );
  assert.throws(
    () =>
      new AuthorityPluginHostProfile({
        authority: {} as never,
        timeoutMs: 1000,
      }),
    /plugin_profile_authority_required/u,
  );
  for (const timeoutMs of [0, -1, 1.5, 30001, Infinity]) {
    assert.throws(
      () =>
        new DynamicPluginUiAuthorization({
          policy: {
            async decide() {
              return {};
            },
          },
          timeoutMs,
        }),
      /plugin_security_timeout_invalid/u,
    );
    assert.throws(
      () =>
        new AuthorityPluginHostProfile({
          authority: {
            async resolve() {
              return SCOPE;
            },
          },
          timeoutMs,
        }),
      /plugin_security_timeout_invalid/u,
    );
  }
});

test("actual authority deadlines abort pending calls and unavailable authorities cannot allow", async () => {
  let uiSignal: AbortSignal | undefined;
  const ui = new DynamicPluginUiAuthorization({
    timeoutMs: 5,
    policy: {
      async decide({ signal }) {
        uiSignal = signal;
        return new Promise(() => {});
      },
    },
  });
  await assert.rejects(
    ui.authorize(uiRequest()),
    /security_authority_timeout/u,
  );
  assert.equal(uiSignal?.aborted, true);
  let profileSignal: AbortSignal | undefined;
  const profiles = new AuthorityPluginHostProfile({
    timeoutMs: 5,
    authority: {
      async resolve({ signal }) {
        profileSignal = signal;
        return new Promise(() => {});
      },
    },
  });
  await assert.rejects(profiles.resolve(ACTOR), /security_authority_timeout/u);
  assert.equal(profileSignal?.aborted, true);
  const unavailable = new DynamicPluginUiAuthorization({
    timeoutMs: 1000,
    policy: {
      async decide() {
        throw new Error("authority_offline");
      },
    },
  });
  await assert.rejects(
    unavailable.authorize(uiRequest()),
    /authority_offline/u,
  );
});

test("verified production actor is reused unchanged for current profile and plugin decisions", async () => {
  const now = Date.parse("2026-10-03T00:00:00.000Z");
  const identity = new ProductionControlApiIdentity({
    trustedBff: { verify() {} },
    tokens: {
      async verify() {
        return {
          issuer: "https://identity.example",
          audience: "crewon-control",
          ...ACTOR,
          issuedAt: new Date(now - 1000).toISOString(),
          expiresAt: new Date(now + 60000).toISOString(),
        };
      },
    },
    expectedIssuer: "https://identity.example",
    expectedAudience: "crewon-control",
    timeoutMs: 1000,
    now: () => now,
  });
  const actor = await identity.resolveActor({
    method: "GET",
    url: "/api/v1/plugins",
    remoteAddress: "10.0.0.7",
    headers: {
      authorization: "Bearer fixture-user-token",
      origin: "https://bff.example",
    },
  });
  const profiles = new AuthorityPluginHostProfile({
    authority: {
      async resolve(input) {
        assert.deepEqual(input.actor, ACTOR);
        return SCOPE;
      },
    },
    timeoutMs: 1000,
  });
  const scope = await profiles.resolve(actor);
  const policy = new DynamicPluginInstallationAuthorization({
    policy: {
      async decide(input) {
        assert.deepEqual(input.actor, ACTOR);
        assert.ok(input.resource.kind === "pluginInstallation");
        assert.equal(input.resource.profileId, scope.profileId);
        return { outcome: "deny", reasonCode: "install_not_granted" };
      },
    },
    timeoutMs: 1000,
  });
  assert.deepEqual(
    await policy.authorize({
      ...installationRequest(),
      actor,
      resource: { ...installationRequest().resource, ...scope },
    }),
    { outcome: "deny", reasonCode: "install_not_granted" },
  );
});
