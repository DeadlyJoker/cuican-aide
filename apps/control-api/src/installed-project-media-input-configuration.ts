import { types } from "node:util";
import {
  captureProjectMediaWorkflowReviews,
  captureProjectMediaInputAuthorization,
  captureProjectGenerationImageResultVerifier,
  projectMediaInputBound,
  materialPreparationFields,
  type CreativeProjectAuthorizationPort,
  type ProjectMediaResultAuthorizationPort,
  type ProjectMediaInputAuthorizationPort,
  type PluginInstallationAuthorizationPort,
  type ProjectGenerationImageResultVerifier,
  type ProjectMediaWorkflowReview,
} from "@crewon/application";

/** Explicit host metadata approval. This grants no uploads, media tasks, adoption or funding. */
export type InstalledProjectMediaInputConfiguration = Readonly<{
  version: "crewon.project-media-input-control.v1";
  reviews: readonly ProjectMediaWorkflowReview[];
  authorization: ProjectMediaInputAuthorizationPort;
  projects: CreativeProjectAuthorizationPort;
  installations: PluginInstallationAuthorizationPort;
  verifier: ProjectGenerationImageResultVerifier;
  adoptedReferences?: ProjectMediaResultAuthorizationPort;
}>;
export function captureInstalledProjectMediaInputConfiguration(
  input: unknown,
): InstalledProjectMediaInputConfiguration {
  if (input === null || typeof input !== "object" || types.isProxy(input))
    invalid();
  const r = materialPreparationFields(input, [
    "version",
    "reviews",
    "authorization",
    "projects",
    "installations",
    "verifier",
    ...(Object.hasOwn(input, "adoptedReferences") ? ["adoptedReferences"] : []),
  ]);
  if (r.version !== "crewon.project-media-input-control.v1") invalid();
  return Object.freeze({
    version: r.version,
    ...(Object.hasOwn(r, "adoptedReferences")
      ? {
          adoptedReferences: Object.freeze({
            authorize: projectMediaInputBound<
              ProjectMediaResultAuthorizationPort["authorize"]
            >(r.adoptedReferences, "authorize"),
            assertActive: projectMediaInputBound<
              ProjectMediaResultAuthorizationPort["assertActive"]
            >(r.adoptedReferences, "assertActive"),
          }),
        }
      : {}),
    reviews: captureProjectMediaWorkflowReviews(
      r.reviews as readonly ProjectMediaWorkflowReview[],
    ),
    authorization: captureProjectMediaInputAuthorization(
      r.authorization as ProjectMediaInputAuthorizationPort,
    ),
    projects: Object.freeze({
      authorize: projectMediaInputBound<
        CreativeProjectAuthorizationPort["authorize"]
      >(r.projects, "authorize"),
    }),
    installations: Object.freeze({
      authorize: projectMediaInputBound<
        PluginInstallationAuthorizationPort["authorize"]
      >(r.installations, "authorize"),
    }),
    verifier: captureProjectGenerationImageResultVerifier(
      r.verifier as ProjectGenerationImageResultVerifier,
    ),
  });
}
function invalid(): never {
  throw new Error("installed_project_media_input_configuration_invalid");
}
