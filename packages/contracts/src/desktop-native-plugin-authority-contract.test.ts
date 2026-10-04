import assert from "node:assert/strict";
import test from "node:test";
import { parseDesktopNativePluginAuthority } from "./desktop-native-plugin-authority-contract.ts";
const digest = `sha256:${"a".repeat(64)}`;
function document() {
  const pkg = {
    pluginId: "example.image",
    publisherId: "example.publisher",
    version: "1.0.0",
    packageDigest: digest,
  };
  return {
    schemaVersion: "crewon.desktop-native-plugin-authority.v1",
    authorityId: "native-authority",
    actor: {
      principalId: "standalone-principal",
      actorId: "standalone-actor",
      tenantId: "standalone-tenant",
      spaceId: "standalone-space",
    },
    scope: {
      tenantId: "standalone-tenant",
      spaceId: "standalone-space",
      profileId: "profile-one",
    },
    installRoot: "/private/data/plugins",
    controlDatabasePath: "/private/data/control.sqlite",
    bootstrapPath: "/private/data/bootstrap.json",
    bootstrapDigest: digest,
    approvalPath: "/private/data/plugin-approvals.json",
    approvalDigest: digest,
    policyPath: "/private/data/plugin-native-policy.json",
    policyDigest: digest,
    profilePath: "/private/data/plugin-profile.json",
    profileDigest: digest,
    packages: [pkg],
    networkGrants: [
      {
        ...pkg,
        baseUrl: "https://example.com:8443/",
        baseUrlParameter: "baseUrl",
        paths: [
          { method: "POST", path: "/prompt" },
          { method: "GET", operationPathPrefix: "/history/" },
        ],
      },
    ],
  };
}
test("Native policy detaches and freezes exact actor, package, service and paths without granting runtime ownership", () => {
  const input = document(),
    parsed = parseDesktopNativePluginAuthority(input);
  input.networkGrants[0]!.baseUrl = "https://changed.example/";
  assert.equal(parsed.networkGrants[0]!.baseUrl, "https://example.com:8443/");
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.packages));
  assert.ok(Object.isFrozen(parsed.networkGrants[0]!.paths));
});
for (const [name, mutate] of [
  [
    "foreign owner",
    (value: ReturnType<typeof document>) => {
      value.actor.actorId = "foreign";
    },
  ],
  [
    "foreign profile tenant",
    (value: ReturnType<typeof document>) => {
      value.scope.tenantId = "foreign";
    },
  ],
  [
    "relative path",
    (value: ReturnType<typeof document>) => {
      value.installRoot = "./plugins";
    },
  ],
  [
    "traversal path",
    (value: ReturnType<typeof document>) => {
      value.bootstrapPath = "/private/../bootstrap.json";
    },
  ],
  [
    "duplicate package",
    (value: ReturnType<typeof document>) => {
      value.packages.push(value.packages[0]!);
    },
  ],
  [
    "unapproved network tuple",
    (value: ReturnType<typeof document>) => {
      value.networkGrants[0]!.publisherId = "foreign.publisher";
    },
  ],
  [
    "plaintext supplier",
    (value: ReturnType<typeof document>) => {
      value.networkGrants[0]!.baseUrl = "http://example.com/";
    },
  ],
  [
    "URL credentials",
    (value: ReturnType<typeof document>) => {
      value.networkGrants[0]!.baseUrl = "https://user:secret@example.com/";
    },
  ],
  [
    "URL query",
    (value: ReturnType<typeof document>) => {
      value.networkGrants[0]!.baseUrl = "https://example.com/?token=x";
    },
  ],
  [
    "URL subpath",
    (value: ReturnType<typeof document>) => {
      value.networkGrants[0]!.baseUrl = "https://example.com/api/";
    },
  ],
  [
    "duplicate network grant",
    (value: ReturnType<typeof document>) => {
      value.networkGrants.push(value.networkGrants[0]!);
    },
  ],
  [
    "network traversal",
    (value: ReturnType<typeof document>) => {
      value.networkGrants[0]!.paths[0]!.path = "/api/../prompt";
    },
  ],
  [
    "ambiguous network path",
    (value: ReturnType<typeof document>) => {
      value.networkGrants[0]!.paths[0]!.path = "//foreign/prompt";
    },
  ],
  [
    "duplicate path",
    (value: ReturnType<typeof document>) => {
      value.networkGrants[0]!.paths.push(value.networkGrants[0]!.paths[0]!);
    },
  ],
  [
    "prefix query",
    (value: ReturnType<typeof document>) => {
      value.networkGrants[0]!.paths[1]!.operationPathPrefix = "/history/?all/";
    },
  ],
] as const)
  test(`Native policy rejects ${name}`, () => {
    const input = document();
    mutate(input);
    assert.throws(
      () => parseDesktopNativePluginAuthority(input),
      /desktop_native_plugin_authority_invalid/u,
    );
  });
test("Native policy rejects getters without evaluating them", () => {
  let reads = 0;
  const input = document();
  Object.defineProperty(input, "authorityId", {
    enumerable: true,
    get() {
      reads++;
      return "grant";
    },
  });
  assert.throws(() => parseDesktopNativePluginAuthority(input));
  assert.equal(reads, 0);
});
test("Native policy rejects unknown fields and sparse arrays", () => {
  assert.throws(() =>
    parseDesktopNativePluginAuthority({ ...document(), allowAll: true }),
  );
  const input = document();
  input.packages.length = 3;
  assert.throws(() => parseDesktopNativePluginAuthority(input));
});
