import assert from "node:assert/strict";
import test from "node:test";
import {
  EXTENSION_HOST_PRIVATE_PATH,
  EXTENSION_HOST_WIRE_LIMITS,
  ExtensionHostContractError,
  parseExtensionHostRequest,
  parseExtensionHostResponse,
} from "./extension-host-api.ts";

const actor = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
};
const digest = `sha256:${"a".repeat(64)}`;
const registration = {
  pluginId: "example.video",
  pluginVersion: "0.1.0",
  manifestDigest: digest,
  implementationDigest: digest,
};
const request = {
  protocol: "crewon.extension-host-request.v0",
  operation: "readiness",
  actor,
  registration,
  configuration: { contentDigest: digest },
  agentVersionId: "agent-1",
};
const response = {
  protocol: "crewon.extension-host-response.v0",
  operation: "readiness",
  actor,
  registration,
  configurationDigest: digest,
  agentVersionId: "agent-1",
  result: { outcome: "ready", target: { agentVersionId: "agent-1" } },
};

test("freezes the private protocol and bounds all three operations", () => {
  assert.equal(EXTENSION_HOST_PRIVATE_PATH, "/private/v0/extensions");
  assert.deepEqual(parseExtensionHostRequest(request), request);
  const parsed = parseExtensionHostResponse(response);
  assert.deepEqual(parsed, response);
  assert.ok(Object.isFrozen(parsed.actor));
  assert.ok(Object.isFrozen(parsed));
  assert.deepEqual(
    parseExtensionHostRequest({
      protocol: request.protocol,
      operation: "catalog",
      actor,
    }),
    { protocol: request.protocol, operation: "catalog", actor },
  );
  assert.throws(
    () =>
      parseExtensionHostRequest({
        ...request,
        operation: "validateConfiguration",
        agentVersionId: undefined,
      }),
    ExtensionHostContractError,
  );
});

test("parses configuration validation and unavailable outcomes with exact fields", () => {
  const { agentVersionId: _, ...configurationRequest } = request;
  assert.equal(
    parseExtensionHostRequest({
      ...configurationRequest,
      operation: "validateConfiguration",
    }).operation,
    "validateConfiguration",
  );
  const {
    agentVersionId: _agent,
    result: _result,
    ...configurationResponse
  } = response;
  assert.equal(
    parseExtensionHostResponse({
      ...configurationResponse,
      operation: "validateConfiguration",
    }).operation,
    "validateConfiguration",
  );
  for (const reasonCode of [
    "extension_runtime_unavailable",
    "extension_implementation_unavailable",
    "extension_credential_unavailable",
    "extension_execution_authority_unsupported",
  ])
    assert.deepEqual(
      parseExtensionHostResponse({
        ...response,
        result: { outcome: "unavailable", reasonCode },
      }),
      { ...response, result: { outcome: "unavailable", reasonCode } },
    );
});

test("rejects version drift, extra fields, identity injection and malformed digests", () => {
  for (const value of [
    { ...request, protocol: "crewon.extension-host-request.v1" },
    { ...request, operation: "execute" },
    { ...request, route: "/prompt" },
    { ...request, actor: { ...actor, authorityId: "forged" } },
    { ...request, actor: { ...actor, principalId: "" } },
    {
      ...request,
      registration: { ...registration, implementationDigest: "sha256:bad" },
    },
    { ...request, registration: { ...registration, pluginVersion: "^0.1.0" } },
  ])
    assert.throws(
      () => parseExtensionHostRequest(value),
      ExtensionHostContractError,
    );
  for (const value of [
    { ...response, endpoint: "https://secret.example" },
    {
      ...response,
      result: { outcome: "unavailable", reasonCode: "unexpected" },
    },
    {
      ...response,
      result: { outcome: "ready", target: {}, reasonCode: "forged" },
    },
    { ...response, configurationDigest: "sha256:bad" },
  ])
    assert.throws(
      () => parseExtensionHostResponse(value),
      ExtensionHostContractError,
    );
});

test("bounds configuration, total messages, catalog entries, nodes and depth before domain processing", () => {
  assert.throws(
    () =>
      parseExtensionHostRequest({
        ...request,
        configuration: {
          text: "a".repeat(EXTENSION_HOST_WIRE_LIMITS.configurationBytes),
        },
      }),
    ExtensionHostContractError,
  );
  assert.throws(
    () =>
      parseExtensionHostResponse({
        protocol: response.protocol,
        operation: "catalog",
        actor,
        registrations: Array.from({ length: 33 }, () => ({
          manifest: {},
          manifestDigest: digest,
          implementationDigest: digest,
        })),
      }),
    ExtensionHostContractError,
  );
  assert.throws(
    () =>
      parseExtensionHostResponse({
        protocol: response.protocol,
        operation: "catalog",
        actor,
        registrations: [
          {
            manifest: {
              text: "a".repeat(EXTENSION_HOST_WIRE_LIMITS.messageBytes),
            },
            manifestDigest: digest,
            implementationDigest: digest,
          },
        ],
      }),
    ExtensionHostContractError,
  );
  assert.throws(
    () =>
      parseExtensionHostRequest({
        ...request,
        configuration: { items: Array(8192).fill(null) },
      }),
    ExtensionHostContractError,
  );
  let nested: unknown = null;
  for (let index = 0; index < 30; index += 1) nested = { nested };
  assert.throws(
    () => parseExtensionHostRequest({ ...request, configuration: { nested } }),
    ExtensionHostContractError,
  );
});

test("never invokes accessors and rejects cycles, sparse arrays, custom prototypes and invalid Unicode", () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "contentDigest", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return digest;
    },
  });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const configuration of [
    accessor,
    cyclic,
    { list: new Array(2) },
    new Date(),
    { text: "\ud800" },
    { text: undefined },
  ])
    assert.throws(
      () => parseExtensionHostRequest({ ...request, configuration }),
      ExtensionHostContractError,
    );
  assert.equal(getterCalls, 0);
});
