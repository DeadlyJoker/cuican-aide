import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionConfiguration } from "@crewon/domain";
import { InstalledPluginExtensionHost } from "./plugins/installed-plugin-extension-host.ts";
import {
  gate,
  readinessFixture,
  approval,
} from "./installed-plugin-execution-readiness.test-support.ts";
import {
  hostFixture,
  digester,
} from "./installed-plugin-extension-host.test-support.ts";
const signal = () => new AbortController().signal;

test("IO readiness uses real operation Store and public HTTPS DNS without a Run, business creation or HTTP", async (t) => {
  const f = await readinessFixture(t);
  const owner = f.owner();
  await owner.assertReady(f.input, signal());
  assert.equal(f.state.preflights, 1);
  assert.equal(f.state.dns, 1);
  assert.equal(f.state.http, 0);
  assert.equal(f.state.dispatchResolution, 0);
  f.state.allowed = false;
  await assert.rejects(
    owner.assertReady(f.input, signal()),
    /services_unavailable/u,
  );
  assert.equal(f.state.preflights, 2);
  assert.equal(f.state.dns, 1);
});

test("declared IO requires actual config, explicit preflight and operation methods; legacy empty requirements are compatible", async (t) => {
  const f = await readinessFixture(t);
  const old = { ...f.config };
  delete old.resolveReadinessNetwork;
  for (const owner of [
    f.owner({ configuration: undefined }),
    f.owner({ configuration: old }),
    f.owner({ operations: undefined }),
  ]) {
    await assert.rejects(
      owner.assertReady(f.input, signal()),
      /services_unavailable/u,
    );
    await owner.assertReady({ ...f.input, requiredServices: [] }, signal());
  }
  assert.equal(f.state.preflights, 0);
  assert.equal(f.state.http, 0);
});

test("readiness refuses private DNS, invalid HTTPS roots, denied metadata and unapproved observation paths", async (t) => {
  const f = await readinessFixture(t);
  f.state.address = "127.0.0.1";
  await assert.rejects(
    f.owner().assertReady(f.input, signal()),
    /egress_denied/u,
  );
  f.state.address = "8.8.8.8";
  for (const baseUrl of [
    "http://readiness-fixture.example/",
    "https://user:secret@readiness-fixture.example/",
    "https://readiness-fixture.example/subpath",
  ]) {
    const input = {
      ...f.input,
      metadata: {
        ...f.input.metadata,
        configuration: createExtensionConfiguration(
          { ...f.input.metadata.configuration, parameters: { baseUrl } },
          digester,
        ),
      },
    };
    const owner = f.owner({
      configuration: {
        ...f.config,
        resolveReadinessNetwork: async () => approval,
      },
    });
    await assert.rejects(
      owner.assertReady(input, signal()),
      /network_unavailable/u,
    );
  }
  const owner = f.owner({
    configuration: {
      ...f.config,
      resolveReadinessNetwork: async () => ({
        ...approval,
        paths: [approval.paths[0]!],
      }),
    },
  });
  await assert.rejects(
    owner.assertReady(
      { ...f.input, metadata: { ...f.input.metadata, purpose: "observe" } },
      signal(),
    ),
    /network_unavailable/u,
  );
  assert.equal(f.state.http, 0);
});

test("readiness snapshots bounded own data without calling getters or accepting extra Run/command metadata", async (t) => {
  const f = await readinessFixture(t);
  const owner = f.owner();
  let getters = 0;
  const metadata = { ...f.input.metadata };
  Object.defineProperty(metadata, "configuration", {
    enumerable: true,
    get() {
      getters++;
      return f.input.metadata.configuration;
    },
  });
  assert.throws(() => owner.assertReady({ ...f.input, metadata }, signal()));
  assert.equal(getters, 0);
  assert.throws(() =>
    owner.assertReady(
      {
        ...f.input,
        metadata: { ...f.input.metadata, run: { runId: "invented" } },
      } as never,
      signal(),
    ),
  );
  assert.throws(() =>
    owner.assertReady(
      { ...f.input, requiredServices: ["jsonHttp", "jsonHttp"] },
      signal(),
    ),
  );
  assert.equal(f.state.preflights, 0);
});

test("logical timeout retains busy capacity and close joins the physical preflight callback", async (t) => {
  const f = await readinessFixture(t);
  const entered = gate(),
    finish = gate();
  const owner = f.owner({
    maximumChecks: 1,
    timeoutMs: 20,
    configuration: {
      ...f.config,
      async resolveReadinessNetwork() {
        entered.resolve();
        await finish.promise;
        return approval;
      },
    },
  });
  const work = owner.assertReady(f.input, signal());
  void work.catch(() => {});
  await entered.promise;
  await assert.rejects(work, /timeout/u);
  await assert.rejects(
    owner.assertReady(f.input, signal()),
    /capacity_exceeded/u,
  );
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  finish.resolve();
  await closing;
  await assert.rejects(owner.assertReady(f.input, signal()), /closed/u);
});

