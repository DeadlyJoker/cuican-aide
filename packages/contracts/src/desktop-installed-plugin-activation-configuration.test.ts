import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_INSTALLED_PLUGIN_ACTIVATION_SCHEMA,
  DesktopInstalledPluginActivationContractError,
  parseDesktopInstalledPluginActivationConfiguration as parse,
} from "./plugins.ts";

const digest = `sha256:${"a".repeat(64)}`;
function fixture() {
  return {
    schemaVersion: DESKTOP_INSTALLED_PLUGIN_ACTIVATION_SCHEMA,
    actor: {
      principalId: "principal",
      actorId: "actor",
      tenantId: "tenant",
      spaceId: "space",
    },
    scope: { tenantId: "tenant", spaceId: "space", profileId: "profile" },
    installRoot: "/private/native/plugins",
    peer: {
      origin: "http://127.0.0.1:57123",
      tokenEnvironmentVariable: "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN",
    },
    authority: {
      url: "https://authority.example/activation",
      serviceTokenEnvironmentVariable: "NATIVE_ACTIVATION_AUTHORITY_TOKEN",
    },
    timeoutMs: 20000,
    entries: [
      {
        identity: {
          pluginId: "example.image",
          publisherId: "example.publisher",
          version: "1.0.0",
          packageDigest: digest,
          manifestDigest: digest,
          implementationDigest: digest,
        },
        configuration: {
          revision: 1,
          contentDigest: digest,
          values: { prompt: "你好" },
        },
        target: {
          executionAuthority: "crewonKernel",
          agentVersionId: "agent",
          agentVersionContentDigest: digest,
          materializationDigest: digest,
          authorityId: "authority",
          runtimeGeneration: "generation",
          policySnapshotId: "policy",
          workspaceBindingId: null as string | null,
        },
      },
    ],
  };
}
const rejects = (value: unknown) =>
  assert.throws(
    () => parse(value),
    DesktopInstalledPluginActivationContractError,
  );

