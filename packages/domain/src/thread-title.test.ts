import assert from "node:assert/strict";
import test from "node:test";
import { deriveThreadTitle, initialThreadTitleData } from "./thread-title.ts";

test("titles are short, deterministic, Unicode-safe and exclude template/context framing", () => {
  assert.equal(
    deriveThreadTitle("\n # 整理项目周报\n这里是很长的材料"),
    "整理项目周报",
  );
  assert.equal(
    deriveThreadTitle(
      '整理项目周报\n\n<crewon_selected_context version="1">\nsecret',
    ),
    "整理项目周报",
  );
  assert.equal(
    deriveThreadTitle(
      "会议纪要与行动项 / Meeting notes & actions — crewon.meeting-notes@0.1.0\n模板摘要: secret",
    ),
    "会议纪要与行动项",
  );
  assert.equal(
    deriveThreadTitle(
      '<automation_run id="a"><title>每日复盘</title><task>secret</task></automation_run>',
    ),
    "每日复盘",
  );
  assert.equal(deriveThreadTitle("🧑".repeat(60)), "🧑".repeat(47) + "…");
  assert.equal(deriveThreadTitle("\u202e整理\u0000周报"), "整理周报");
  assert.equal(deriveThreadTitle(" \n "), null);
});

test("initial titles never replace explicit titles or come from later or non-user messages", () => {
  const thread = { title: null, lastMessageSequence: 0 };
  const user = { role: "user", content: "first request" };
  assert.deepEqual(initialThreadTitleData(thread, user), {
    initialTitle: "first request",
  });
  assert.deepEqual(
    initialThreadTitleData({ ...thread, title: "My title" }, user),
    {},
  );
  assert.deepEqual(
    initialThreadTitleData({ ...thread, lastMessageSequence: 2 }, user),
    {},
  );
  assert.deepEqual(
    initialThreadTitleData(thread, { ...user, role: "assistant" }),
    {},
  );
});
