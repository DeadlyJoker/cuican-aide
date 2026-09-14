import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  CONTEXT_COMPACTION_PROMPT,
  CONTEXT_COMPACTION_SUMMARY_PREFIX,
} from "../../../../packages/context/src/index.ts";
import {
  SOAK_READ_TOOL,
  SOAK_TOOL_STEPS,
  soakRequestMarker,
  validateSoakToolHistory,
} from "./tool-fixture.ts";

const SUMMARY_MARKER = "CREWON_SOAK_CHECKPOINT_V1 ";
const WRAPPED_SUMMARY = `${CONTEXT_COMPACTION_SUMMARY_PREFIX}\n${SUMMARY_MARKER}`;
type Checkpoint = {
  marker: string;
  completedReads: number;
  finished: boolean;
  sourceDigest: string;
};

/** Deterministic semantics for this fixture only. Keeps no hidden conversation progress. */
export function createSoakWorkloadModel() {
  const key = randomBytes(32);
  const signature = (value: Checkpoint) =>
    createHmac("sha256", key).update(JSON.stringify(value)).digest("hex");
  return {
    evaluate(request: Record<string, unknown>) {
      if (!Array.isArray(request.input))
        throw new Error("soak_workload_input_invalid");
      const last = request.input.at(-1);
      const compaction =
        object(last) &&
        last.role === "user" &&
        last.content === CONTEXT_COMPACTION_PROMPT;
      const input = compaction ? request.input.slice(0, -1) : request.input;
      const summaryIndex = input.findLastIndex(
        (item) =>
          object(item) &&
          item.role === "user" &&
          typeof item.content === "string" &&
          item.content.startsWith(`${CONTEXT_COMPACTION_SUMMARY_PREFIX}\n`),
      );
      let checkpoint: Checkpoint | null = null;
      if (summaryIndex >= 0) {
        const content = input[summaryIndex].content as string;
        if (!content.startsWith(WRAPPED_SUMMARY) || content.length > 2048)
          throw new Error("soak_summary_format_invalid");
        const value = JSON.parse(content.slice(WRAPPED_SUMMARY.length));
        if (
          !object(value) ||
          !object(value.checkpoint) ||
          signature(value.checkpoint as Checkpoint) !== value.signature
        )
          throw new Error("soak_summary_integrity_invalid");
        checkpoint = value.checkpoint as Checkpoint;
      }
      const userIndex = input.findLastIndex(
        (item) =>
          object(item) &&
          item.role === "user" &&
          typeof item.content === "string" &&
          /^SOAK-[A-Za-z0-9_-]+(?:\s|$)/.test(item.content),
      );
      const resume = checkpoint !== null && summaryIndex > userIndex;
      const marker = resume ? checkpoint!.marker : soakRequestMarker(input);
      if (resume && userIndex >= 0 && marker !== soakRequestMarker(input))
        throw new Error("soak_summary_task_identity_invalid");
      if (marker === "SOAK-summary")
        throw new Error("soak_task_identity_missing");
      const tail = input.slice((resume ? summaryIndex : userIndex) + 1);
      let finished = resume ? checkpoint!.finished : false;
      const toolHistory: unknown[] = [];
      for (const item of tail) {
        if (
          object(item) &&
          item.role === "assistant" &&
          typeof item.content === "string" &&
          item.content.startsWith(`ACK ${marker}\n`)
        ) {
          if (finished) throw new Error("soak_duplicate_final_answer");
          finished = true;
        } else {
          if (finished) throw new Error("soak_history_after_final_answer");
          toolHistory.push(item);
        }
      }
      const tool = marker.startsWith("SOAK-tool-")
        ? validateSoakToolHistory(
            toolHistory,
            marker,
            resume ? checkpoint!.completedReads : 0,
          )
        : null;
      if (finished && tool && tool.completed !== SOAK_TOOL_STEPS)
        throw new Error("soak_premature_final_answer");
      if (!compaction && tool && !Array.isArray(request.tools))
        throw new Error("soak_tool_request_invalid");
      if (
        !compaction &&
        tool &&
        !(request.tools as unknown[]).some(
          (item) =>
            object(item) &&
            item.type === "function" &&
            item.name === SOAK_READ_TOOL,
        )
      )
        throw new Error("soak_fixture_read_tool_unavailable");
      if (!compaction && finished)
        throw new Error("soak_sampling_after_completed_task");
      const next: Checkpoint = {
        marker,
        completedReads: tool?.completed ?? 0,
        finished,
        sourceDigest: createHash("sha256")
          .update(JSON.stringify(input))
          .digest("hex"),
      };
      return {
        marker,
        call: compaction ? null : (tool?.call ?? null),
        tool: !compaction && tool !== null,
        resumedToolProgress:
          !compaction && resume && (tool?.completed ?? 0) > 0,
        summary: compaction
          ? SUMMARY_MARKER +
            JSON.stringify({ checkpoint: next, signature: signature(next) })
          : null,
      };
    },
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