test("activation publication is detached and deeply immutable", () => {
  const input = fixture();
  const actual = parse(input);
  assert.deepEqual(actual, input);
  input.entries[0]!.configuration.values.prompt = "changed";
  assert.equal(
    actual.entries[0]!.configuration.values &&
      (actual.entries[0]!.configuration.values as { prompt: string }).prompt,
    "你好",
  );
  assert.ok(Object.isFrozen(actual.entries[0]!.target));
  assert.ok(Object.isFrozen(actual.entries[0]!.configuration));
});
test("requires explicit v1 schema and exact private fields", () => {
  rejects({
    ...fixture(),
    schemaVersion: "crewon.desktop-installed-plugin-runtime.v2",
  });
  rejects({ ...fixture(), taskToken: "not-a-grant" });
  const { authority: _authority, ...withoutAuthority } = fixture();
  rejects(withoutAuthority);
});
test("actor and profile must belong to the same tenant and space", () => {
  for (const field of ["tenantId", "spaceId"] as const) {
    const value = fixture();
    value.scope[field] = "different";
    rejects(value);
  }
});
test("peer accepts only canonical actual IPv4 loopback origins with a nonzero port", () => {
  for (const origin of [
    "http://localhost:57123",
    "http://127.0.0.1:0",
    "http://127.0.0.1:65536",
    "http://127.0.0.1:057123",
    "http://127.0.0.1:57123/",
    "http://127.0.0.1:57123?",
    "http://user@127.0.0.1:57123",
    "https://127.0.0.1:57123",
    "http://127.0.0.2:57123",
  ])
    rejects({ ...fixture(), peer: { ...fixture().peer, origin } });
});
test("authority requires HTTPS without credentials, query, fragment or controls", () => {
  for (const url of [
    "http://authority.example/activate",
    "https://user:pass@authority.example/activate",
    "https://authority.example/activate?",
    "https://authority.example/activate#",
    "https://authority.example/activate?token=x",
    "https://authority.example/acti\nvate",
  ])
    rejects({ ...fixture(), authority: { ...fixture().authority, url } });
});
test("only independent environment references are accepted; never inline tokens", () => {
  for (const serviceTokenEnvironmentVariable of [
    "raw-secret-token",
    "HOME",
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "CREWON_CONTROL_SESSION_TOKEN",
    "CREWON_MODEL_API_KEY",
    "HTTP_PROXY",
    fixture().peer.tokenEnvironmentVariable,
  ])
    rejects({
      ...fixture(),
      authority: { ...fixture().authority, serviceTokenEnvironmentVariable },
    });
  rejects({
    ...fixture(),
    authority: { ...fixture().authority, serviceToken: "secret" },
  });
  rejects({
    ...fixture(),
    peer: { ...fixture().peer, tokenEnvironmentVariable: "TEST_PEER_TOKEN" },
  });
  assert.equal(
    parse({
      ...fixture(),
      authority: {
        ...fixture().authority,
        serviceTokenEnvironmentVariable:
          "CREWON_INSTALLED_PLUGIN_AUTHORITY_ACTIVATION",
      },
    }).authority.serviceTokenEnvironmentVariable,
    "CREWON_INSTALLED_PLUGIN_AUTHORITY_ACTIVATION",
  );
});
test("install root must be an absolute normalized Native path", () => {
  for (const installRoot of [
    "relative/plugins",
    "/",
    "/private/../plugins",
    "/private/./plugins",
    "/private//plugins",
    "/private/plugins/",
    "/private/plugins\0",
    "C:\\plugins",
  ])
    rejects({ ...fixture(), installRoot });
});
test("timeouts are bounded integers", () => {
  for (const timeoutMs of [0, 999, 30001, 2000.5, NaN, "20000"])
    rejects({ ...fixture(), timeoutMs });
  assert.equal(parse({ ...fixture(), timeoutMs: 1000 }).timeoutMs, 1000);
  assert.equal(parse({ ...fixture(), timeoutMs: 30000 }).timeoutMs, 30000);
});
test("complete package and target identities are required", () => {
  const input = fixture();
  rejects({
    ...input,
    entries: [
      {
        ...input.entries[0],
        identity: { ...input.entries[0]!.identity, implementationDigest: "a" },
      },
    ],
  });
  for (const target of [
    { ...input.entries[0]!.target, executionAuthority: "external" },
    { ...input.entries[0]!.target, materializationDigest: "a" },
    { ...input.entries[0]!.target, agentVersionId: "" },
    { ...input.entries[0]!.target, workspaceBindingId: false },
  ])
    rejects({ ...input, entries: [{ ...input.entries[0], target }] });
});
test("entry list is bounded, dense and cannot repeat the same semantic publication", () => {
  const input = fixture();
  rejects({ ...input, entries: [] });
  rejects({ ...input, entries: Array(101).fill(input.entries[0]) });
  rejects({ ...input, entries: Array(1) });
  rejects({
    ...input,
    entries: [
      input.entries[0],
      {
        ...input.entries[0],
        configuration: {
          values: { prompt: "你好" },
          contentDigest: digest,
          revision: 1,
        },
      },
    ],
  });
  const second = {
    ...input.entries[0]!,
    target: { ...input.entries[0]!.target, agentVersionId: "second-agent" },
  };
  assert.equal(
    parse({ ...input, entries: [input.entries[0], second] }).entries.length,
    2,
  );
});
test("per-entry configuration uses original private peer JSON bounds", () => {
  const input = fixture();
  rejects({
    ...input,
    entries: [{ ...input.entries[0], configuration: null }],
  });
  rejects({
    ...input,
    entries: [
      { ...input.entries[0], configuration: { oversized: "a".repeat(16384) } },
    ],
  });
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  rejects({
    ...input,
    entries: [{ ...input.entries[0], configuration: cycle }],
  });
});
test("validation never executes accessors or custom serialization", () => {
  let reads = 0;
  const input = fixture();
  Object.defineProperty(input, "authority", {
    enumerable: true,
    get() {
      reads++;
      throw new Error("getter");
    },
  });
  rejects(input);
  rejects({
    ...fixture(),
    toJSON() {
      reads++;
      return fixture();
    },
  });
  assert.equal(reads, 0);
});
