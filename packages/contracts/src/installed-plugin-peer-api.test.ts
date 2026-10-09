import assert from "node:assert/strict";
import test from "node:test";
import {
  INSTALLED_PLUGIN_PEER_PRIVATE_PATH,
  INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL,
  INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
  INSTALLED_PLUGIN_PEER_WIRE_LIMITS as limits,
  InstalledPluginPeerContractError,
  parseInstalledPluginPeerRequest,
  parseInstalledPluginPeerResponse,
  type InstalledPluginPeerJsonObject,
} from "./plugins.ts";
import {
  parseExtensionHostRequest,
  parseExtensionHostResponse,
} from "./extension-host-api.ts";

const digest = `sha256:${"a".repeat(64)}`;
const actor = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
};
const scope = {
  tenantId: actor.tenantId,
  spaceId: actor.spaceId,
  profileId: "profile-1",
};
const identity = {
  pluginId: "example.image",
  publisherId: "example.publisher",
  version: "1.0.0-beta.1+build.2",
  packageDigest: digest,
  manifestDigest: digest,
  implementationDigest: digest,
};
const target = {
  executionAuthority: "crewonKernel",
  agentVersionId: "agent-1",
  agentVersionContentDigest: digest,
  materializationDigest: digest,
  authorityId: "authority-1",
  runtimeGeneration: "generation-1",
  policySnapshotId: "policy-1",
  workspaceBindingId: null,
};
const expectedSource = {
  admission: {
    schemaVersion: "crewon.plugin-task-admission.v1",
    runId: "run-1",
  },
  binding: { runId: "run-1", target, source: null },
  operationId: "00000000-0000-0000-0000-000000000001",
};
const configuration = { revision: 1, contentDigest: digest };
const manifest = { pluginId: identity.pluginId, tools: [] };
const registration = { identity, manifest };
const entry = { ...registration, configuration, configuredTarget: target };
const requestCommon = {
  protocol: INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL,
  requestId: "request-1",
  actor,
  scope,
};
const responseCommon = {
  ...requestCommon,
  protocol: INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
};
const requests = [
  { ...requestCommon, operation: "catalog" },
  {
    ...requestCommon,
    operation: "validateConfiguration",
    identity,
    configuration,
  },
  {
    ...requestCommon,
    operation: "readiness",
    identity,
    configuration,
    expectedTarget: target,
  },
  { ...requestCommon, operation: "queryResolveRegistration", expectedSource },
  {
    ...requestCommon,
    operation: "queryReadiness",
    expectedSource,
    identity,
    configuration,
    expectedTarget: target,
  },
];
const responses = [
  { ...responseCommon, operation: "catalog", entries: [entry] },
  {
    ...responseCommon,
    operation: "validateConfiguration",
    identity,
    configurationDigest: digest,
  },
  {
    ...responseCommon,
    operation: "readiness",
    identity,
    configurationDigest: digest,
    expectedTarget: target,
    result: { outcome: "ready", target },
  },
  {
    ...responseCommon,
    operation: "queryResolveRegistration",
    expectedSource,
    registration,
  },
  {
    ...responseCommon,
    operation: "queryReadiness",
    expectedSource,
    identity,
    configurationDigest: digest,
    expectedTarget: target,
    result: { outcome: "ready", target },
  },
];
function invalid(read: () => unknown) {
  assert.throws(read, (error: unknown) => {
    assert.ok(error instanceof InstalledPluginPeerContractError);
    assert.equal(error.code, "installed_plugin_peer_contract_invalid");
    return true;
  });
}
function frozenDeep(input: unknown) {
  if (input === null || typeof input !== "object") return;
  assert.ok(Object.isFrozen(input));
  for (const value of Object.values(input)) frozenDeep(value);
}

test("publishes a separate private v1 entrypoint and fixed wire bounds", () => {
  assert.equal(
    INSTALLED_PLUGIN_PEER_PRIVATE_PATH,
    "/private/v1/installed-plugins",
  );
  assert.equal(limits.messageBytes, 512 * 1024);
  assert.equal(limits.configurationBytes, 16 * 1024);
  assert.equal(limits.entries, 100);
  assert.ok(Object.isFrozen(limits));
});
for (const request of requests)
  test(`copies and deeply freezes the ${request.operation} request`, () => {
    const parsed = parseInstalledPluginPeerRequest(request);
    assert.deepEqual(parsed, request);
    assert.notEqual(parsed, request);
    assert.notEqual(parsed.actor, actor);
    frozenDeep(parsed);
  });
