import {
  ApplicationError,
  mediaInputSame,
  type ProjectMediaResultSource,
  type ProjectMediaWorkflowReview,
} from "@crewon/application";
import type { DesktopProjectExecutionConfiguration } from "@crewon/contracts/plugins";
import type { DesktopNativePluginControlConfig } from "./desktop-native-plugin-control-environment.ts";

/** Called after current file/actor authority checks, before any output egress or archive write. */
export function assertNativeProjectMediaResultOutput(
  input: Readonly<{
    declared: NonNullable<DesktopProjectExecutionConfiguration["mediaResults"]>;
    reviews: readonly ProjectMediaWorkflowReview[];
    networkGrants: DesktopNativePluginControlConfig["authority"]["networkGrants"];
    source: ProjectMediaResultSource;
  }>,
): void {
  const { declared, source } = input;
  const target = source.targetIdentity;
  const publishers = declared.publishPublications ?? declared.publications;
  const imageUrl = new URL(source.image.url);
  if (
    !declared.purposes.includes("publish") ||
    !publishers.some(
      (p) =>
        p.pluginId === target.pluginId &&
        p.packageDigest === target.packageDigest &&
        p.contributionId === "workbench",
    ) ||
    imageUrl.origin + "/" !== source.configuration.origin ||
    imageUrl.username !== "" ||
    imageUrl.password !== "" ||
    imageUrl.hash !== "" ||
    (imageUrl.pathname !== "/view" &&
      imageUrl.pathname !== "/api/comfy/view") ||
    !input.reviews.some(
      (r) =>
        mediaInputSame(r.targetIdentity, target) &&
        mediaInputSame(r.workflow, source.workflow),
    ) ||
    !input.networkGrants.some(
      (g) =>
        g.pluginId === target.pluginId &&
        g.publisherId === target.publisherId &&
        g.version === target.version &&
        g.packageDigest === target.packageDigest &&
        g.baseUrlParameter === "baseUrl" &&
        g.baseUrl === source.configuration.origin &&
        g.paths.some(
          (p) =>
            p.method === "GET" && "path" in p && p.path === imageUrl.pathname,
        ),
    )
  )
    throw new ApplicationError(
      "authorization",
      "desktop_native_project_media_result_denied",
    );
}
