import type { WorkflowObjectSchema } from "./workflow-schema.ts";

export const extensionTestSchema: WorkflowObjectSchema = {
  type: "object",
  properties: { prompt: { type: "string", maxLength: 2_000, enum: null } },
  required: ["prompt"],
  additionalProperties: false,
};

/** Synthetic declarations only: neither a real supplier nor a shipped plugin. */
export function extensionManifestFixture(pluginId = "example.video") {
  return {
    schemaVersion: "crewon.extension-manifest.v0",
    hostApi: "crewon.extensions.v0",
    pluginId,
    version: "0.1.0",
    title: "Example external API",
    description: "Synthetic external operation used by contract tests.",
    task: {
      instructions:
        "Prepare the input, submit once, and report the actual status.",
      inputSchema: extensionTestSchema,
    },
    configurationSchema: {
      type: "object",
      properties: {
        format: { type: "string", maxLength: 8, enum: ["mp4", "webm"] },
      },
      required: ["format"],
      additionalProperties: false,
    },
    credentialSlots: [{ id: "provider", title: "Service credential" }],
    tools: [
      {
        operationId: "submit",
        adapterId: "example.video-api",
        description: "Submit a generation request and return its job identity.",
        inputSchema: extensionTestSchema,
        outputSchema: {
          type: "object",
          properties: { jobId: { type: "string", maxLength: 128, enum: null } },
          required: ["jobId"],
          additionalProperties: false,
        },
        execution: "serial",
        effect: "mutation",
        recovery: "reconcilable",
        capability: "example.video.generate",
      },
    ],
    resultViews: ["externalOperation", "externalResult"],
  };
}
