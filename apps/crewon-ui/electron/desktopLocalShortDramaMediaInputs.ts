import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DesktopProjectExecutionConfiguration } from "@crewon/contracts/plugins";
import {
  extensionCanonicalJson,
  type ExtensionConfiguration,
} from "@crewon/domain";
import type { PackageSnapshot } from "../../../packages/plugin-host/src/local-plugin-package-verifier.ts";
import { fields } from "./desktopLocalPluginSourceImportFiles.ts";
import { composeDesktopLocalPluginProjectApproval } from "./desktopLocalPluginProjectApproval.ts";
import {
  parseDesktopPluginApproval,
  type DesktopPluginApprovalSettings,
} from "./desktopPluginBootstrap.ts";

type Declaration = NonNullable<
  DesktopProjectExecutionConfiguration["mediaInputs"]
>;
export const SHORT_MEDIA_INPUT_PROFILE = "media-input-profile.json";
const definitions = Object.freeze({
  "krea2-reference-four-view": "129",
  "flux2-three-reference-storyboard": "17",
});
const hash = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** Reads only already verified package data. No Node entry is imported during preview. */
export function captureDesktopLocalShortDramaMediaInputs(
  snapshot: PackageSnapshot,
  configuration: ExtensionConfiguration,
): Declaration | null {
  const bytes = snapshot.files.get(SHORT_MEDIA_INPUT_PROFILE);
  if (bytes === undefined) return null;
  const { descriptor, packageDigest } = snapshot.verification;
  if (bytes.length > 4096 || descriptor.pluginId !== "crewon.short-drama")
    invalid();
  for (const service of [
    "crewon.project-media-inputs",
    "crewon.project-media-input-tools",
    "crewon.project-conversations",
    "crewon.project-assets",
    "crewon.project-texts",
  ])
    if (
      !descriptor.requires.some(
        (r) =>
          r.service === service &&
          (r.apiVersion === "1" ||
            (service === "crewon.project-assets" && r.apiVersion === "2")),
      )
    )
      invalid();
  const profile = fields(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    ["schemaVersion", "pluginId", "workflows"],
  );
  if (
    profile.schemaVersion !== "crewon.short-drama-media-input-profile.v1" ||
    profile.pluginId !== descriptor.pluginId ||
    !Array.isArray(profile.workflows) ||
    profile.workflows.length < 1 ||
    profile.workflows.length > 2
  )
    invalid();
  const targetIdentity = Object.freeze({
    pluginId: "crewon.short-drama" as const,
    publisherId: descriptor.publisherId,
    version: descriptor.version,
    packageDigest,
    manifestDigest: configuration.manifestDigest,
    implementationDigest: configuration.implementationDigest,
  });
  const reviews = profile.workflows.map((item) => {
    const w = fields(item, ["workflowId", "file", "workflowDigest", "output"]);
    if (
      w.workflowId !== "krea2-reference-four-view" &&
      w.workflowId !== "flux2-three-reference-storyboard"
    )
      invalid();
    const workflowId = w.workflowId;
    if (w.file !== `workflows/${workflowId}.api.json`) invalid();
    const graphBytes = snapshot.files.get(w.file as string);
    if (graphBytes === undefined || graphBytes.length > 64 * 1024) invalid();
    const graph = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(graphBytes),
    );
    const digest = hash(extensionCanonicalJson(graph));
    const output = fields(w.output, ["kind", "nodeId", "dimensions"]);
    const nodeId = definitions[workflowId];
    if (
      w.workflowDigest !== digest ||
      output.kind !== "image" ||
      output.nodeId !== nodeId ||
      output.dimensions !== "workflow-native" ||
      graph?.[nodeId]?.class_type !== "SaveImage"
    )
      invalid();
    return Object.freeze({
      targetIdentity,
      workflow: Object.freeze({
        workflowId,
        workflowDigest: digest,
        output: Object.freeze({
          kind: "image" as const,
          nodeId,
          dimensions: "workflow-native" as const,
        }),
      }),
    });
  });
  if (
    new Set(reviews.map((r) => r.workflow.workflowId)).size !== reviews.length
  )
    invalid();
  return Object.freeze({
    version: "crewon.desktop-project-media-inputs.v1",
    purposes: Object.freeze(["read", "write"] as const),
    reviews: Object.freeze(reviews),
    referenceIdentities: Object.freeze([
      Object.freeze({
        pluginId: "crewon.short-drama" as const,
        pluginVersion: descriptor.version,
        manifestDigest: configuration.manifestDigest,
        implementationDigest: configuration.implementationDigest,
      }),
    ]),
  });
}

/** Applied only to the Main-owned confirmed snapshot after exact runtime identity verification. */
export function composeDesktopLocalShortDramaMediaInputApproval(
  input: Readonly<{
    approval: DesktopPluginApprovalSettings;
    descriptor: PackageSnapshot["verification"]["descriptor"];
    packageDigest: string;
    declaration: Declaration | null;
  }>,
): DesktopPluginApprovalSettings {
  if (input.declaration === null) return input.approval;
  const approval = composeDesktopLocalPluginProjectApproval({
    approval: input.approval,
    descriptor: input.descriptor,
    packageDigest: input.packageDigest,
  });
  if (approval.schemaVersion !== "crewon.desktop-plugin-approval.v3") invalid();
  const previous = approval.projects.mediaInputs;
  const declaration = input.declaration;
  if (
    previous !== undefined &&
    !previous.purposes.includes("write") &&
    previous.reviews.some(
      (r) => r.targetIdentity.packageDigest !== input.packageDigest,
    )
  )
    invalid();
  for (const review of declaration.reviews) {
    const existing = previous?.reviews.find(
      (r) =>
        r.targetIdentity.packageDigest ===
          review.targetIdentity.packageDigest &&
        r.workflow.workflowId === review.workflow.workflowId,
    );
    if (existing !== undefined && !isDeepStrictEqual(existing, review))
      invalid();
  }
  const publication = {
    pluginId: input.descriptor.pluginId,
    packageDigest: input.packageDigest,
    contributionId: "workbench",
  };
  const merge = (old: readonly (typeof publication)[] = []) => [
    ...old.filter((p) => !isDeepStrictEqual(p, publication)),
    publication,
  ];
  const identities = [
    ...(previous?.referenceIdentities ?? []),
    ...(approval.projects.resultSelections?.identities ?? []).map((i) => ({
      ...i,
      pluginId: i.pluginId ?? ("crewon.comfyui-krea2" as const),
    })),
    ...declaration.referenceIdentities,
  ];
  return parseDesktopPluginApproval({
    ...approval,
    projects: {
      ...approval.projects,
      mediaInputs: {
        ...declaration,
        reviews: [
          ...(previous?.reviews ?? []).filter(
            (r) => !declaration.reviews.some((n) => isDeepStrictEqual(n, r)),
          ),
          ...declaration.reviews,
        ],
        referenceIdentities: identities.filter(
          (i, index) =>
            identities.findIndex((other) => isDeepStrictEqual(i, other)) ===
            index,
        ),
      },
      mediaInputUi: {
        publications: merge(approval.projects.mediaInputUi?.publications),
      },
      mediaInputStages: {
        version: "crewon.project-media-input-stages.v1",
        publications: merge(approval.projects.mediaInputStages?.publications),
      },
    },
  });
}
function invalid(): never {
  throw new Error("desktop_plugin_execution_setup_media_input_profile_invalid");
}
