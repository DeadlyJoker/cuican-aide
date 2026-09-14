import type { RunEventView, RunView } from "@crewon/contracts";
import { describe, expect, it } from "vitest";
import {
  applyControlRunItemEvent,
  backfillControlToolProjection,
  controlRunItemsWithTaskChanges,
  controlToolProjectionComplete,
  createControlToolProjectionState,
  hydrateControlToolHistories,
  settleControlToolProjection,
} from "./controlRunToolProjection";
import { transcriptRowTurn } from "./controlTranscriptWindow";
import { controlImageArtifact } from "./controlImageGeneration";

const metadata = {
  segmentId: "segment-1",
  itemId: "image-1",
  artifactRef: "artifact:image-1",
  mimeType: "image/png" as const,
  byteLength: 2_600_000,
};
function progress(
  sequence: number,
  stage: "in_progress" | "generating" | "completed" = "generating",
): RunEventView {
  return {
    eventId: `event-${sequence}`,
    runId: "run-1",
    sequence,
    occurredAt: "2026-09-14T00:00:00Z",
    type: "model.image.progress",
    data: { segmentId: "segment-1", itemId: "image-1", stage },
  };
}
function generated(sequence: number): RunEventView {
  return {
    ...progress(sequence),
    type: "model.image.generated",
    data: metadata,
  };
}
const terminal = {
  lastSequence: 4,
  status: "completed" as const,
  terminalAt: "2026-09-14T00:00:00Z",
};
describe("Control image transcript projection", () => {
  it.each([128, 129, 512])(
    "accepts a contract-valid artifact reference with %s characters",
    (length) => {
      const state = createControlToolProjectionState();
      const artifactRef = "a".repeat(length);
      const image = applyControlRunItemEvent(state, {
        ...generated(1),
        data: { ...metadata, itemId: "i".repeat(512), artifactRef },
      } as RunEventView);
      expect(image).toMatchObject({
        status: "completed",
        controlImage: { artifactRef },
      });
      if (image?.type !== "imageGeneration")
        throw new Error("expected image item");
      expect(controlImageArtifact(image)?.artifactRef).toBe(artifactRef);
    },
  );
  it.each([
    "a".repeat(513),
    "https:remote-image",
    "http:remote-image",
    "data:image-png",
    "file:private-image",
    "https://example.com/image.png",
    "/tmp/image.png",
    "../image.png",
    "artifact:image?token=secret",
  ])(
    "rejects an artifact reference outside the shared contract: %s",
    (artifactRef) => {
      const state = createControlToolProjectionState();
      const image = applyControlRunItemEvent(state, {
        ...generated(1),
        data: { ...metadata, artifactRef },
      } as RunEventView);
      expect(image).toMatchObject({
        type: "imageGeneration",
        status: "failed",
      });
      expect(image).not.toHaveProperty("controlImage");
      expect(
        controlImageArtifact({
          type: "imageGeneration",
          id: "image-1",
          status: "completed",
          result: "",
          revisedPrompt: null,
          controlImage: {
            artifactRef,
            mimeType: metadata.mimeType,
            byteLength: metadata.byteLength,
          },
        }),
      ).toBeNull();
    },
  );
  it("upserts small progress metadata and waits for a persisted artifact before success", () => {
    const state = createControlToolProjectionState();
    expect(
      applyControlRunItemEvent(state, progress(1, "in_progress")),
    ).toMatchObject({
      type: "imageGeneration",
      status: "inProgress",
      result: "",
    });
    expect(
      applyControlRunItemEvent(state, progress(2, "completed")),
    ).toMatchObject({ status: "inProgress" });
    const image = applyControlRunItemEvent(state, generated(3));
    expect(image).toMatchObject({
      status: "completed",
      controlImage: {
        artifactRef: metadata.artifactRef,
        mimeType: "image/png",
        byteLength: 2_600_000,
      },
    });
    expect(applyControlRunItemEvent(state, progress(4))).toBeNull();
    expect(applyControlRunItemEvent(state, generated(2))).toBeNull();
    expect(controlRunItemsWithTaskChanges(state, undefined)).toEqual([image]);
    expect(JSON.stringify(image).length).toBeLessThan(512);
  });
  it.each(["completed", "failed", "canceled"] as const)(
    "marks an image without an artifact as failed when the run is %s",
    (status) => {
      const state = createControlToolProjectionState();
      applyControlRunItemEvent(state, progress(1));
      expect(
        settleControlToolProjection(state, { ...terminal, status }),
      ).toMatchObject([{ type: "imageGeneration", status: "failed" }]);
      expect(controlRunItemsWithTaskChanges(state, undefined)[0]?.status).toBe(
        "failed",
      );
    },
  );
  it("retains resumed generated metadata without needing a prior progress frame", async () => {
    const state = createControlToolProjectionState();
    const result = await backfillControlToolProjection({
      client: {} as never,
      state,
      runId: "run-1",
      afterSequence: 2,
      throughSequence: 3,
      signal: new AbortController().signal,
      timeoutMs: 1000,
      eventStream: async function* () {
        yield generated(3);
      },
    });
    expect(result.items).toMatchObject([
      {
        type: "imageGeneration",
        status: "completed",
        controlImage: { artifactRef: metadata.artifactRef },
      },
    ]);
    expect(result.complete).toBe(true);
  });
  it("restores the image in the historical transcript window exactly once", async () => {
    const statesByRun = new Map();
    await hydrateControlToolHistories({
      client: {} as never,
      inFlightByRun: new Map(),
      lifecycleSignal: new AbortController().signal,
      runsNewestFirst: [
        {
          ...terminal,
          runId: "run-1",
          purpose: "turn",
          lastSequence: 3,
        } as RunView,
      ],
      statesByRun,
      coverageByRun: new Map(),
      timeoutMs: 1000,
      eventStream: async function* () {
        yield progress(1);
        yield progress(2, "completed");
        yield generated(3);
      },
    });
    const items = controlRunItemsWithTaskChanges(
      statesByRun.get("run-1"),
      undefined,
    );
    const turn = {
      id: "run-1",
      items,
      itemsView: "full" as const,
      status: "completed" as const,
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    };
    const row = {
      kind: "run" as const,
      runId: "run-1",
      itemIds: [],
      firstFragment: true,
      continuation: false,
    };
    expect(transcriptRowTurn(turn, row).items).toMatchObject([
      {
        type: "imageGeneration",
        controlImage: { artifactRef: metadata.artifactRef },
      },
    ]);
    expect(
      transcriptRowTurn(turn, { ...row, firstFragment: false }).items,
    ).toEqual([]);
  });
  it("bounds the number of image references and does not claim complete history after overflow", () => {
    const state = createControlToolProjectionState();
    for (let index = 0; index < 20; index++) {
      const event = generated(index + 1);
      applyControlRunItemEvent(state, {
        ...event,
        data: { ...metadata, itemId: `image-${index}` },
      } as RunEventView);
    }
    expect(controlRunItemsWithTaskChanges(state, undefined)).toHaveLength(16);
    expect(controlToolProjectionComplete(state)).toBe(false);
  });
});