test("abort retains capacity and physical DNS until actual resolver completion", async (t) => {
  const f = await readinessFixture(t);
  const entered = gate(),
    finish = gate();
  const owner = f.owner({
    maximumChecks: 1,
    configuration: {
      ...f.config,
      dns: {
        async resolveAll() {
          entered.resolve();
          await finish.promise;
          return [{ address: "8.8.8.8", family: 4 }];
        },
      },
    },
  });
  const controller = new AbortController();
  const work = owner.assertReady(f.input, controller.signal);
  void work.catch(() => {});
  await entered.promise;
  controller.abort(new Error("fixture_cancelled"));
  await assert.rejects(work, /fixture_cancelled/u);
  await assert.rejects(
    owner.assertReady(f.input, signal()),
    /capacity_exceeded/u,
  );
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  finish.resolve();
  await closing;
});

for (const requiredServices of [
  undefined,
  [],
  ["externalOperations", "jsonHttp"],
] as const)
  test(`actual installed ESM readiness ${requiredServices?.length ? "refuses required IO without a real gate" : "preserves legacy factory behavior"}`, async (t) => {
    const f = await hostFixture(t, {
      ...(requiredServices === undefined ? {} : { requiredServices }),
    });
    const result = await f.host.evaluate(f.request);
    assert.equal(
      result.outcome,
      requiredServices?.length ? "unavailable" : "ready",
    );
    assert.equal((await f.events()).includes("create"), false);
  });

test("actual ESM Host calls the declared metadata gate each time and rechecks current caller authority", async (t) => {
  const f = await hostFixture(t, {
    requiredServices: ["externalOperations", "jsonHttp"],
  });
  let calls = 0;
  const host = new InstalledPluginExtensionHost({
    ...f.dependencies,
    executionReadiness: {
      async assertReady(input) {
        calls++;
        assert.deepEqual(input.requiredServices, [
          "externalOperations",
          "jsonHttp",
        ]);
        assert.equal(
          input.metadata.identity.packageDigest,
          f.entry.registration.identity.packageDigest,
        );
        assert.deepEqual(input.metadata.scope, f.dependencies.scope);
        assert.deepEqual(input.metadata.configuration, f.request.configuration);
        assert.equal(
          input.metadata.target.agentVersionId,
          f.entry.version.agentVersionId,
        );
        assert.equal(input.metadata.purpose, "submit");
        if (calls === 2) f.state.allowed = false;
      },
    },
  });
  try {
    assert.equal((await host.evaluate(f.request)).outcome, "ready");
    await assert.rejects(host.evaluate(f.request), /forbidden/u);
    assert.equal(calls, 2);
    assert.equal((await f.events()).includes("create"), false);
  } finally {
    await host.close();
  }
});

test("actual ESM Host cannot claim readiness if its factory is withdrawn during IO preflight", async (t) => {
  const f = await hostFixture(t, { requiredServices: ["jsonHttp"] });
  const host = new InstalledPluginExtensionHost({
    ...f.dependencies,
    executionReadiness: {
      async assertReady() {
        f.nodeState.revokeFactory!();
      },
    },
  });
  try {
    assert.equal((await host.evaluate(f.request)).outcome, "unavailable");
    assert.equal((await f.events()).includes("create"), false);
  } finally {
    await host.close();
  }
});

for (const requiredServices of [undefined, ["jsonHttp"]] as const)
  test(
    `actual ESM ${requiredServices ? "declared IO" : "legacy"} Host refuses a factory withdrawn while final caller authorization is pending`,
    { timeout: 10_000 },
    async (t) => {
      const f = await hostFixture(t, {
        ...(requiredServices === undefined ? {} : { requiredServices }),
      });
      const entered = gate(),
        finish = gate();
      let calls = 0,
        pauseAt: number | null = null,
        blockedAction: string | null = null,
        preflights = 0;
      const host = new InstalledPluginExtensionHost({
        ...f.dependencies,
        authorization: {
          async authorize(input) {
            calls++;
            if (calls === pauseAt) {
              blockedAction = input.action;
              entered.resolve();
              await finish.promise;
            }
            return f.dependencies.authorization.authorize(input);
          },
        },
        executionReadiness: {
          async assertReady(input) {
            preflights++;
            assert.deepEqual(input.requiredServices, requiredServices);
          },
        },
      });
      try {
        assert.equal((await host.evaluate(f.request)).outcome, "ready");
        // Measure the public authority calls of a successful warm evaluation, rather than pinning
        // the test to an internal number of gates or substituting a factory/runtime implementation.
        calls = 0;
        assert.equal((await host.evaluate(f.request)).outcome, "ready");
        assert.ok(calls > 0);
        pauseAt = calls;
        calls = 0;
        const before = preflights;
        const evaluating = host.evaluate(f.request);
        void evaluating.catch(() => {});
        await entered.promise;
        assert.equal(blockedAction, "agentVersion:read");
        assert.equal(preflights, before + (requiredServices ? 1 : 0));
        assert.ok(f.nodeState.revokeFactory);
        f.nodeState.revokeFactory();
        finish.resolve();
        assert.deepEqual(await evaluating, {
          outcome: "unavailable",
          reasonCode: "extension_runtime_unavailable",
        });
        assert.equal(
          f.state.allowed,
          true,
          "the caller retains permission; only the actual factory was withdrawn",
        );
        assert.equal((await f.events()).includes("create"), false);
      } finally {
        finish.resolve();
        await host.close();
      }
    },
  );
