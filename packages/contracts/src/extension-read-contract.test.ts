import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ContractValidationError } from "./contract-validation-error.ts";
import {
  EXTENSION_EXTERNAL_OPERATION_STATUSES,
  MAX_EXTENSION_CATALOG_RESPONSE_BYTES,
  MAX_EXTENSION_CATALOG_SCHEMA_BYTES,
  MAX_EXTENSION_READ_RESPONSE_BYTES,
  parseExtensionCatalogResponse,
  parseExtensionRuntimeQuery,
  parseExtensionRuntimeResponse,
  parseExtensionRunId,
  parseGetExtensionTaskResponse,
} from "./extension-read-contract.ts";
import { RUN_STATUSES } from "./run-contract.ts";

const pluginId = "crewon.comfyui-krea2";
const digest = `sha256:${"a".repeat(64)}`;
const objectSchema = {
  type: "object",
  properties: { prompt: { type: "string", maxLength: 4000, enum: null } },
  required: ["prompt"],
  additionalProperties: false,
};
const entry = {
  pluginId,
  pluginVersion: "1.0.0",
  title: "ComfyUI",
  description: "Generate an image.",
  inputSchema: objectSchema,
  configurationSchema: objectSchema,
  credentialSlots: [{ id: "provider_key", title: "Provider key" }],
  resultViews: ["text", "externalOperation", "externalResult"],
};
const target = {
  executionAuthority: "crewonKernel",
  agentVersionId: "plugin-agent",
  agentVersionContentDigest: digest,
  materializationDigest: digest,
  authorityId: "plugin-authority",
  runtimeGeneration: "ts-v0",
  policySnapshotId: "plugin-policy",
  workspaceBindingId: null,
};
const runtime = {
  pluginId,
  agentVersionId: "plugin-agent",
  configurationRevision: 1,
  readiness: { outcome: "ready", target },
};
const operation = {
  operationId: "12345678-1234-1234-1234-123456789abc",
  sourceRunId: "run-1",
  status: "succeeded",
  observedAt: "2026-10-01T00:00:00.000Z",
  images: [{ url: "https://comfy.example/result.png", filename: "result.png" }],
};
const task = {
  runId: "run-1",
  threadId: "thread-1",
  pluginId,
  pluginVersion: "1.0.0",
  configurationRevision: 1,
  runStatus: "completed",
  sourceRunId: null,
  operations: [operation],
  truncated: false,
};

test("catalog returns bounded detached immutable reviewed metadata without runtime authority", () => {
  const source = structuredClone({ extensions: [entry] });
  const parsed = parseExtensionCatalogResponse(source);
  assert.deepEqual(parsed, source);
  assert.deepEqual(parseExtensionCatalogResponse({ extensions: [] }), {
    extensions: [],
  });
  source.extensions[0]!.inputSchema.properties.prompt.maxLength = 10;
  assert.equal(
    (
      parsed.extensions[0]!.inputSchema.properties as Record<
        string,
        { maxLength: number }
      >
    ).prompt!.maxLength,
    4000,
  );
  assert.ok(Object.isFrozen(parsed.extensions[0]!.inputSchema));
  assert.ok(Object.isFrozen(parsed.extensions));
  assert.deepEqual(
    Object.keys(parsed.extensions[0]!).sort(),
    [
      "pluginId",
      "pluginVersion",
      "title",
      "description",
      "inputSchema",
      "configurationSchema",
      "credentialSlots",
      "resultViews",
    ].sort(),
  );
});

