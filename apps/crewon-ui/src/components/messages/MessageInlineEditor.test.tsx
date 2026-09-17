import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EditableMessageContent,
  MessageInlineEditor,
} from "./MessageInlineEditor";
import { useMessageReplay } from "./MessageReplayScope";

vi.mock("./MessageReplayScope", () => ({ useMessageReplay: vi.fn() }));
const replay = {
  available: true,
  busy: false,
  submitting: false,
  historyChanged: false,
  error: null as string | null,
  selection: {
    userMessageId: "user-2",
    expectedTurnIds: ["t1", "t2", "t3"],
    text: "项目改为春季，预算200元",
    removedTurns: 2,
  },
  textOnly: vi.fn(() => true),
  open: vi.fn(),
  cancel: vi.fn(),
  changeText: vi.fn(),
  submit: vi.fn(async () => {}),
};
beforeEach(() => vi.mocked(useMessageReplay).mockReturnValue({ ...replay }));
describe("inline message editing", () => {
  it("replaces only the selected message body, never opens a dialog", () => {
    const markup = renderToStaticMarkup(
      <div>
        <EditableMessageContent locale="zh" messageId="user-1">
          <p>保留前文</p>
        </EditableMessageContent>
        <EditableMessageContent locale="zh" messageId="user-2">
          <p>原消息正文</p>
        </EditableMessageContent>
      </div>,
    );
    expect(markup).toContain("保留前文");
    expect(markup).not.toContain("原消息正文");
    expect(markup).toContain('<form class="message-inline-editor"');
    expect(markup).toContain("项目改为春季，预算200元");
    expect(markup).toContain("2 轮回复与后续对话");
    expect(markup).toContain("保存并重新执行");
    expect(markup).not.toContain('role="dialog"');
    expect(markup).toMatchSnapshot();
  });
  it("disables submission while running and for blank edits", () => {
    vi.mocked(useMessageReplay).mockReturnValue({
      ...replay,
      busy: true,
      submitting: true,
    });
    const busy = renderToStaticMarkup(<MessageInlineEditor locale="zh" />);
    expect(busy).toContain('readOnly=""');
    expect(busy).toMatch(/<button[^>]*disabled=""[^>]*>正在重新执行/);
    vi.mocked(useMessageReplay).mockReturnValue({
      ...replay,
      selection: { ...replay.selection, text: "  " },
    });
    expect(renderToStaticMarkup(<MessageInlineEditor locale="zh" />)).toMatch(
      /<button[^>]*disabled=""[^>]*>保存并重新执行/,
    );
  });
  it("retains unconfirmed edits with copy recovery but no repeat submission", () => {
    vi.mocked(useMessageReplay).mockReturnValue({
      ...replay,
      historyChanged: true,
      error: "发送结果未确认",
    });
    const markup = renderToStaticMarkup(<MessageInlineEditor locale="zh" />);
    expect(markup).toContain("项目改为春季，预算200元");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("复制修改内容");
    expect(markup).not.toContain("保存并重新执行");
  });
  it("leaves ordinary content untouched without an editor selection", () => {
    vi.mocked(useMessageReplay).mockReturnValue({ ...replay, selection: null });
    expect(
      renderToStaticMarkup(
        <EditableMessageContent locale="zh" messageId="user-2">
          <p>原文</p>
        </EditableMessageContent>,
      ),
    ).toBe("<p>原文</p>");
  });
});
