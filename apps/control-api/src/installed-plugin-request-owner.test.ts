import assert from "node:assert/strict";
import test from "node:test";
import {
  ApplicationError,
  ExtensionConfigurationApplicationService,
  type ExtensionStore,
} from "@crewon/application";
import Fastify from "fastify";
import type {
  ActorContext,
  ExtensionHostPort,
  PluginInstallationHostProfilePort,
} from "@crewon/application";
import {
  bindInstalledPluginRequestOwner,
  InstalledPluginRequestOwner,
} from "./installed-plugin-request-owner.ts";
import { registerExtensionConfigurationRoutes } from "./extension-configuration-route.ts";
import type { InstalledPluginPeerPrepared } from "./installed-plugin-peer-client.ts";
import { ProductionControlApiIdentity } from "./production-security-adapters.ts";
import {
  actor,
  deferred,
  digester,
  identityFixture,
  request,
  scope,
} from "./installed-plugin-task.test-support.ts";

function prepared(
  onList: () => void = () => {},
  host?: Partial<ExtensionHostPort>,
): InstalledPluginPeerPrepared {
  return Object.freeze({
    catalog: Object.freeze({
      list: () => {
        onList();
        return [];
      },
      resolve: () => null,
    }),
    host: Object.freeze({
      taskAdmissionMode: () => "installed" as const,
      validateConfiguration: async () => {},
      evaluate: async () => ({
        outcome: "unavailable" as const,
        reasonCode: "extension_runtime_unavailable" as const,
      }),
      ...host,
    }),
    pluginQueryHost: Object.freeze({
      resolveRegistration: async () => null,
      evaluate: async () => ({
        outcome: "unavailable" as const,
        reasonCode: "extension_runtime_unavailable" as const,
      }),
    }),
  });
}
function fixture(
  input: Readonly<{
    profiles?: PluginInstallationHostProfilePort;
    result?: InstalledPluginPeerPrepared;
  }> = {},
) {
  const f = identityFixture();
  let preparations = 0;
  const owner = new InstalledPluginRequestOwner({
    identity: f.identity,
    profiles: input.profiles ?? { resolve: async () => scope },
    peer: {
      prepare: async (value, options) => {
        preparations++;
        assert.deepEqual(value.actor, actor);
        assert.deepEqual(value.scope, scope);
        assert.equal(options?.signal?.aborted, false);
        return input.result ?? prepared();
      },
    },
  });
  return { ...f, owner, preparations: () => preparations };
}
test("warm identity cache is not fresh task authority; same token changing principal is rejected", async () => {
  const f = fixture();
  assert.deepEqual(await f.identity.resolveActor(request), actor);
  f.setActor({ ...actor, principalId: "different-person" });
  assert.deepEqual(await f.identity.resolveActor(request), actor);
  await assert.rejects(
    f.owner.run({ request, actor }, async () => "must-not-run"),
    /installed_plugin_request_authority_unavailable/,
  );
  assert.equal(f.calls(), 2);
  assert.equal(f.preparations(), 0);
  await f.owner.close();
});
test("catalog access only exists in its own live actual request; escaped callbacks and copied requests cannot grant authority", async () => {
  const f = fixture();
  let escaped!: () => unknown;
  await f.owner.run({ request, actor }, async () => {
    assert.deepEqual(f.owner.catalog.list(), []);
    assert.equal(f.owner.currentActor().principalId, actor.principalId);
    escaped = () => f.owner.catalog.list();
    const foreignOwner = {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      actorId: "foreign-actor",
    };
    await assert.rejects(
      f.owner.resolveActor(foreignOwner, new AbortController().signal),
    );
    return "allowed";
  });
  assert.throws(escaped, /authority_unavailable/);
  assert.throws(() => f.owner.catalog.list(), /authority_unavailable/);
  let hooks = 0;
  const headers = Object.defineProperty(
    { ...request.headers },
    "authorization",
    {
      enumerable: true,
      get() {
        hooks++;
        return request.headers.authorization;
      },
    },
  );
  assert.throws(() =>
    f.owner.run({ request: { ...request, headers }, actor }, async () => {}),
  );
  assert.equal(hooks, 0);
  await f.owner.close();
});
test(
  "concurrent authenticated principals retain independent profiles/catalog snapshots without a global latest map",
  { timeout: 10000 },
  async () => {
    const other: ActorContext = { ...actor, principalId: "second-person" },
      seen: string[] = [];
    const entered = deferred(),
      release = deferred();
    let inside = 0;
    const identity = new ProductionControlApiIdentity({
      trustedBff: { verify() {} },
      tokens: {
        verify: async ({ accessToken }) => ({
          issuer: "https://fixture-identity.example",
          audience: ["fixture-control"],
          issuedAt: "2026-10-03T00:00:00.000Z",
          expiresAt: "2026-10-03T00:05:00.000Z",
          ...(accessToken === "second-token" ? other : actor),
        }),
      },
      expectedIssuer: "https://fixture-identity.example",
      expectedAudience: "fixture-control",
      timeoutMs: 1000,
      now: () => Date.parse("2026-10-03T00:00:00.000Z"),
    });
    const owner = new InstalledPluginRequestOwner({
      identity,
      profiles: {
        resolve: async (current) => ({
          ...scope,
          profileId: current.principalId,
        }),
      },
      peer: {
        prepare: async ({ actor: current, scope: profile }) => {
          assert.equal(profile.profileId, current.principalId);
          return prepared(() => seen.push(current.principalId));
        },
      },
    });
    const work = async () => {
      if (++inside === 2) entered.resolve();
      await release.promise;
      const current = owner.currentActor();
      owner.catalog.list();
      return current.principalId;
    };
    const first = owner.run({ request, actor }, work),
      second = owner.run(
        {
          request: {
            ...request,
            headers: {
              ...request.headers,
              authorization: "Bearer second-token",
            },
          },
          actor: other,
        },
        work,
      );
    await entered.promise;
    release.resolve();
    assert.deepEqual(await Promise.all([first, second]), [
      actor.principalId,
      other.principalId,
    ]);
    assert.deepEqual(
      seen.sort(),
      [actor.principalId, other.principalId].sort(),
    );
    await owner.close();
  },
);
test("profile changes after await reject before admitting task work", async () => {
  let reads = 0,
    invoked = 0;
  const f = fixture({
    profiles: {
      resolve: async () => ({
        ...scope,
        profileId: ++reads === 1 ? scope.profileId : "new-profile",
      }),
    },
  });
  await assert.rejects(
    f.owner.run({ request, actor }, async () => {
      invoked++;
    }),
    /authority_unavailable/,
  );
  assert.equal(f.preparations(), 1);
  assert.equal(invoked, 0);
  await f.owner.close();
});
test("host output after a principal change is withheld and an unknown admission mode is never treated as legacy", async () => {
  const f = fixture();
  const owner = new InstalledPluginRequestOwner({
    identity: f.identity,
    profiles: { resolve: async () => scope },
    peer: {
      prepare: async () =>
        prepared(() => {}, {
          taskAdmissionMode: () => "legacy",
          validateConfiguration: async () => {
            f.setActor({ ...actor, principalId: "new-person" });
          },
        }),
    },
  });
  await owner.run({ request, actor }, async () => {
    assert.throws(
      () => owner.host.taskAdmissionMode!({ registration: {} as never }),
      /authority_unavailable/,
    );
    await assert.rejects(
      owner.host.validateConfiguration({
        actor,
        registration: {} as never,
        configuration: {} as never,
      }),
      /authority_unavailable/,
    );
  });
  await owner.close();
  await f.owner.close();
});
test("close fences all escaped capabilities and joins a started physical peer preparation", async () => {
  const f = identityFixture(),
    entered = deferred(),
    release = deferred();
  let workCalls = 0;
  const owner = new InstalledPluginRequestOwner({
    identity: f.identity,
    profiles: { resolve: async () => scope },
    peer: {
      prepare: async () => {
        entered.resolve();
        await release.promise;
        return prepared();
      },
    },
  });
  const work = owner.run({ request, actor }, async () => {
    workCalls++;
  });
  const rejected = assert.rejects(work);
  await entered.promise;
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(closed, false);
  assert.throws(
    () => owner.run({ request, actor }, async () => {}),
    /authority_unavailable/,
  );
  release.resolve();
  await rejected;
  await closing;
  assert.equal(workCalls, 0);
});
test("request token snapshot survives caller mutation; a request abort cannot be replaced by a fresh DTO", async () => {
  const f = fixture(),
    mutable = structuredClone(request),
    controller = new AbortController();
  await f.owner.run(
    { request: mutable, actor, signal: controller.signal },
    async () => {
      mutable.headers.authorization = "Bearer forged";
      await f.owner.assertCurrent();
      controller.abort();
      await assert.rejects(f.owner.assertCurrent());
    },
  );
  assert.ok(f.calls() >= 3);
  await f.owner.close();
});
test("synchronous identity reentry cannot close before the real request is registered", async () => {
  const entered = deferred(),
    release = deferred();
  let closed = false,
    closing!: Promise<void>,
    profileReads = 0;
  let owner!: InstalledPluginRequestOwner;
  owner = new InstalledPluginRequestOwner({
    identity: {
      resolveCurrentActor: async () => {
        closing = owner.close().then(() => {
          closed = true;
        });
        entered.resolve();
        await release.promise;
        return actor;
      },
    },
    profiles: {
      resolve: async () => {
        profileReads++;
        return scope;
      },
    },
    peer: { prepare: async () => prepared() },
  });
  const work = owner.run({ request, actor }, async () => {}),
    rejected = assert.rejects(work);
  await entered.promise;
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(closed, false);
  release.resolve();
  await rejected;
  await closing;
  assert.equal(profileReads, 0);
});
test("bound original GET rechecks identity after its storage await; unbound legacy GET has no extra token/profile IO", async (t) => {
  for (const bound of [false, true]) {
    const f = fixture();
    let reads = 0;
    // A focused Application storage stub; this test proves the real HTTP request gate,
    // not database persistence, task execution, funding, or production policy.
    const service = new ExtensionConfigurationApplicationService({
      store: {
        loadLatestExtensionConfiguration: async () => {
          reads++;
          f.setActor({ ...actor, principalId: "changed-during-storage" });
          return null;
        },
      } as unknown as ExtensionStore,
      catalog: f.owner.catalog,
      host: f.owner.host,
      authorization: { authorize: async () => ({ outcome: "allow" }) },
      clock: { now: () => "2026-10-03T00:00:00.000Z" },
      digester,
    });
    if (bound) bindInstalledPluginRequestOwner(service, f.owner);
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) =>
      reply.code(403).send({
        code:
          error instanceof ApplicationError ? error.code : "fixture-failure",
      }),
    );
    registerExtensionConfigurationRoutes(app, {
      identity: f.identity,
      extensions: service,
    });
    t.after(async () => {
      await app.close();
      await f.owner.close();
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/extensions/fixture.report/configuration",
      headers: request.headers,
    });
    assert.equal(reads, 1);
    if (bound) {
      assert.equal(response.statusCode, 403);
      assert.equal(
        response.json().code,
        "installed_plugin_request_authority_unavailable",
      );
    } else {
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { configuration: null });
      assert.equal(f.calls(), 1);
      assert.equal(f.preparations(), 0);
    }
  }
});
