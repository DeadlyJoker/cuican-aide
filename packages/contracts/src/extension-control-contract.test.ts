import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { ContractValidationError } from "./contract-validation-error.ts";
import {
  parseExtensionPluginId,
  parseExtensionIdempotencyKey,
  parseExtensionConfigurationQuery,
  parseExtensionEmptyQuery,
  parseSaveExtensionConfigurationRequest,
  parseSetExtensionActivationRequest,
} from "./extension-control-contract.ts";

const save = {
  pluginVersion: "1.0.0",
  expectedRevision: 0,
  parameters: { serviceUrl: "https://example.com/" },
  credentialBindings: [],
};
const activate = {
  configurationRevision: 1,
  expectedRevision: 0,
  state: "enabled",
  agentVersionId: "agent-1",
};
test("extension requests accept only non-secret configuration and an explicit activation target", () => {
  assert.deepEqual(parseSaveExtensionConfigurationRequest(save), save);
  assert.deepEqual(parseSetExtensionActivationRequest(activate), activate);
  for (const state of ["disabled", "revoked"])
    assert.equal(
      parseSetExtensionActivationRequest({
        ...activate,
        state,
        agentVersionId: null,
      }).agentVersionId,
      null,
    );
  for (const patch of [
    { tenantId: "other" },
    { implementationDigest: "claimed" },
    { expectedRevision: -1 },
    { pluginVersion: "latest" },
    {
      credentialBindings: [
        { slotId: "key", credentialBindingId: "ref", secret: "secret" },
      ],
    },
  ])
    assert.throws(
      () => parseSaveExtensionConfigurationRequest({ ...save, ...patch }),
      ContractValidationError,
    );
  for (const patch of [
    { state: "enabled", agentVersionId: null },
    { state: "disabled" },
    { state: "unknown" },
    { target: {} },
    { configurationRevision: 0 },
  ])
    assert.throws(
      () => parseSetExtensionActivationRequest({ ...activate, ...patch }),
      ContractValidationError,
    );
  const duplicate = { slotId: "provider", credentialBindingId: "ref" };
  assert.throws(
    () =>
      parseSaveExtensionConfigurationRequest({
        ...save,
        credentialBindings: [duplicate, duplicate],
      }),
    /slot_duplicate/u,
  );
});
test("extension parameters are bounded detached JSON without executable accessors", () => {
  const input = { ...save, parameters: { nested: [1, true, null, "ok"] } };
  const result = parseSaveExtensionConfigurationRequest(input);
  input.parameters.nested.push("later");
  assert.deepEqual(result.parameters.nested, [1, true, null, "ok"]);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let deep: unknown = "x";
  for (let i = 0; i < 25; i++) deep = { value: deep };
  for (const parameters of [
    [],
    null,
    { value: "x".repeat(16_384) },
    { value: "\ud800" },
    { value: undefined },
    cycle,
    deep,
    {
      get value() {
        return assert.fail("getter invoked");
      },
    },
  ])
    assert.throws(
      () => parseSaveExtensionConfigurationRequest({ ...save, parameters }),
      ContractValidationError,
    );
});
test("extension identifiers and queries do not accept alternate scope or ambiguous revisions", () => {
  assert.equal(
    parseExtensionPluginId("crewon.comfyui-krea2"),
    "crewon.comfyui-krea2",
  );
  assert.deepEqual(parseExtensionConfigurationQuery({}), { revision: null });
  assert.deepEqual(parseExtensionConfigurationQuery({ revision: "3" }), {
    revision: 3,
  });
  for (const query of [
    null,
    [],
    { revision: "01" },
    { revision: ["1", "2"] },
    { revision: "2147483648" },
    { revision: "1e2" },
    { tenantId: "other" },
  ])
    assert.throws(
      () => parseExtensionConfigurationQuery(query),
      ContractValidationError,
    );
  for (const id of [
    "invalid",
    "space/plugin",
    "crewon..comfy",
    "crewon.comfy\n",
  ])
    assert.throws(() => parseExtensionPluginId(id), ContractValidationError);
  for (const key of [undefined, ["a", "b"], "x".repeat(129), "key\n", "\ud800"])
    assert.throws(
      () => parseExtensionIdempotencyKey(key),
      ContractValidationError,
    );
  assert.throws(
    () => parseExtensionEmptyQuery({ revision: "1" }),
    ContractValidationError,
  );
});
test("OpenAPI describes opt-in extension routes with required mutation headers and strict bodies", () => {
  const api = JSON.parse(
    readFileSync(
      new URL("../openapi/control-api.v1.json", import.meta.url),
      "utf8",
    ),
  );
  for (const kind of ["configuration", "activation"]) {
    const route = api.paths[`/api/v1/extensions/{pluginId}/${kind}`];
    assert.deepEqual(Object.keys(route).sort(), ["get", "put"]);
    assert.ok(
      route.put.parameters.some(
        (item: { name?: string; required?: boolean }) =>
          item.name === "Idempotency-Key" && item.required === true,
      ),
    );
    assert.ok(
      route.put.parameters.some(
        (item: { $ref?: string }) =>
          item.$ref === "#/components/parameters/CsrfToken",
      ),
    );
    const requestName = route.put.requestBody.content[
      "application/json"
    ].schema.$ref
      .split("/")
      .at(-1);
    const schema = api.components.schemas[requestName];
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.tenantId, undefined);
    assert.equal(schema.properties.implementationDigest, undefined);
  }
});
