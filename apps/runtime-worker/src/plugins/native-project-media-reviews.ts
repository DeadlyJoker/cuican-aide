import { join } from "node:path";
import { loadInstalledPluginBusinessRegistration } from "@crewon/plugin-host";
import { captureLocalPluginPackage } from "@crewon/plugin-host/package-snapshot";
import type {
  DesktopNativePluginAuthority,
  DesktopProjectExecutionConfiguration,
} from "@crewon/contracts/plugins";
import {
  captureProjectMediaExecutionReview,
  type ProjectMediaExecutionReview,
} from "../project-media-execution-review.ts";

/** Read exact installed graph bytes without importing the plugin. Original Run admission still verifies the package. */
export async function loadNativeProjectMediaReviews(
  input: Readonly<{
    projects: DesktopProjectExecutionConfiguration;
    authority: DesktopNativePluginAuthority;
    current(): void;
  }>,
): Promise<readonly ProjectMediaExecutionReview[] | undefined> {
  const generation = input.projects.mediaGenerations;
  if (!generation) return undefined;
  input.current();
  const declared = input.projects.mediaInputs;
  if (!declared) invalid();
  const reviews: ProjectMediaExecutionReview[] = [];
  for (const publication of generation.publications) {
    const selected = declared.reviews.filter(
      (r) =>
        r.targetIdentity.pluginId === publication.pluginId &&
        r.targetIdentity.packageDigest === publication.packageDigest,
    );
    if (!selected.length) invalid();
    const snapshot = await captureLocalPluginPackage(
      {
        directory: join(
          input.authority.installRoot,
          "packages",
          publication.packageDigest.slice(7),
        ),
      },
      true,
    );
    input.current();
    const { descriptor, packageDigest } = snapshot.verification;
    if (
      packageDigest !== publication.packageDigest ||
      descriptor.pluginId !== publication.pluginId ||
      !descriptor.entrypoints.node ||
      !descriptor.contributions.some(
        (c) =>
          c.id === publication.contributionId &&
          c.kind === "module" &&
          c.slot === "main.content",
      )
    )
      invalid();
    const registration = await loadInstalledPluginBusinessRegistration({
      installRoot: input.authority.installRoot,
      expectedPluginId: descriptor.pluginId,
      expectedPublisherId: descriptor.publisherId,
      expectedVersion: descriptor.version,
      expectedPackageDigest: packageDigest,
      authorizeRead: async () => {
        input.current();
        return "allow";
      },
      signal: new AbortController().signal,
    });
    input.current();
    for (const review of selected) {
      const id = review.targetIdentity;
      if (
        id.manifestDigest !== registration.manifestDigest ||
        id.implementationDigest !== registration.implementationDigest
      )
        invalid();
      if (
        id.publisherId !== descriptor.publisherId ||
        id.version !== descriptor.version ||
        !input.authority.packages.some(
          (p) =>
            p.pluginId === id.pluginId &&
            p.publisherId === id.publisherId &&
            p.version === id.version &&
            p.packageDigest === id.packageDigest,
        )
      )
        invalid();
      const bytes = snapshot.files.get(
        `workflows/${review.workflow.workflowId}.api.json`,
      );
      if (!bytes || bytes.length > 65536) invalid();
      const template: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      const bindings =
        review.workflow.workflowId === "krea2-reference-four-view"
          ? {
              promptBinding: { nodeId: "143", input: "prompt" },
              imageBindings: [{ role: "character", nodeIds: ["146"] }],
            }
          : {
              promptBinding: { nodeId: "235:231", input: "text" },
              imageBindings: [
                { role: "scene", nodeIds: ["240", "277", "548"] },
                { role: "characterOne", nodeIds: ["278"] },
                { role: "characterTwo", nodeIds: ["279"] },
              ],
            };
      reviews.push(
        captureProjectMediaExecutionReview({
          ...review,
          template,
          ...bindings,
        }),
      );
    }
  }
  input.current();
  return Object.freeze(reviews);
}
function invalid(): never {
  throw new Error("native_project_media_review_invalid");
}
