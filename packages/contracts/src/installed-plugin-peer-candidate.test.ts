import assert from "node:assert/strict";
import test from "node:test";
import {
  INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL,
  INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
  INSTALLED_PLUGIN_PEER_WIRE_LIMITS,
  InstalledPluginPeerContractError,
  parseInstalledPluginPeerRequest,
  parseInstalledPluginPeerResponse,
  type InstalledPluginPeerPrepareCandidateRequest,
  type InstalledPluginPeerPrepareCandidateResponse,
} from "./plugins.ts";

const digest = `sha256:${"a".repeat(64)}`;
const actor = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
};
const scope = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  profileId: "profile-1",
};
const identity = {
  pluginId: "crewon.krea2",
  publisherId: "crewon",
  version: "1.0.0",
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
const request: InstalledPluginPeerPrepareCandidateRequest = {
  protocol: INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL,
  requestId: "request-1",
  operation: "prepareCandidate",
  actor,
  scope,
  identity,
  configuration: {
    revision: 2,
    contentDigest: digest,
    parameters: { endpoint: "https://fixture.example" },
  },
  expectedTarget: target,
  expectedSelectionRevision: 3,
};
const response: InstalledPluginPeerPrepareCandidateResponse = {
  protocol: INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
  requestId: request.requestId,
  operation: "prepareCandidate",
  actor,
  scope,
  identity,
  configurationDigest: digest,
  expectedTarget: target,
  expectedSelectionRevision: request.expectedSelectionRevision,
  result: { outcome: "ready", target },
};
function invalid(read: () => unknown): void {
  assert.throws(
    read,
    (error: unknown) => error instanceof InstalledPluginPeerContractError,
  );
}
function frozen(input: unknown): void {
  if (input === null || typeof input !== "object") return;
  assert.ok(Object.isFrozen(input));
  for (const value of Object.values(input)) frozen(value);
}

test("candidate request and response are detached deeply frozen private data", () => {
  const parsedRequest = parseInstalledPluginPeerRequest(request);
  const parsedResponse = parseInstalledPluginPeerResponse(response);
  assert.deepEqual(parsedRequest, request);
  assert.deepEqual(parsedResponse, response);
  assert.notEqual(parsedRequest, request);
  assert.ok(parsedRequest.operation === "prepareCandidate");
  assert.notEqual(parsedRequest.identity, identity);
  assert.notEqual(parsedResponse, response);
  frozen(parsedRequest);
  frozen(parsedResponse);
  assert.equal("activation" in parsedResponse, false);
  assert.equal("admission" in parsedResponse, false);
});

test("candidate accepts safe positive selection revisions independently of configuration revision", () => {
  for (const expectedSelectionRevision of [1, 7, Number.MAX_SAFE_INTEGER]) {
    const actual = parseInstalledPluginPeerRequest({
      ...request,
      expectedSelectionRevision,
    });
    assert.equal(actual.operation, "prepareCandidate");
    if (actual.operation === "prepareCandidate")
      assert.equal(actual.expectedSelectionRevision, expectedSelectionRevision);
    assert.equal(
      parseInstalledPluginPeerResponse({
        ...response,
        expectedSelectionRevision,
      }).operation,
      "prepareCandidate",
    );
  }
});

for (const expectedSelectionRevision of [
  0,
  -1,
  1.1,
  Number.MAX_SAFE_INTEGER + 1,
  NaN,
  Infinity,
  "3",
  null,
])
  test(`candidate rejects invalid selection revision ${String(expectedSelectionRevision)}`, () => {
    invalid(() =>
      parseInstalledPluginPeerRequest({
        ...request,
        expectedSelectionRevision,
      }),
    );
    invalid(() =>
      parseInstalledPluginPeerResponse({
        ...response,
        expectedSelectionRevision,
      }),
    );
  });

test("candidate requires its exact fields and does not extend the original readiness shape", () => {
  for (const [value, parser] of [
    [request, parseInstalledPluginPeerRequest],
    [response, parseInstalledPluginPeerResponse],
  ] as const) {
    invalid(() => parser({ ...value, enabled: true }));
    invalid(() => parser({ ...value, expectedSource: {} }));
    invalid(() =>
      parser({ ...value, protocol: "crewon.installed-plugin-peer-request.v0" }),
    );
    invalid(() => parser({ ...value, operation: "executeCandidate" }));
    for (const field of Object.keys(value)) {
      const partial: Record<string, unknown> = { ...value };
      delete partial[field];
      invalid(() => parser(partial));
    }
    invalid(() => parser({ ...value, operation: "readiness" }));
    const { expectedSelectionRevision: _, ...legacy } = value;
    assert.equal(
      parser({ ...legacy, operation: "readiness" }).operation,
      "readiness",
    );
  }
});

test("candidate requires full actor, profile, package and target tuples", () => {
  for (const [field, fixture] of [
    ["actor", actor],
    ["scope", scope],
    ["identity", identity],
    ["expectedTarget", target],
  ] as const) {
    for (const name of Object.keys(fixture)) {
      const partial: Record<string, unknown> = { ...fixture };
      delete partial[name];
      invalid(() =>
        parseInstalledPluginPeerRequest({ ...request, [field]: partial }),
      );
      invalid(() =>
        parseInstalledPluginPeerResponse({ ...response, [field]: partial }),
      );
    }
    invalid(() =>
      parseInstalledPluginPeerRequest({
        ...request,
        [field]: { ...fixture, sourcePath: "/tmp/private" },
      }),
    );
  }
  invalid(() =>
    parseInstalledPluginPeerRequest({
      ...request,
      identity: { ...identity, packageDigest: digest.toUpperCase() },
    }),
  );
});

test("candidate result retains the existing four unavailable reasons and exact ready target shape", () => {
  for (const reasonCode of [
    "extension_runtime_unavailable",
    "extension_implementation_unavailable",
    "extension_credential_unavailable",
    "extension_execution_authority_unsupported",
  ]) {
    const parsed = parseInstalledPluginPeerResponse({
      ...response,
      result: { outcome: "unavailable", reasonCode },
    });
    assert.equal(parsed.operation, "prepareCandidate");
    if (parsed.operation === "prepareCandidate")
      assert.deepEqual(parsed.result, { outcome: "unavailable", reasonCode });
  }
  invalid(() =>
    parseInstalledPluginPeerResponse({
      ...response,
      result: { outcome: "unavailable", reasonCode: "notInstalled" },
    }),
  );
  invalid(() =>
    parseInstalledPluginPeerResponse({
      ...response,
      result: { outcome: "ready", target, runId: "forged" },
    }),
  );
  invalid(() =>
    parseInstalledPluginPeerResponse({
      ...response,
      result: { outcome: "ready", target: { agentVersionId: "agent-1" } },
    }),
  );
});

test("candidate data does not evaluate getters or accept hidden fields, symbols, cycles or sparse arrays", () => {
  let getterCalls = 0;
  for (const [value, parser] of [
    [request, parseInstalledPluginPeerRequest],
    [response, parseInstalledPluginPeerResponse],
  ] as const) {
    const getter = { ...value };
    Object.defineProperty(getter, "expectedSelectionRevision", {
      enumerable: true,
      get: () => {
        getterCalls++;
        return 3;
      },
    });
    invalid(() => parser(getter));
    const hidden = { ...value };
    Object.defineProperty(hidden, "extra", { value: true, enumerable: false });
    invalid(() => parser(hidden));
    invalid(() => parser({ ...value, [Symbol("private")]: true }));
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.value = cyclic;
  invalid(() =>
    parseInstalledPluginPeerRequest({ ...request, configuration: cyclic }),
  );
  invalid(() =>
    parseInstalledPluginPeerRequest({
      ...request,
      configuration: { value: new Array(2) },
    }),
  );
  const nestedGetter = Object.defineProperty({}, "revision", {
    enumerable: true,
    get: () => {
      getterCalls++;
      return 2;
    },
  });
  invalid(() =>
    parseInstalledPluginPeerRequest({
      ...request,
      configuration: nestedGetter,
    }),
  );
  assert.equal(getterCalls, 0);
});

test("candidate keeps the existing bounded configuration and message limits", () => {
  invalid(() =>
    parseInstalledPluginPeerRequest({
      ...request,
      configuration: {
        value: "x".repeat(INSTALLED_PLUGIN_PEER_WIRE_LIMITS.configurationBytes),
      },
    }),
  );
  let deep: unknown = {};
  for (let index = 0; index < 25; index++) deep = { nested: deep };
  invalid(() =>
    parseInstalledPluginPeerRequest({ ...request, configuration: deep }),
  );
  invalid(() =>
    parseInstalledPluginPeerResponse({
      ...response,
      expectedTarget: {
        ...target,
        authorityId: "x".repeat(INSTALLED_PLUGIN_PEER_WIRE_LIMITS.messageBytes),
      },
    }),
  );
});