test("catalog rejects private manifest fields, duplicate identities and malformed schema metadata", () => {
  for (const malformed of [
    { ...entry, instructions: "private" },
    { ...entry, tools: [] },
    { ...entry, implementationDigest: digest },
    { ...entry, pluginId: "invalid" },
    { ...entry, pluginVersion: "latest" },
    {
      ...entry,
      credentialSlots: [...entry.credentialSlots, ...entry.credentialSlots],
    },
    { ...entry, resultViews: ["text", "text"] },
    { ...entry, resultViews: [] },
    { ...entry, resultViews: ["executable"] },
    { ...entry, inputSchema: [] },
    { ...entry, configurationSchema: { type: "string" } },
    { ...entry, title: "中".repeat(54) },
    { ...entry, description: "x".repeat(1025) },
  ])
    assert.throws(
      () => parseExtensionCatalogResponse({ extensions: [malformed] }),
      ContractValidationError,
    );
  assert.throws(
    () => parseExtensionCatalogResponse({ extensions: [entry, entry] }),
    ContractValidationError,
  );
  assert.throws(
    () =>
      parseExtensionCatalogResponse({
        extensions: Array.from({ length: 33 }, (_, index) => ({
          ...entry,
          pluginId: `crewon.plugin${index}`,
        })),
      }),
    ContractValidationError,
  );
});

test("catalog enforces total, per-schema, depth and node bounds before exposing metadata", () => {
  for (const inputSchema of [
    { type: "object", value: "x".repeat(MAX_EXTENSION_CATALOG_SCHEMA_BYTES) },
    { type: "object", value: Array.from({ length: 8193 }, () => null) },
  ])
    assert.throws(
      () =>
        parseExtensionCatalogResponse({
          extensions: [{ ...entry, inputSchema }],
        }),
      ContractValidationError,
    );
  let nested: unknown = 1;
  for (let index = 0; index < 25; index++) nested = { nested };
  assert.throws(
    () =>
      parseExtensionCatalogResponse({
        extensions: [{ ...entry, inputSchema: { type: "object", nested } }],
      }),
    ContractValidationError,
  );
  assert.throws(
    () =>
      parseExtensionCatalogResponse({
        extensions: [
          {
            ...entry,
            description: "x".repeat(MAX_EXTENSION_CATALOG_RESPONSE_BYTES),
          },
        ],
      }),
    ContractValidationError,
  );
});

test("runtime query requires one canonical explicit version and configuration revision", () => {
  const query = { agentVersionId: "plugin-agent", configurationRevision: "2" };
  assert.deepEqual(parseExtensionRuntimeQuery(query), {
    agentVersionId: "plugin-agent",
    configurationRevision: 2,
  });
  assert.deepEqual(
    parseExtensionRuntimeQuery(
      Object.assign(Object.create({ parserOwned: true }), query),
    ),
    { agentVersionId: "plugin-agent", configurationRevision: 2 },
  );
  for (const invalid of [
    {},
    { agentVersionId: "plugin-agent" },
    { ...query, tenantId: "other" },
    { ...query, configurationRevision: "01" },
    { ...query, configurationRevision: 2 },
    { ...query, configurationRevision: "2147483648" },
    { ...query, configurationRevision: ["1", "2"] },
    { ...query, agentVersionId: "" },
  ])
    assert.throws(
      () => parseExtensionRuntimeQuery(invalid),
      ContractValidationError,
    );
  assert.throws(
    () =>
      parseExtensionRuntimeQuery({
        ...query,
        get configurationRevision() {
          return assert.fail("getter invoked");
        },
      }),
    ContractValidationError,
  );
});

test("runtime read preserves existing readiness outcomes and checks every requested echo", () => {
  assert.deepEqual(parseExtensionRuntimeResponse(runtime, runtime), runtime);
  for (const reasonCode of [
    "extension_runtime_unavailable",
    "extension_implementation_unavailable",
    "extension_credential_unavailable",
    "extension_execution_authority_unsupported",
  ])
    assert.deepEqual(
      parseExtensionRuntimeResponse({
        ...runtime,
        readiness: { outcome: "unavailable", reasonCode },
      }).readiness,
      { outcome: "unavailable", reasonCode },
    );
  for (const expected of [
    { ...runtime, pluginId: "other.plugin" },
    { ...runtime, agentVersionId: "other-agent" },
    { ...runtime, configurationRevision: 2 },
  ])
    assert.throws(
      () => parseExtensionRuntimeResponse(runtime, expected),
      ContractValidationError,
    );
});