for (const response of responses)
  test(`copies and deeply freezes the ${response.operation} response`, () => {
    const parsed = parseInstalledPluginPeerResponse(response);
    assert.deepEqual(parsed, response);
    assert.notEqual(parsed, response);
    frozenDeep(parsed);
  });

test("query resolution may return null and readiness accepts only the existing four reasons", () => {
  const resolved = parseInstalledPluginPeerResponse({
    ...responses[3],
    registration: null,
  });
  assert.equal(resolved.operation, "queryResolveRegistration");
  if (resolved.operation === "queryResolveRegistration")
    assert.equal(resolved.registration, null);
  for (const reasonCode of [
    "extension_runtime_unavailable",
    "extension_implementation_unavailable",
    "extension_credential_unavailable",
    "extension_execution_authority_unsupported",
  ])
    for (const response of [responses[2], responses[4]])
      assert.deepEqual(
        parseInstalledPluginPeerResponse({
          ...response,
          result: { outcome: "unavailable", reasonCode },
        }),
        { ...response, result: { outcome: "unavailable", reasonCode } },
      );
  invalid(() =>
    parseInstalledPluginPeerResponse({
      ...responses[4],
      result: { outcome: "unavailable", reasonCode: "allow" },
    }),
  );
});

test("all operations reject missing or unknown top-level fields and protocol drift", () => {
  for (const [values, parser] of [
    [requests, parseInstalledPluginPeerRequest],
    [responses, parseInstalledPluginPeerResponse],
  ] as const)
    for (const input of values) {
      invalid(() => parser({ ...input, extra: "forged" }));
      invalid(() =>
        parser({ ...input, protocol: "crewon.extension-host-request.v0" }),
      );
      invalid(() => parser({ ...input, operation: "execute" }));
      for (const field of Object.keys(input)) {
        const partial: Record<string, unknown> = { ...input };
        delete partial[field];
        invalid(() => parser(partial));
      }
    }
});

test("requires the full actor, profile scope, package identity and canonical digests", () => {
  for (const patch of [
    { actor: { ...actor, authorityId: "forged" } },
    { actor: { ...actor, principalId: "" } },
    { scope: { tenantId: scope.tenantId, spaceId: scope.spaceId } },
    { scope: { ...scope, privatePath: "/tmp/plugin" } },
    { identity: { ...identity, pluginVersion: "1.0.0" } },
    { identity: { ...identity, publisherId: "*" } },
    { identity: { ...identity, version: "^1.0.0" } },
    { identity: { ...identity, packageDigest: "sha256:bad" } },
    { identity: { ...identity, manifestDigest: digest.toUpperCase() } },
    { identity: { ...identity, implementationDigest: "" } },
  ]) {
    invalid(() =>
      parseInstalledPluginPeerRequest({ ...requests[2], ...patch }),
    );
    invalid(() =>
      parseInstalledPluginPeerResponse({ ...responses[2], ...patch }),
    );
  }
  invalid(() =>
    parseInstalledPluginPeerResponse({
      ...responses[1],
      configurationDigest: "bad",
    }),
  );
});

test("all expected and returned targets have the exact eight-field wire shape", () => {
  for (const field of Object.keys(target)) {
    const partial: Record<string, unknown> = { ...target };
    delete partial[field];
    invalid(() =>
      parseInstalledPluginPeerRequest({
        ...requests[2],
        expectedTarget: partial,
      }),
    );
    invalid(() =>
      parseInstalledPluginPeerResponse({
        ...responses[2],
        result: { outcome: "ready", target: partial },
      }),
    );
    invalid(() =>
      parseInstalledPluginPeerResponse({
        ...responses[0],
        entries: [{ ...entry, configuredTarget: partial }],
      }),
    );
  }
  for (const expectedTarget of [
    { ...target, endpoint: "https://forged.example" },
    { ...target, workspaceBindingId: {} },
    { ...target, agentVersionId: 1 },
  ])
    invalid(() =>
      parseInstalledPluginPeerRequest({ ...requests[4], expectedTarget }),
    );
  invalid(() =>
    parseInstalledPluginPeerResponse({
      ...responses[2],
      result: { outcome: "ready", target, reasonCode: "forged" },
    }),
  );
});

