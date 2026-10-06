import type { ProjectMediaMaterialRuntimeInput } from "@crewon/media-runtime/project-media-material-runtime";
import { selectionVerifier } from "../../../packages/store/src/project-concept-selection.test-support.ts";
import type { projectMediaInputFixture } from "./project-media-input.test-support.ts";
import { materialPng } from "./project-material-png.test-support.ts";

/** Named policy, source decoding, DNS and provider ports. Services, journals and encrypted archive are real. */
export function materialRuntimeFixtureInput(
  f: Pick<
    Awaited<ReturnType<typeof projectMediaInputFixture>>,
    | "parent"
    | "configurations"
    | "actor"
    | "state"
    | "policy"
    | "decision"
    | "mediaAuthorization"
    | "dependencies"
    | "reviews"
  >,
  archive: ProjectMediaMaterialRuntimeInput["archive"],
): ProjectMediaMaterialRuntimeInput {
  return {
    store: f.parent,
    configurations: f.configurations,
    profiles: {
      resolve: async () => ({
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        profileId: f.state.profileId,
      }),
    },
    projects: { authorize: async () => f.decision(f.policy.allow) },
    installations: {
      authorize: async () => f.decision(f.state.installationAllowed),
    },
    metadata: f.mediaAuthorization,
    read: { authorize: async () => f.decision(f.state.readAllowed) },
    freeze: { authorize: async () => f.decision(f.state.freezeAllowed) },
    preparation: f.dependencies.authorization,
    sourceAdapter: {
      deriveReadDestination(source) {
        const url = new URL(source.resultLink.image.url);
        return {
          origin: url.origin + "/",
          path: url.pathname + url.search,
          output: {
            filename: source.resultLink.image.filename,
            subfolder: "named-source-output",
            type: "output",
          },
        };
      },
    },
    verifier: selectionVerifier,
    reviews: f.reviews,
    archive,
    clock: f.dependencies.clock,
    signal: new AbortController().signal,
    network: {
      dns: f.dependencies.dns,
      source: {
        request: async (request) => {
          f.state.sourceGets++;
          return {
            status: 200,
            headers: { "content-type": "image/png" },
            body: request.target.endpoint.pathname.endsWith("/1.png")
              ? materialPng(3, 1)
              : Buffer.from(f.state.bytes),
          };
        },
      },
      upload: f.dependencies.uploadTransport,
      observation: f.dependencies.observationTransport,
    },
  };
}
