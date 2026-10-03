import assert from "node:assert/strict";
import test from "node:test";
import {
  candidateActor,
  candidateScope,
  candidateIdentity,
  candidateConfiguration,
  candidateTarget,
  candidateDeferred,
} from "./installed-plugin-peer-candidate.test-support.ts";
import { parseDesktopInstalledPluginActivationConfig } from "./desktop-installed-plugin-activation-environment.ts";
import { DesktopInstalledPluginActivationAuthority } from "./desktop-installed-plugin-activation-authority.ts";

const config = (timeoutMs = 1000) =>
  parseDesktopInstalledPluginActivationConfig(
    {
      schemaVersion: "crewon.desktop-installed-plugin-activation.v1",
      actor: candidateActor,
      scope: candidateScope,
      installRoot: "/tmp/native-activation-authority-test",
      peer: {
        origin: "http://127.0.0.1:3288",
        tokenEnvironmentVariable: "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN",
      },
      authority: {
        url: "https://activation-fixture.example/policy",
        serviceTokenEnvironmentVariable: "TEST_POLICY_TOKEN",
      },
      timeoutMs,
      entries: [
        {
          identity: candidateIdentity,
          configuration: candidateConfiguration,
          target: candidateTarget,
        },
      ],
    },
    {
      CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN: "p".repeat(32),
      TEST_POLICY_TOKEN: "a".repeat(32),
    },
  );

test("Native activate policy uses only the exact legacy named action body and strict allow/deny response", async () => {
  let response: unknown = { outcome: "allow" };
  const authority = new DesktopInstalledPluginActivationAuthority(config(), {
    fetch: async (url, init) => {
      assert.equal(String(url), "https://activation-fixture.example/policy");
      assert.equal(init?.redirect, "error");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${"a".repeat(32)}`,
      );
      assert.deepEqual(JSON.parse(String(init?.body)), {
        actor: candidateActor,
        action: "extension:activate",
        resource: {
          kind: "extension",
          tenantId: candidateActor.tenantId,
          spaceId: candidateActor.spaceId,
          pluginId: candidateIdentity.pluginId,
        },
      });
      return Response.json(response);
    },
  });
  try {
    const input = {
      actor: candidateActor,
      pluginId: candidateIdentity.pluginId,
    };
    assert.deepEqual(
      await authority.decide(input, new AbortController().signal),
      { outcome: "allow" },
    );
    response = { outcome: "deny", reasonCode: "named_policy_denied" };
    assert.deepEqual(
      await authority.decide(input, new AbortController().signal),
      response,
    );
    for (const invalid of [
      { outcome: "allow", authorityEpoch: "extra" },
      { outcome: "deny", reasonCode: "BAD" },
      { outcome: "unknown" },
      true,
    ]) {
      response = invalid;
      await assert.rejects(
        authority.decide(input, new AbortController().signal),
      );
    }
  } finally {
    await authority.close();
  }
});

test("Native activate deadline keeps a physically unresolved fetch owned until returned body cancellation joins", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = candidateDeferred<void>(),
    fetchGate = candidateDeferred<Response>(),
    cancelEntered = candidateDeferred<void>(),
    cancelGate = candidateDeferred<void>();
  let observedSignal: AbortSignal | undefined;
  const authority = new DesktopInstalledPluginActivationAuthority(
    config(1000),
    {
      fetch: async (_url, init) => {
        observedSignal = init?.signal as AbortSignal;
        entered.resolve();
        return fetchGate.promise;
      },
    },
  );
  const decision = authority.decide(
    { actor: candidateActor, pluginId: candidateIdentity.pluginId },
    new AbortController().signal,
  );
  await entered.promise;
  t.mock.timers.tick(1000);
  await assert.rejects(decision, /activation_authority_unavailable/u);
  assert.equal(observedSignal?.aborted, true);
  let joined = false;
  const close = authority.close().then(() => {
    joined = true;
  });
  await Promise.resolve();
  assert.equal(joined, false);
  fetchGate.resolve(
    new Response(
      new ReadableStream({
        cancel: async () => {
          cancelEntered.resolve();
          await cancelGate.promise;
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  await cancelEntered.promise;
  assert.equal(joined, false);
  cancelGate.resolve();
  await close;
  assert.equal(joined, true);
  assert.throws(() =>
    authority.decide(
      { actor: candidateActor, pluginId: candidateIdentity.pluginId },
      new AbortController().signal,
    ),
  );
});