test("runtime ready targets cannot substitute provider authority or a different selected Agent", () => {
  for (const readiness of [
    {
      outcome: "ready",
      target: { ...target, executionAuthority: "providerAgent" },
    },
    { outcome: "ready", target: { ...target, agentVersionId: "other-agent" } },
    {
      outcome: "ready",
      target: { ...target, materializationDigest: "claimed" },
    },
    { outcome: "ready", target: { ...target, privateField: true } },
    { outcome: "unavailable", reasonCode: "arbitrary" },
    {
      outcome: "unavailable",
      reasonCode: "extension_runtime_unavailable",
      target,
    },
    { kind: "ready", target },
  ])
    assert.throws(
      () => parseExtensionRuntimeResponse({ ...runtime, readiness }),
      ContractValidationError,
    );
});

test("task result accepts the exact Run and external operation status vocabularies", () => {
  for (const runStatus of RUN_STATUSES)
    for (const status of EXTENSION_EXTERNAL_OPERATION_STATUSES)
      assert.deepEqual(
        parseGetExtensionTaskResponse({
          task: { ...task, runStatus, operations: [{ ...operation, status }] },
        }),
        {
          task: { ...task, runStatus, operations: [{ ...operation, status }] },
        },
      );
  const queryTask = { ...task, runId: "query-run", sourceRunId: "run-1" };
  assert.deepEqual(
    parseGetExtensionTaskResponse(
      { task: queryTask },
      { pluginId, runId: "query-run" },
    ),
    { task: queryTask },
  );
});

test("task responses reject unrelated identities, unknown statuses and private operation data", () => {
  for (const expected of [
    { pluginId: "other.plugin", runId: "run-1" },
    { pluginId, runId: "other-run" },
  ])
    assert.throws(
      () => parseGetExtensionTaskResponse({ task }, expected),
      ContractValidationError,
    );
  for (const malformed of [
    { ...task, tenantId: "private" },
    { ...task, runStatus: "done" },
    { ...task, sourceRunId: "run-1" },
    { ...task, truncated: "yes" },
    { ...task, configurationRevision: 0 },
    { ...task, threadId: "中".repeat(43) },
    { ...task, operations: [operation, operation] },
  ])
    assert.throws(
      () => parseGetExtensionTaskResponse({ task: malformed }),
      ContractValidationError,
    );
  for (const malformed of [
    { ...operation, providerOperationId: "private" },
    { ...operation, operationId: "not-uuid" },
    { ...operation, sourceRunId: "other-run" },
    { ...operation, status: "complete" },
    { ...operation, observedAt: "2026-10-01" },
  ])
    assert.throws(
      () =>
        parseGetExtensionTaskResponse({
          task: { ...task, operations: [malformed] },
        }),
      ContractValidationError,
    );
});

test("external result links allow only HTTPS references without credentials, fragments or extra fields", () => {
  const multilingual = "中".repeat(250) + ".png";
  assert.equal(
    parseGetExtensionTaskResponse({
      task: {
        ...task,
        operations: [
          {
            ...operation,
            images: [{ ...operation.images[0], filename: multilingual }],
          },
        ],
      },
    }).task.operations[0]!.images[0]!.filename,
    multilingual,
  );
  for (const url of [
    "http://comfy.example/result",
    "javascript:alert(1)",
    "data:image/png;base64,foo",
    "https://user:secret@comfy.example/result",
    "https://comfy.example/result#private",
    "https://comfy.example/result#",
    "not-url",
    "https://comfy.example/" + "x".repeat(4096),
  ])
    assert.throws(
      () =>
        parseGetExtensionTaskResponse({
          task: {
            ...task,
            operations: [
              { ...operation, images: [{ url, filename: "result.png" }] },
            ],
          },
        }),
      ContractValidationError,
    );
  assert.throws(
    () =>
      parseGetExtensionTaskResponse({
        task: {
          ...task,
          operations: [
            {
              ...operation,
              images: [{ ...operation.images[0], bytes: "private" }],
            },
          ],
        },
      }),
    ContractValidationError,
  );
});

