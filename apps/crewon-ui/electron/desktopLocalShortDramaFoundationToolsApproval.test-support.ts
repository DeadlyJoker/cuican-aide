import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROJECT_FOUNDATION_TOOL_OPERATION_IDS,
  PROJECT_FOUNDATION_TOOL_OPERATIONS,
} from "@crewon/contracts/project-foundation-tools";
import { desktopLocalPluginSourceImportFixture } from "./desktopLocalPluginSourceImport.test-support.ts";

/** Real synthetic developer package bytes. This is not the released short-drama distribution. */
export function desktopFoundationToolsImportFixture(
  options: Readonly<{
    legacy?: boolean;
    wrongCapability?: boolean;
    missingOperation?: boolean;
  }> = {},
) {
  const f = desktopLocalPluginSourceImportFixture();
  const schema = {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  };
  const tools = PROJECT_FOUNDATION_TOOL_OPERATION_IDS.map((operationId) => {
    const write =
      operationId === PROJECT_FOUNDATION_TOOL_OPERATIONS.saveProposal;
    return {
      operationId,
      adapterId: "crewon.project-foundation-tools",
      description: "Actual fixture Foundation operation",
      inputSchema: schema,
      outputSchema: schema,
      execution: "serial",
      effect: write ? "mutation" : "readOnly",
      recovery: write ? "reconcilable" : "replaySafe",
      capability: write ? "project.write" : "project.read",
    };
  });
  if (options.wrongCapability) tools[0]!.capability = "project.write";
  if (options.missingOperation) tools.pop();
  const manifest = {
    schemaVersion: "crewon.extension-manifest.v2",
    hostApi: "crewon.extensions.v1",
    pluginId: "crewon.short-drama",
    version: "40.0.0",
    title: "Foundation protocol byte fixture",
    description:
      "Only original immutable Node declaration; no Comfy configuration or media execution",
    task: {
      inputSchema: schema,
      instructions: "Bounded read and candidate proposal only",
    },
    configurationSchema: schema,
    credentialSlots: [],
    tools,
    resultViews: ["text"],
  };
  if (!options.legacy) {
    const bytes = Buffer.from(JSON.stringify(manifest));
    f.files.set("business/manifest.json", bytes);
    writeFileSync(join(f.source, "business/manifest.json"), bytes, {
      mode: 0o644,
    });
  }
  f.writeDescriptor({
    ...f.descriptor,
    pluginId: "crewon.short-drama",
    version: options.legacy ? "39.0.0" : "40.0.0",
    requires: [
      { service: "crewon.execution", apiVersion: "1", optional: false },
      { service: "crewon.creative-projects", apiVersion: "1", optional: true },
      ...(options.legacy
        ? []
        : [
            {
              service: "crewon.project-foundation-tools",
              apiVersion: "1",
              optional: true,
            },
          ]),
    ],
    contributions: [
      {
        id: "workbench",
        kind: "module",
        slot: "main.content",
        title: "Foundation fixture",
      },
    ],
    files: [...f.files].map(([path, bytes]) => ({
      path,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  });
  return f;
}
