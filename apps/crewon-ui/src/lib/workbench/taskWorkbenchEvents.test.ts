import { describe, expect, it } from "vitest";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { RunEventView } from "@crewon/contracts";
import {
  applyControlToolEvent,
  controlToolItems,
  createControlToolProjectionState,
} from "../control-runtime/controlRunToolProjection";
import { projectThreadWorkbench } from "./taskWorkbenchProjection";

describe("Control browser events to workbench", () => {
  it.each(["mcp__browser__navigate", "mcp__web__run"])(
    "updates %s status and reproduces it after event replay",
    (name) => {
      const requested = {
        eventId: "event-1",
        runId: "run-1",
        sequence: 1,
        occurredAt: "2026-09-08T07:00:00Z",
        type: "tool.requested",
        data: {
          segmentId: "segment-1",
          callId: "call-1",
          kind: "function",
          name,
          inputPreview: '{"url":"https://example.com/"}',
        },
      } as RunEventView;
      const completed = {
        ...requested,
        eventId: "event-2",
        sequence: 2,
        occurredAt: "2026-09-08T07:00:01Z",
        type: "tool.completed",
        data: {
          ...requested.data,
          isError: true,
          outputPreview: "Navigation failed",
        },
      } as RunEventView;
      const state = createControlToolProjectionState();
      const project = (value: typeof state) =>
        projectThreadWorkbench(
          {
            id: "task-1",
            turns: [
              {
                id: "run-1",
                status: "inProgress",
                items: controlToolItems(value),
              },
            ],
          } as Thread,
          "页面核对",
        );
      applyControlToolEvent(state, requested);
      expect(project(state).browser[0]).toMatchObject({
        status: "inProgress",
        urls: ["https://example.com/"],
      });
      applyControlToolEvent(state, completed);
      expect(project(state).browser[0]?.status).toBe("failed");
      const replayed = createControlToolProjectionState();
      for (const event of [requested, completed, requested, completed])
        applyControlToolEvent(replayed, event);
      expect(project(replayed)).toEqual(project(state));
      expect(project(replayed).browser).toHaveLength(1);
    },
  );
});