test("task projections enforce operation/image cardinality and total wire bytes", () => {
  assert.throws(
    () =>
      parseGetExtensionTaskResponse({
        task: {
          ...task,
          operations: Array.from({ length: 17 }, () => operation),
        },
      }),
    ContractValidationError,
  );
  assert.throws(
    () =>
      parseGetExtensionTaskResponse({
        task: {
          ...task,
          operations: [
            {
              ...operation,
              images: Array.from({ length: 17 }, () => operation.images[0]),
            },
          ],
        },
      }),
    ContractValidationError,
  );
  const operations = Array.from({ length: 16 }, (_, index) => ({
    ...operation,
    operationId: `12345678-1234-1234-1234-${String(index).padStart(12, "0")}`,
    images: Array.from({ length: 16 }, () => ({
      url: "https://comfy.example/" + "x".repeat(600),
      filename: "result.png",
    })),
  }));
  assert.ok(
    new TextEncoder().encode(JSON.stringify({ task: { ...task, operations } }))
      .length > MAX_EXTENSION_READ_RESPONSE_BYTES,
  );
  assert.throws(
    () => parseGetExtensionTaskResponse({ task: { ...task, operations } }),
    ContractValidationError,
  );
});

test("read contracts inspect data descriptors and reject cycles, sparse arrays and malformed Unicode", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const sparse = Array(1);
  const hidden = Object.defineProperty({ extensions: [] }, "private", {
    value: "hidden",
  });
  for (const input of [
    {
      get extensions() {
        return assert.fail("getter invoked");
      },
    },
    { extensions: [{ ...entry, inputSchema: { type: "object", cycle } }] },
    { extensions: sparse },
    hidden,
    { extensions: [], [Symbol("secret")]: true },
    {
      extensions: [
        { ...entry, inputSchema: { type: "object", value: "\ud800" } },
      ],
    },
  ])
    assert.throws(
      () => parseExtensionCatalogResponse(input),
      ContractValidationError,
    );
  for (const runId of [
    "",
    "run\n",
    " x",
    "x".repeat(129),
    "\ud800",
    ".",
    "..",
    "run/1",
    "run\\1",
  ])
    assert.throws(() => parseExtensionRunId(runId), ContractValidationError);
});

test("OpenAPI exposes three read-only opt-in routes with explicit runtime query and safe projections", () => {
  const api = JSON.parse(
    readFileSync(
      new URL("../openapi/control-api.v1.json", import.meta.url),
      "utf8",
    ),
  );
  for (const path of [
    "/api/v1/extensions",
    "/api/v1/extensions/{pluginId}/runtime",
    "/api/v1/extensions/{pluginId}/tasks/{runId}",
  ]) {
    assert.deepEqual(Object.keys(api.paths[path]), ["get"]);
    assert.equal(api.paths[path].get.requestBody, undefined);
  }
  const requiredQuery = api.paths[
    "/api/v1/extensions/{pluginId}/runtime"
  ].get.parameters.filter((value: { in: string }) => value.in === "query");
  assert.deepEqual(
    requiredQuery.map((value: { name: string }) => value.name),
    ["agentVersionId", "configurationRevision"],
  );
  assert.ok(
    requiredQuery.every((value: { required: boolean }) => value.required),
  );
  assert.equal(
    api.components.schemas.ExtensionCatalogEntry.properties.instructions,
    undefined,
  );
  assert.equal(
    api.components.schemas.ExtensionCatalogEntry.properties
      .implementationDigest,
    undefined,
  );
  assert.equal(
    api.components.schemas.ExtensionTaskOperation.properties
      .providerOperationId,
    undefined,
  );
  assert.equal(
    api.components.schemas.ExtensionTaskView.properties.runStatus.$ref,
    "#/components/schemas/RunStatus",
  );
});
