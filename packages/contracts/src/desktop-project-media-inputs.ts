import { parsePluginUiJsonValue } from "./plugin-ui-json.ts";
import {
  parsePluginControlPackageDigest,
  parsePluginControlPluginId,
} from "./plugin-control-contract.ts";
import { pluginControlRecord } from "./plugin-control-contract-support.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import type { MediaInputWorkflowId } from "./project-media-inputs.ts";

export const DESKTOP_PROJECT_MEDIA_INPUTS_VERSION =
  "crewon.desktop-project-media-inputs.v1";
export type DesktopMediaInputReview = Readonly<{
  targetIdentity: Readonly<{
    pluginId: "crewon.short-drama";
    publisherId: string;
    version: string;
    packageDigest: string;
    manifestDigest: string;
    implementationDigest: string;
  }>;
  workflow: Readonly<{
    workflowId: MediaInputWorkflowId;
    workflowDigest: string;
    output: Readonly<{
      kind: "image";
      nodeId: "129" | "17";
      dimensions: "workflow-native";
    }>;
  }>;
}>;
export type DesktopMediaReferenceIdentity = Readonly<{
  pluginId: "crewon.short-drama" | "crewon.comfyui-krea2";
  pluginVersion: string;
  manifestDigest: string;
  implementationDigest: string;
}>;
/** Private metadata approval only. No media I/O, Run, adoption, billing or UI publication. */
export type DesktopProjectMediaInputsConfiguration = Readonly<{
  version: typeof DESKTOP_PROJECT_MEDIA_INPUTS_VERSION;
  purposes: readonly ("read" | "write")[];
  reviews: readonly DesktopMediaInputReview[];
  referenceIdentities: readonly DesktopMediaReferenceIdentity[];
}>;

export function parseDesktopProjectMediaInputsConfiguration(
  input: unknown,
  options: Readonly<{
    publications: readonly Readonly<{
      pluginId: string;
      packageDigest: string;
    }>[];
  }>,
): DesktopProjectMediaInputsConfiguration {
  try {
    const r = pluginControlRecord(
      parsePluginUiJsonValue(input, { maxBytes: 24 * 1024 }),
      ["version", "purposes", "reviews", "referenceIdentities"],
    );
    if (r.version !== DESKTOP_PROJECT_MEDIA_INPUTS_VERSION) invalid();
    const approvedValue = pluginControlRecord(
      parsePluginUiJsonValue(options, { maxBytes: 16 * 1024 }),
      ["publications"],
    );
    const approved = list(approvedValue.publications, 32).map((v) => {
      const p = pluginControlRecord(v, ["pluginId", "packageDigest"]);
      return {
        pluginId: parsePluginControlPluginId(p.pluginId),
        packageDigest: parsePluginControlPackageDigest(p.packageDigest),
      };
    });
    const purposes = list(r.purposes, 2).map((purpose) => {
      if (purpose !== "read" && purpose !== "write") invalid();
      return purpose;
    });
    unique(purposes);
    // Saving checks the original receipt before any new work, so both purposes must be explicit.
    if (!purposes.includes("read")) invalid();
    const reviews = list(r.reviews, 16).map((item) => {
      const v = pluginControlRecord(item, ["targetIdentity", "workflow"]),
        t = pluginControlRecord(v.targetIdentity, [
          "pluginId",
          "publisherId",
          "version",
          "packageDigest",
          "manifestDigest",
          "implementationDigest",
        ]),
        w = pluginControlRecord(v.workflow, [
          "workflowId",
          "workflowDigest",
          "output",
        ]),
        o = pluginControlRecord(w.output, ["kind", "nodeId", "dimensions"]);
      if (t.pluginId !== "crewon.short-drama") invalid();
      if (
        w.workflowId !== "krea2-reference-four-view" &&
        w.workflowId !== "flux2-three-reference-storyboard"
      )
        invalid();
      const nodeId =
        w.workflowId === "krea2-reference-four-view" ? "129" : "17";
      if (
        o.kind !== "image" ||
        o.nodeId !== nodeId ||
        o.dimensions !== "workflow-native"
      )
        invalid();
      const targetIdentity = Object.freeze({
        pluginId: t.pluginId,
        publisherId: parsePluginControlPluginId(t.publisherId),
        version: version(t.version),
        packageDigest: parsePluginControlPackageDigest(t.packageDigest),
        manifestDigest: parsePluginControlPackageDigest(t.manifestDigest),
        implementationDigest: parsePluginControlPackageDigest(
          t.implementationDigest,
        ),
      });
      if (
        !approved.some(
          (p) =>
            p.pluginId === targetIdentity.pluginId &&
            p.packageDigest === targetIdentity.packageDigest,
        )
      )
        invalid();
      return Object.freeze({
        targetIdentity,
        workflow: Object.freeze({
          workflowId: w.workflowId,
          workflowDigest: parsePluginControlPackageDigest(w.workflowDigest),
          output: Object.freeze({
            kind: "image" as const,
            nodeId,
            dimensions: "workflow-native" as const,
          }),
        }),
      });
    });
    unique(
      reviews.map((r) =>
        JSON.stringify([r.targetIdentity, r.workflow.workflowId]),
      ),
    );
    const referenceIdentities = list(r.referenceIdentities, 32).map((item) => {
      const v = pluginControlRecord(item, [
        "pluginId",
        "pluginVersion",
        "manifestDigest",
        "implementationDigest",
      ]);
      if (
        v.pluginId !== "crewon.short-drama" &&
        v.pluginId !== "crewon.comfyui-krea2"
      )
        invalid();
      return Object.freeze({
        pluginId: v.pluginId,
        pluginVersion: version(v.pluginVersion),
        manifestDigest: parsePluginControlPackageDigest(v.manifestDigest),
        implementationDigest: parsePluginControlPackageDigest(
          v.implementationDigest,
        ),
      });
    });
    unique(referenceIdentities.map((v) => JSON.stringify(v)));
    return Object.freeze({
      version: r.version,
      purposes: Object.freeze(purposes),
      reviews: Object.freeze(reviews),
      referenceIdentities: Object.freeze(referenceIdentities),
    });
  } catch {
    invalid();
  }
}
function list(v: unknown, max: number): unknown[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > max) invalid();
  return v;
}
function unique(v: readonly string[]) {
  if (new Set(v).size !== v.length) invalid();
}
function version(v: unknown): string {
  if (
    typeof v !== "string" ||
    v.length > 32 ||
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(v)
  )
    invalid();
  return v;
}
function invalid(): never {
  throw new ContractValidationError(
    "desktop_project_media_inputs_configuration_invalid",
  );
}
