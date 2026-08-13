const opaqueId = {
  type: "string",
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$",
} as const;
const nullableOpaqueId = {
  oneOf: [opaqueId, { type: "null" }],
} as const;

export const actionIntentJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.crewon.local/action-intent/v0",
  title: "ActionIntentV0",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "runId",
    "segmentId",
    "callId",
    "tool",
    "effect",
    "recovery",
    "policySnapshotId",
    "workspaceBindingId",
    "resourceBindingId",
    "credentialBindingId",
    "executionTarget",
    "capability",
    "approvalRequirement",
    "limits",
  ],
  properties: {
    schemaVersion: { const: "crewon.action-intent.v0" },
    runId: opaqueId,
    segmentId: opaqueId,
    callId: opaqueId,
    tool: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "name", "inputDigest"],
      properties: {
        kind: { enum: ["function", "custom"] },
        name: {
          type: "string",
          pattern: "^[A-Za-z0-9_.:-]{1,128}$",
        },
        inputDigest: {
          type: "string",
          pattern: "^sha256:[a-f0-9]{64}$",
        },
      },
    },
    effect: { enum: ["readOnly", "mutation"] },
    recovery: { enum: ["replaySafe", "reconcilable"] },
    policySnapshotId: opaqueId,
    workspaceBindingId: nullableOpaqueId,
    resourceBindingId: nullableOpaqueId,
    credentialBindingId: nullableOpaqueId,
    executionTarget: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "bindingId"],
      properties: {
        kind: { enum: ["control", "device", "docker", "remote"] },
        bindingId: opaqueId,
      },
    },
    capability: {
      type: "string",
      maxLength: 128,
      pattern: "^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+){0,15}$",
    },
    approvalRequirement: { enum: ["none", "perAction"] },
    limits: {
      type: "object",
      additionalProperties: false,
      required: ["timeoutMs", "maxOutputBytes", "maxArtifactBytes"],
      properties: {
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: 86_400_000,
        },
        maxOutputBytes: {
          type: "integer",
          minimum: 1,
          maximum: 1_048_576,
        },
        maxArtifactBytes: {
          type: "integer",
          minimum: 1,
          maximum: 1_073_741_824,
        },
      },
    },
  },
  allOf: [
    {
      if: { properties: { effect: { const: "mutation" } } },
      then: { properties: { recovery: { const: "reconcilable" } } },
    },
  ],
} as const;
