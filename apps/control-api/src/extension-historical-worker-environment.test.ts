import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { resolveControlExtensionWorkerEnvironment } from "./extension-worker-environment.ts";

const current = {
  CREWON_EXTENSIONS_ENABLED: "1",
  CREWON_PRINCIPAL_ID: "principal-1",
  CREWON_ACTOR_ID: "actor-1",
  CREWON_TENANT_ID: "tenant-1",
  CREWON_SPACE_ID: "space-1",
  CREWON_EXTENSION_HOST_ORIGIN: "http://127.0.0.1:3201",
  CREWON_EXTENSION_HOST_TOKEN: "current-peer-token-with-at-least-32-bytes",
};
const peers = Array.from({ length: 4 }, (_, index) => ({
  origin: `http://127.0.0.1:${3202 + index}`,
  token: `historical-${index}-peer-token-with-at-least-32-bytes`,
  deadlineMs: 1000 + index * 1000,
}));

test("historical host environment returns a bounded frozen snapshot and redacts every peer token", () => {
  const environment = {
    ...current,
    CREWON_EXTENSION_HISTORICAL_HOSTS_JSON: JSON.stringify(peers),
  };
  const parsed = resolveControlExtensionWorkerEnvironment(
    environment,
    "standalone",
  )!;
  assert.deepEqual(parsed.extensionWorker.historicalPeers, peers);
  assert.ok(Object.isFrozen(parsed.extensionWorker.historicalPeers));
  assert.ok(parsed.extensionWorker.historicalPeers!.every(Object.isFrozen));
  environment.CREWON_EXTENSION_HOST_TOKEN =
    "changed-token-with-at-least-32-bytes";
  environment.CREWON_EXTENSION_HISTORICAL_HOSTS_JSON = "[]";
  assert.equal(
    parsed.extensionWorker.token,
    current.CREWON_EXTENSION_HOST_TOKEN,
  );
  assert.deepEqual(parsed.extensionWorker.historicalPeers, peers);
  for (const token of [
    current.CREWON_EXTENSION_HOST_TOKEN,
    ...peers.map((peer) => peer.token),
  ]) {
    assert.equal(inspect(parsed).includes(token), false);
    assert.equal(inspect(parsed.extensionWorker).includes(token), false);
    assert.equal(
      inspect(parsed.extensionWorker.historicalPeers).includes(token),
      false,
    );
  }
});

test("historical host configuration rejects malformed, excessive, duplicate and non-loopback peers", () => {
  for (const value of [
    "",
    "not-json",
    "null",
    "{}",
    JSON.stringify([
      ...peers,
      { ...peers[0], origin: "http://127.0.0.1:3210" },
    ]),
    JSON.stringify([peers[0], peers[0]]),
    JSON.stringify([
      { ...peers[0], origin: current.CREWON_EXTENSION_HOST_ORIGIN },
    ]),
    JSON.stringify([{ ...peers[0], origin: "http://localhost:3202" }]),
    JSON.stringify([{ ...peers[0], origin: "http://127.0.0.1:3202/" }]),
    JSON.stringify([{ ...peers[0], origin: "https://127.0.0.1:3202" }]),
    JSON.stringify([
      { ...peers[0], origin: "http://127.0.0.1:3202?tenant=other" },
    ]),
    JSON.stringify([{ ...peers[0], token: "short" }]),
    JSON.stringify([{ ...peers[0], token: `${peers[0]!.token}\n` }]),
    JSON.stringify([{ ...peers[0], deadlineMs: 999 }]),
    JSON.stringify([{ ...peers[0], deadlineMs: 30001 }]),
    JSON.stringify([{ ...peers[0], deadlineMs: "1000" }]),
    JSON.stringify([{ ...peers[0], tenantId: "other-tenant" }]),
    JSON.stringify([{ origin: peers[0]!.origin }]),
    JSON.stringify([{ token: peers[0]!.token }]),
    `[${" ".repeat(16 * 1024)}]`,
  ])
    assert.throws(() =>
      resolveControlExtensionWorkerEnvironment(
        { ...current, CREWON_EXTENSION_HISTORICAL_HOSTS_JSON: value },
        "standalone",
      ),
    );
});

test("disabled historical configuration validates without any dispatch and production rejects it", (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => {
    calls++;
    throw new Error("unexpected fetch");
  });
  for (const enabled of [undefined, "0"]) {
    assert.equal(
      resolveControlExtensionWorkerEnvironment(
        {
          ...current,
          CREWON_EXTENSIONS_ENABLED: enabled,
          CREWON_EXTENSION_HISTORICAL_HOSTS_JSON: JSON.stringify(peers),
        },
        "standalone",
      ),
      undefined,
    );
    assert.throws(() =>
      resolveControlExtensionWorkerEnvironment(
        {
          ...current,
          CREWON_EXTENSIONS_ENABLED: enabled,
          CREWON_EXTENSION_HISTORICAL_HOSTS_JSON: "malformed",
        },
        "standalone",
      ),
    );
  }
  for (const value of ["[]", JSON.stringify(peers)]) {
    assert.throws(
      () =>
        resolveControlExtensionWorkerEnvironment(
          { CREWON_EXTENSION_HISTORICAL_HOSTS_JSON: value },
          "standalone",
        ),
      /configuration_incomplete/iu,
    );
    assert.throws(
      () =>
        resolveControlExtensionWorkerEnvironment(
          { CREWON_EXTENSION_HISTORICAL_HOSTS_JSON: value },
          "production",
        ),
      /configuration_forbidden/iu,
    );
    assert.throws(
      () =>
        resolveControlExtensionWorkerEnvironment(
          { ...current, CREWON_EXTENSION_HISTORICAL_HOSTS_JSON: value },
          "production",
        ),
      /configuration_forbidden/iu,
    );
  }
  assert.equal(calls, 0);
});
