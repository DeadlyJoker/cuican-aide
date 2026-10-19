import { createHash } from "node:crypto";
import type { ProjectMediaWorkflowReview } from "./project-media-input-port.ts";

/** Named deployment metadata only; these digests do not issue execution authority. */
export function namedMediaWorkflowReviewHistory(
  packages: number,
): readonly ProjectMediaWorkflowReview[] {
  const digest = (name: string) =>
    `sha256:${createHash("sha256").update(name).digest("hex")}`;
  return Array.from({ length: packages }, (_, index) => {
    const targetIdentity = {
      pluginId: "crewon.short-drama" as const,
      publisherId: "example.publisher",
      version: `${index + 1}.0.0`,
      packageDigest: digest(`named-package-${index}`),
      manifestDigest: digest(`named-manifest-${index}`),
      implementationDigest: digest(`named-implementation-${index}`),
    };
    return [
      {
        targetIdentity,
        workflow: {
          workflowId: "krea2-reference-four-view" as const,
          workflowDigest: digest(`named-T10-${index}`),
          output: {
            kind: "image" as const,
            nodeId: "129" as const,
            dimensions: "workflow-native" as const,
          },
        },
      },
      {
        targetIdentity,
        workflow: {
          workflowId: "flux2-three-reference-storyboard" as const,
          workflowDigest: digest(`named-D18-${index}`),
          output: {
            kind: "image" as const,
            nodeId: "17" as const,
            dimensions: "workflow-native" as const,
          },
        },
      },
    ];
  }).flat();
}
