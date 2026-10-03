import type { projectConceptGeneration } from "./project-generation-read-projection.ts";

export const generationResultBaseUrl = "https://comfy.example.test:8443/";
export const generationObservedAt = "2026-10-03T00:00:00.000Z";
type Generation = NonNullable<Parameters<typeof projectConceptGeneration>[0]>;

export function generationImage(filename = "concept.png", subfolder = "") {
  const image = { filename, subfolder, type: "output" };
  return {
    ...image,
    url: new URL(`/view?${new URLSearchParams(image)}`, generationResultBaseUrl)
      .href,
  };
}

/** Projection-only input. These unit tests make no claim about SQL, owner authorization, or supplier execution. */
export function generationProjectionFixture(): Generation {
  return {
    link: {
      reference: {
        projectId: "project-1",
        assetId: "asset-1",
        assetRevision: 2,
      },
      briefRevision: 1,
      createdAt: generationObservedAt,
    },
    task: {
      run: {
        runId: "original-run",
        threadId: "original-thread",
        status: "queued",
      },
      binding: {
        pluginId: "crewon.comfyui-krea2",
        configurationRevision: 1,
        source: null,
      },
      configuration: {
        pluginVersion: "1.0.0",
        parameters: { baseUrl: generationResultBaseUrl },
      },
      operations: [
        {
          operationId: "11111111-2222-3333-4444-555555555555",
          runId: "original-run",
          status: "succeeded",
          revision: 7,
          updatedAt: generationObservedAt,
          resultJson: JSON.stringify({
            images: [
              generationImage("first.png"),
              generationImage("second.png"),
            ],
          }),
          providerOperationId: "private-provider-job",
        },
      ],
      truncated: false,
    },
  } as unknown as Generation;
}
