import { expect, it } from "vitest";
import type { ControlToolItem } from "./controlRunToolProjection";
import { createDemoTurn, createDraftDemoThread } from "../demo/demoData";
import { refreshCanonicalControlToolResults } from "./controlRunSettlement";

const tool = {
  type: "dynamicToolCall",
  id: "call-result",
  tool: "verify",
  arguments: {},
  contentItems: null,
  success: false,
  status: "failed",
  durationMs: 1,
} as ControlToolItem;

it("keeps a late recovered success from another Run in whole-window publication", () => {
  const thread = createDraftDemoThread({
    locale: "zh",
    newDraftPreview: "",
    newDraftThread: "同步竞态",
  });
  const older = createDemoTurn({
    text: "旧Run",
    responseText: "旧回复",
    nowMs: 1000,
  });
  older.id = "older";
  older.items.push(tool);
  const newer = createDemoTurn({
    text: "新Run",
    responseText: "新回复",
    nowMs: 2000,
  });
  newer.id = "newer";
  thread.turns = [older, newer];
  const success = {
    ...tool,
    status: "completed",
    success: true,
    contentItems: [{ type: "inputText", text: "工具已完成" }],
  } as ControlToolItem;
  const result = refreshCanonicalControlToolResults(thread, (id) =>
    id === "older" ? [success] : [],
  );
  expect(result.turns[0]!.items.find((item) => item.id === tool.id)).toEqual(
    success,
  );
  expect(result.turns[1]).toBe(newer);
  expect(thread.turns[0]!.items.at(-1)).toBe(tool);
});

it("does not replace settled missing-tool presentation with a pending request", () => {
  const thread = createDraftDemoThread({
    locale: "zh",
    newDraftPreview: "",
    newDraftThread: "同步",
  });
  thread.turns = [
    createDemoTurn({ text: "提问", responseText: "正文", nowMs: 1000 }),
  ];
  thread.turns[0]!.items.push(tool);
  const result = refreshCanonicalControlToolResults(thread, () => [
    { ...tool, status: "inProgress" },
  ]);
  expect(result.turns[0]).toBe(thread.turns[0]);
});