test("query provenance requires exact wrapper fields and bounded object records", () => {
  for (const source of [
    { ...expectedSource, receipt: {} },
    { ...expectedSource, sourceRunId: "other-run" },
    { ...expectedSource, admission: null },
    { ...expectedSource, binding: [] },
    { ...expectedSource, operationId: "not-an-operation" },
    { admission: expectedSource.admission, binding: expectedSource.binding },
  ])
    for (const index of [3, 4]) {
      invalid(() =>
        parseInstalledPluginPeerRequest({
          ...requests[index],
          expectedSource: source,
        }),
      );
      invalid(() =>
        parseInstalledPluginPeerResponse({
          ...responses[index],
          expectedSource: source,
        }),
      );
    }
  invalid(() =>
    parseInstalledPluginPeerResponse({
      ...responses[3],
      registration: { ...registration, sourceId: "forged" },
    }),
  );
});

test("DTO parsing does not promote source records, echo targets or actor scopes into authority", () => {
  const parsed = parseInstalledPluginPeerRequest(requests[4]);
  assert.equal(parsed.operation, "queryReadiness");
  if (parsed.operation !== "queryReadiness") assert.fail();
  assert.deepEqual(parsed.expectedSource.admission, expectedSource.admission);
  assert.notEqual(parsed.expectedSource.admission, expectedSource.admission);
  assert.deepEqual(Object.keys(parsed.expectedSource), [
    "admission",
    "binding",
    "operationId",
  ]);
  // The authenticated client/service must verify echoes, domain records and ownership independently.
  assert.equal(
    parseInstalledPluginPeerResponse({
      ...responses[2],
      result: {
        outcome: "ready",
        target: { ...target, agentVersionId: "different-agent" },
      },
    }).operation,
    "readiness",
  );
  assert.equal(
    parseInstalledPluginPeerRequest({
      ...requests[0],
      scope: { ...scope, tenantId: "other-tenant" },
    }).operation,
    "catalog",
  );
});

test("input mutation cannot alter saved identity, source, configuration or targets", () => {
  const input = structuredClone({
    ...requestCommon,
    operation: "queryReadiness",
    identity,
    configuration,
    expectedSource,
    expectedTarget: target,
  });
  const before = structuredClone(input);
  const parsed = parseInstalledPluginPeerRequest(input);
  input.actor.actorId = "other-actor";
  input.identity.packageDigest = `sha256:${"b".repeat(64)}`;
  input.expectedSource.binding.target.agentVersionId = "other-agent";
  input.configuration.revision = 2;
  assert.deepEqual(parsed, before);
});

test("opaque identifiers are bounded by UTF-8 bytes and reject blank/control/invalid Unicode", () => {
  for (const requestId of ["x".repeat(128), "汉".repeat(42)])
    assert.equal(
      parseInstalledPluginPeerRequest({ ...requests[0], requestId }).requestId,
      requestId,
    );
  for (const requestId of [
    "",
    " ",
    "x".repeat(129),
    "汉".repeat(43),
    "request\n",
    "a\u200bb",
    "\ud800",
  ])
    invalid(() =>
      parseInstalledPluginPeerRequest({ ...requests[0], requestId }),
    );
});

test("configuration JSON uses its exact encoded byte limit on requests and catalog entries", () => {
  const atLimit = { text: "x".repeat(limits.configurationBytes - 11) };
  assert.equal(
    Buffer.byteLength(JSON.stringify(atLimit)),
    limits.configurationBytes,
  );
  assert.equal(
    parseInstalledPluginPeerRequest({ ...requests[1], configuration: atLimit })
      .operation,
    "validateConfiguration",
  );
  for (const configuration of [
    { text: atLimit.text + "x" },
    { text: "汉".repeat(6000) },
    [],
  ]) {
    invalid(() =>
      parseInstalledPluginPeerRequest({ ...requests[1], configuration }),
    );
    invalid(() =>
      parseInstalledPluginPeerResponse({
        ...responses[0],
        entries: [{ ...entry, configuration }],
      }),
    );
  }
});

test("manifest, source and target have independent byte bounds", () => {
  invalid(() =>
    parseInstalledPluginPeerResponse({
      ...responses[3],
      registration: {
        identity,
        manifest: { text: "x".repeat(limits.manifestBytes) },
      },
    }),
  );
  for (const field of ["admission", "binding"])
    invalid(() =>
      parseInstalledPluginPeerRequest({
        ...requests[3],
        expectedSource: {
          ...expectedSource,
          [field]: { text: "x".repeat(limits.sourceBytes) },
        },
      }),
    );
  invalid(() =>
    parseInstalledPluginPeerRequest({
      ...requests[2],
      expectedTarget: {
        ...target,
        authorityId: "x".repeat(limits.targetBytes),
      },
    }),
  );
});

