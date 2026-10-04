import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { parsePluginUiLease } from "@crewon/contracts/plugins";
import {
  createPluginControlRouteFixture,
  pluginRouteActor,
  pluginRouteHeaders,
} from "./plugin-control-route.test-support.ts";

async function mountedFixture(
  t: TestContext,
  options: Parameters<typeof createPluginControlRouteFixture>[1] = {},
) {
  const f = await createPluginControlRouteFixture(t, options);
  const pkg = await f.createPackage("1.0.0");
  const installed = await f.app.inject({
    method: "POST",
    url: "/api/v1/plugins/installations",
    headers: { ...pluginRouteHeaders, "idempotency-key": "renew-install" },
    payload: {
      sourceId: pkg.sourceId,
      expectedPluginId: pkg.expectedPluginId,
      expectedPackageDigest: pkg.expectedPackageDigest,
      expectedSelectionRevision: null,
    },
  });
  assert.equal(installed.statusCode, 200, installed.body);
  const selected = await f.app.inject({
    method: "PUT",
    url: `/api/v1/plugins/selections/${pkg.expectedPluginId}`,
    headers: { ...pluginRouteHeaders, "idempotency-key": "renew-enable" },
    payload: {
      state: "enabled",
      selectedPackageDigest: pkg.expectedPackageDigest,
      expectedSelectionRevision: 1,
    },
  });
  assert.equal(selected.statusCode, 200, selected.body);
  const mounted = await f.app.inject({
    method: "POST",
    url: "/api/v1/plugins/ui/mounts",
    headers: pluginRouteHeaders,
    payload: {
      pluginId: pkg.expectedPluginId,
      contributionId: "counter",
      expectedPackageDigest: pkg.expectedPackageDigest,
      expectedSelectionRevision: 2,
    },
  });
  assert.equal(mounted.statusCode, 200, mounted.body);
  const lease = parsePluginUiLease(mounted.json());
  const base = `/api/v1/plugins/ui/mounts/${lease.mountRef}`;
  return { ...f, pkg, lease, base };
}

test("formal renewal preserves selected bytes and reference while old validate remains read-only", async (t) => {
  const f = await mountedFixture(t);
  f.advanceClock(150_000);
  const validated = await f.app.inject({
    method: "GET",
    url: f.base,
    headers: pluginRouteHeaders,
  });
  assert.equal(validated.statusCode, 200, validated.body);
  assert.deepEqual(validated.json(), f.lease);
  const renewed = await f.app.inject({
    method: "POST",
    url: `${f.base}/renew`,
    headers: pluginRouteHeaders,
    payload: { expectedExpiresAt: f.lease.expiresAt },
  });
  assert.equal(renewed.statusCode, 200, renewed.body);
  const current = parsePluginUiLease(renewed.json());
  assert.equal(current.expiresAt, "2026-10-03T00:07:30.000Z");
  assert.deepEqual({ ...current, expiresAt: f.lease.expiresAt }, f.lease);
  assert.equal(renewed.headers["cache-control"], "no-store");
  const read = await f.app.inject({
    method: "GET",
    url: `${f.base}/assets/${current.descriptor.entrypoints.ui!.path}`,
    headers: pluginRouteHeaders,
  });
  assert.equal(read.statusCode, 200, read.body);
  const replay = await f.app.inject({
    method: "POST",
    url: `${f.base}/renew`,
    headers: pluginRouteHeaders,
    payload: { expectedExpiresAt: f.lease.expiresAt },
  });
  assert.equal(replay.statusCode, 409, replay.body);
  assert.equal(replay.json().error.code, "plugin_ui_mount_lease_changed");
  assert.equal(f.current(f.pkg.expectedPluginId)?.revision, 2);
  f.advanceClock(300_000);
  const expired = await f.app.inject({
    method: "POST",
    url: `${f.base}/renew`,
    headers: pluginRouteHeaders,
    payload: { expectedExpiresAt: current.expiresAt },
  });
  assert.equal(expired.statusCode, 409, expired.body);
  assert.equal(expired.json().error.code, "plugin_ui_mount_expired");
  assert.equal(
    (
      await f.app.inject({
        method: "GET",
        url: f.base,
        headers: pluginRouteHeaders,
      })
    ).statusCode,
    404,
  );
});

