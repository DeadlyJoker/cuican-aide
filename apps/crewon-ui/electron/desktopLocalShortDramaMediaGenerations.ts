import { isDeepStrictEqual } from "node:util";
import type { ExtensionManifest } from "@crewon/domain";
import type { PackageSnapshot } from "../../../packages/plugin-host/src/local-plugin-package-verifier.ts";
import type { DesktopLocalPluginExecutionPreview } from "../src/lib/desktop/desktopLocalPluginExecutionSetupProtocol.ts";
import type { captureDesktopLocalShortDramaMediaInputs } from "./desktopLocalShortDramaMediaInputs.ts";
import {
  parseDesktopPluginApproval,
  type DesktopPluginApprovalSettings,
} from "./desktopPluginBootstrap.ts";

type Inputs = ReturnType<typeof captureDesktopLocalShortDramaMediaInputs>;
type Preview = NonNullable<
  DesktopLocalPluginExecutionPreview["mediaGenerationPreparation"]
>;
export const SHORT_MEDIA_UPLOAD_PATHS: Preview["additionalNetworkPaths"] =
  Object.freeze([Object.freeze({ method: "POST", path: "/upload/image" })]);

export function shortDramaMediaUploadPaths(
  protocol: unknown,
): Preview["additionalNetworkPaths"] {
  if (protocol === undefined || protocol === "native")
    return SHORT_MEDIA_UPLOAD_PATHS;
  if (protocol === "workflow-panel-v1" || protocol === "workflow-api-v1")
    return Object.freeze([
      Object.freeze({ method: "POST", path: "/api/comfy/upload/file" }),
    ]);
  return invalid();
}

/** Offer generation only from verified package data; metadata preparation grants no execution. */
export function captureDesktopLocalShortDramaMediaGenerations(input: {
  snapshot: PackageSnapshot;
  manifest: ExtensionManifest;
  mediaInputs: Inputs;
  approval: DesktopPluginApprovalSettings;
  uploadApproved: boolean;
  serviceProtocol?: unknown;
}): Preview | null {
  if (input.mediaInputs === null) return null;
  const tools = ["media_submit", "media_observe"].map((id) =>
    input.manifest.tools.find((t) => t.operationId === id),
  );
  if (tools.every((t) => t === undefined)) return null;
  for (const [i, tool] of tools.entries()) {
    if (
      !tool ||
      tool.adapterId !== "crewon.project-media-execution" ||
      tool.execution !== "serial" ||
      tool.effect !== (i === 0 ? "mutation" : "readOnly") ||
      tool.recovery !== (i === 0 ? "reconcilable" : "replaySafe") ||
      tool.capability !==
        (i === 0 ? "extension.image.generate" : "extension.image.read") ||
      !isDeepStrictEqual(tool.inputSchema, {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      })
    )
      invalid();
  }
  // These fixed inputs are the same T10/D18 bindings that Worker rechecks before execution.
  for (const review of input.mediaInputs.reviews) {
    const id = review.workflow.workflowId;
    const bytes = input.snapshot.files.get(`workflows/${id}.api.json`);
    if (!bytes) invalid();
    const graph = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    const fourView = id === "krea2-reference-four-view";
    if (
      typeof graph[fourView ? "143" : "235:231"]?.inputs?.[
        fourView ? "prompt" : "text"
      ] !== "string" ||
      typeof graph[review.workflow.output.nodeId]?.inputs?.filename_prefix !==
        "string" ||
      (fourView ? ["146"] : ["240", "277", "548", "278", "279"]).some(
        (node) => typeof graph[node]?.inputs?.image !== "string",
      )
    )
      invalid();
  }
  const publication = {
    pluginId: input.snapshot.verification.descriptor.pluginId,
    packageDigest: input.snapshot.verification.packageDigest,
    contributionId: "workbench",
  };
  return Object.freeze({
    scope: "generate-from-adopted-references",
    alreadyApproved:
      input.uploadApproved &&
      input.approval.schemaVersion === "crewon.desktop-plugin-approval.v3" &&
      input.approval.projects.mediaGenerations?.publications.some((p) =>
        isDeepStrictEqual(p, publication),
      ) === true,
    workflows: Object.freeze(
      input.mediaInputs.reviews.map((r) =>
        Object.freeze({
          workflowId: r.workflow.workflowId,
          workflowDigest: r.workflow.workflowDigest,
        }),
      ),
    ),
    additionalNetworkPaths: shortDramaMediaUploadPaths(input.serviceProtocol),
  });
}

/** Called only for the separate consent on the Main-owned preview, after input approval. */
export function composeDesktopLocalShortDramaMediaGenerationApproval(input: {
  approval: DesktopPluginApprovalSettings;
  packageDigest: string;
}): DesktopPluginApprovalSettings {
  if (input.approval.schemaVersion !== "crewon.desktop-plugin-approval.v3")
    invalid();
  const publication = {
    pluginId: "crewon.short-drama",
    packageDigest: input.packageDigest,
    contributionId: "workbench",
  };
  const previous = input.approval.projects.mediaGenerations?.publications ?? [];
  return parseDesktopPluginApproval({
    ...input.approval,
    projects: {
      ...input.approval.projects,
      mediaGenerations: {
        version: "crewon.desktop-project-media-generations.v1",
        publications: previous.some((p) => isDeepStrictEqual(p, publication))
          ? previous
          : [...previous, publication],
      },
    },
  });
}
function invalid(): never {
  throw new Error("desktop_plugin_execution_setup_media_generation_invalid");
}