test("bounds the catalog count and complete message independently", () => {
  const entries = Array.from({ length: limits.entries }, (_, index) => ({
    ...entry,
    configuredTarget: { ...target, agentVersionId: `agent-${index}` },
  }));
  const parsed = parseInstalledPluginPeerResponse({ ...responses[0], entries });
  assert.equal(parsed.operation, "catalog");
  if (parsed.operation === "catalog") assert.equal(parsed.entries.length, 100);
  invalid(() =>
    parseInstalledPluginPeerResponse({
      ...responses[0],
      entries: [...entries, entry],
    }),
  );
  invalid(() =>
    parseInstalledPluginPeerResponse({
      ...responses[0],
      entries: Array.from({ length: 9 }, () => ({
        ...entry,
        manifest: { text: "x".repeat(limits.manifestBytes - 11) },
      })),
    }),
  );
});

test("rejects excessive depth and nodes even when the JSON bytes are small", () => {
  let nested: InstalledPluginPeerJsonObject = {};
  for (let index = 0; index < limits.jsonDepth + 1; index++)
    nested = { nested };
  invalid(() =>
    parseInstalledPluginPeerRequest({ ...requests[1], configuration: nested }),
  );
  invalid(() =>
    parseInstalledPluginPeerResponse({
      ...responses[0],
      entries: [
        { ...entry, manifest: { items: Array(limits.jsonNodes).fill(0) } },
      ],
    }),
  );
});

test("rejects unsafe own data without running getters, toJSON or iterators", () => {
  let hooks = 0;
  const accessor = Object.defineProperty({}, "secret", {
    enumerable: true,
    get() {
      hooks++;
      return "secret";
    },
  });
  const hidden = Object.defineProperty({}, "secret", {
    enumerable: false,
    value: "secret",
  });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const array = ["value"];
  Object.defineProperty(array, "0", {
    enumerable: true,
    get() {
      hooks++;
      return "value";
    },
  });
  for (const configuration of [
    accessor,
    hidden,
    cyclic,
    {
      toJSON() {
        hooks++;
        return {};
      },
    },
    {
      [Symbol.iterator]() {
        hooks++;
        return [];
      },
    },
    { array },
    { array: new Array(2) },
    { [Symbol("extra")]: true },
    Object.create({ inherited: true }),
    { when: new Date() },
    { value: NaN },
    { value: Infinity },
    { value: undefined },
    { value: 1n },
  ])
    invalid(() =>
      parseInstalledPluginPeerRequest({ ...requests[1], configuration }),
    );
  const ownGetter = Object.defineProperty({ ...requests[0] }, "actor", {
    enumerable: true,
    get() {
      hooks++;
      return actor;
    },
  });
  invalid(() => parseInstalledPluginPeerRequest(ownGetter));
  assert.equal(hooks, 0);
});

test("copies null-prototype JSON and an own __proto__ key without prototype pollution", () => {
  const configuration = Object.assign(
    Object.create(null),
    JSON.parse('{"__proto__":{"admin":true}}'),
  );
  const parsed = parseInstalledPluginPeerRequest({
    ...requests[1],
    configuration,
  });
  if (parsed.operation !== "validateConfiguration") assert.fail();
  assert.deepEqual(Object.keys(parsed.configuration), ["__proto__"]);
  assert.ok(Object.hasOwn(parsed.configuration, "__proto__"));
  assert.equal(Object.getPrototypeOf(parsed.configuration), Object.prototype);
  assert.equal(({} as { admin?: boolean }).admin, undefined);
});

test("keeps the original v0 extension-host contract and its three operations unchanged", () => {
  const oldRegistration = {
    pluginId: "example.image",
    pluginVersion: "1.0.0",
    manifestDigest: digest,
    implementationDigest: digest,
  };
  for (const operation of ["catalog", "validateConfiguration", "readiness"]) {
    const oldRequest = {
      protocol: "crewon.extension-host-request.v0",
      operation,
      actor,
      ...(operation !== "catalog"
        ? { registration: oldRegistration, configuration }
        : {}),
      ...(operation === "readiness" ? { agentVersionId: "agent-1" } : {}),
    };
    assert.deepEqual(parseExtensionHostRequest(oldRequest), oldRequest);
    invalid(() => parseInstalledPluginPeerRequest(oldRequest));
  }
  const oldResponse = {
    protocol: "crewon.extension-host-response.v0",
    operation: "readiness",
    actor,
    registration: oldRegistration,
    configurationDigest: digest,
    agentVersionId: "agent-1",
    result: { outcome: "ready", target: { agentVersionId: "agent-1" } },
  };
  assert.deepEqual(parseExtensionHostResponse(oldResponse), oldResponse);
  invalid(() => parseInstalledPluginPeerResponse(oldResponse));
});
