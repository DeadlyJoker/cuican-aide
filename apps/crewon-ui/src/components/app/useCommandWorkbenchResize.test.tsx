// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useCommandWorkbenchResize } from "./useCommandWorkbenchResize";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

it("grows beyond the old cap, snaps at the edge and restores without replacing content", async () => {
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(2000);
  let conversationLeft = 268;
  const originalBounds = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute("data-od-id")
        ? new DOMRect(conversationLeft, 0, 1000, 700)
        : originalBounds.call(this);
    },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function View() {
    const resize = useCommandWorkbenchResize();
    return (
      <div className="command-shell-route">
        <main data-od-id="desktop-main-pane" />
        <section
          ref={resize.workbenchRef}
          data-maximized={resize.maximized}
          data-width={resize.workbenchWidth}
          data-maximum-width={resize.maximumWidth}
          data-conversation-left={resize.conversationLeft}
        >
          <div
            role="separator"
            onPointerDown={resize.handleResizePointerDown}
            onPointerMove={resize.handleResizePointerMove}
            onPointerUp={resize.finishResize}
            onPointerCancel={resize.finishResize}
            onKeyDown={resize.handleResizeKeyDown}
          />
          <button onClick={() => resize.setMaximized((value) => !value)}>
            铺满
          </button>
          <textarea defaultValue="保留的草稿" />
        </section>
      </div>
    );
  }
  try {
    await act(async () => root.render(<View />));
    expect(container.querySelector("section")?.dataset.maximumWidth).toBe(
      "1172",
    );
    expect(container.querySelector("section")?.dataset.conversationLeft).toBe(
      "268",
    );
    const content = container.querySelector("textarea");
    const handle = container.querySelector('[role="separator"]')!;
    const pointer = async (type: string, clientX: number) =>
      act(async () => {
        handle.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 1,
            button: 0,
            clientX,
          }),
        );
      });
    await pointer("pointerdown", 1520);
    await pointer("pointermove", 900);
    expect(container.querySelector("section")?.dataset.width).toBe("1100");
    await pointer("pointermove", 800);
    expect(container.querySelector("section")?.dataset.maximized).toBe("true");
    await pointer("pointerup", 800);
    expect(container.querySelector("section")?.dataset.maximized).toBe("true");
    expect(document.documentElement.style.cursor).not.toBe("col-resize");
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector("section")?.dataset.maximized).toBe("false");
    expect(container.querySelector("textarea")).toBe(content);
    expect(content?.value).toBe("保留的草稿");
    conversationLeft = 44;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(container.querySelector("section")?.dataset.maximumWidth).toBe(
      "1396",
    );
    expect(container.querySelector("section")?.dataset.conversationLeft).toBe(
      "44",
    );
    await pointer("pointerdown", 900);
    await pointer("pointermove", 900);
    await pointer("pointercancel", 900);
    expect(container.querySelector("section")?.dataset.maximized).toBe("false");
    await act(async () =>
      handle.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      ),
    );
    expect(container.querySelector("section")?.dataset.maximized).toBe("true");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
