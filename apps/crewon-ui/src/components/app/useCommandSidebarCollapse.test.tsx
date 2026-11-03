// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useCommandSidebarCollapse } from "./useCommandSidebarCollapse";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("keeps the directory visible across workbench and viewport changes until the user collapses it", async () => {
  const media = new EventTarget() as MediaQueryList;
  Object.assign(media, { matches: true });
  vi.spyOn(window, "matchMedia").mockImplementation((query) =>
    query.includes("1200")
      ? media
      : (Object.assign(new EventTarget(), {
          matches: false,
        }) as MediaQueryList),
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  function View({ open }: { open: boolean }) {
    const [collapsed, setCollapsed] = useCommandSidebarCollapse();
    return (
      <button
        data-workbench-open={open}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        目录
      </button>
    );
  }
  try {
    await act(async () => root.render(<View open={false} />));
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await act(async () => root.render(<View open />));
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await act(async () =>
      media.dispatchEvent(
        Object.assign(new Event("change"), { matches: true }),
      ),
    );
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await act(async () => root.render(<View open={false} />));
    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
  } finally {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
  }
});