test("renewal HTTP rejects caller scope/query, missing CSRF, foreign owners and revoked policy", async (t) => {
  let actor = pluginRouteActor;
  const f = await mountedFixture(t, {
    identity: { resolveActor: async () => actor },
  });
  f.advanceClock(150_000);
  for (const [url, payload] of [
    [
      `${f.base}/renew?profileId=foreign`,
      { expectedExpiresAt: f.lease.expiresAt },
    ],
    [
      `${f.base}/renew`,
      { expectedExpiresAt: f.lease.expiresAt, actorId: "foreign" },
    ],
    [`${f.base}/renew`, { expectedExpiresAt: "invalid" }],
  ] as const)
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url,
          headers: pluginRouteHeaders,
          payload,
        })
      ).statusCode,
      400,
    );
  actor = { ...pluginRouteActor, actorId: "foreign-actor" };
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `${f.base}/renew`,
        headers: pluginRouteHeaders,
        payload: { expectedExpiresAt: f.lease.expiresAt },
      })
    ).statusCode,
    404,
  );
  actor = pluginRouteActor;
  f.policy.deniedUiActions.add("mount");
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `${f.base}/renew`,
        headers: pluginRouteHeaders,
        payload: { expectedExpiresAt: f.lease.expiresAt },
      })
    ).statusCode,
    403,
  );
  f.policy.deniedUiActions.delete("mount");
  const closed = await f.app.inject({
    method: "DELETE",
    url: f.base,
    headers: pluginRouteHeaders,
  });
  assert.equal(closed.statusCode, 200, closed.body);
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `${f.base}/renew`,
        headers: pluginRouteHeaders,
        payload: { expectedExpiresAt: f.lease.expiresAt },
      })
    ).statusCode,
    404,
  );
  const authenticated = await mountedFixture(t);
  authenticated.advanceClock(150_000);
  const { "x-csrf-token": _csrf, ...withoutCsrf } = pluginRouteHeaders;
  const denied = await authenticated.app.inject({
    method: "POST",
    url: `${authenticated.base}/renew`,
    headers: withoutCsrf,
    payload: { expectedExpiresAt: authenticated.lease.expiresAt },
  });
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json().error.code, "csrf_invalid");
});

test("renewal re-verifies actual installed bytes and cannot extend a tampered fixture package", async (t) => {
  const f = await mountedFixture(t);
  f.advanceClock(150_000);
  const ownedPath = join(
    f.root,
    "installed",
    "packages",
    f.lease.packageDigest.slice(7),
    "ui",
    "chunk.mjs",
  );
  await chmod(ownedPath, 0o600);
  await writeFile(ownedPath, "export const changed = true;\n");
  const rejected = await f.app.inject({
    method: "POST",
    url: `${f.base}/renew`,
    headers: pluginRouteHeaders,
    payload: { expectedExpiresAt: f.lease.expiresAt },
  });
  assert.equal(rejected.statusCode, 500, rejected.body);
  const current = await f.app.inject({
    method: "GET",
    url: f.base,
    headers: pluginRouteHeaders,
  });
  assert.equal(current.statusCode, 200, current.body);
  assert.deepEqual(current.json(), f.lease);
  f.advanceClock(150_000);
  const expired = await f.app.inject({
    method: "GET",
    url: f.base,
    headers: pluginRouteHeaders,
  });
  assert.equal(expired.statusCode, 409, expired.body);
  assert.equal(expired.json().error.code, "plugin_ui_mount_expired");
});
