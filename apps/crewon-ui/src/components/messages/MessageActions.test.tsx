// @ts-expect-error Vitest runs in Node; the browser bundle omits Node types.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createDemoTurn, createDraftDemoThread } from "../../lib/demo/demoData";
import { MessageActions } from "./MessageActions";
import { MessageReplayScope } from "./MessageReplayScope";

describe("message action bar", () => {
  it("offers copy and inline edit, with no direct rerun or response menus", () => {
    const thread = createDraftDemoThread({
      locale: "zh",
      newDraftPreview: "",
      newDraftThread: "测试",
    });
    thread.turns = [
      createDemoTurn({ text: "虚构周报", responseText: "已完成" }),
    ];
    const user = thread.turns[0]!.items.find(
      (item) => item.type === "userMessage",
    )!;
    user.id = "user-edit-fixture";
    const markup = renderToStaticMarkup(
      <MessageReplayScope
        thread={thread}
        busy={false}
        locale="zh"
        onReplay={async () => {}}
      >
        <MessageActions
          text="虚构周报"
          locale="zh"
          user
          userMessageId={user.id}
        />
        <MessageActions text="已完成" locale="zh" userMessageId={user.id} />
      </MessageReplayScope>,
    );
    expect(markup).toContain('aria-label="编辑消息"');
    expect(markup).toContain('data-user="true" data-visibility="on-hover"');
    expect(markup).toContain('data-user="false" data-visibility="always"');
    expect(markup).not.toContain('aria-label="重新发送"');
    expect(markup).not.toContain('aria-label="重新生成"');
    expect(markup).not.toContain('aria-label="更多操作"');
    expect(markup).not.toContain("在工作台查看");
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain("保存并重新执行");
    expect(markup).toMatchSnapshot();
  });
  it("does not expose inert replay controls without a connected capability", () => {
    const markup = renderToStaticMarkup(
      <MessageActions text="output" locale="en" user userMessageId="user" />,
    );
    expect(markup).toContain('aria-label="Copy"');
    expect(markup).not.toContain("Resend");
    expect(markup).not.toContain("Edit message");
  });
  it("snapshots compact horizontal actions and the bounded editor", () => {
    expect(
      readFileSync(new URL("./MessageActions.css", import.meta.url), "utf8"),
    ).toMatchSnapshot();
  });
});
