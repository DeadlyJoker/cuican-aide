// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThreadCatalogPager } from "./ThreadCatalogPager";
import type { ThreadCatalogNavigation } from "../lib/thread/threadCatalogNavigation";

const navigation = (): ThreadCatalogNavigation => ({
  loading: false,
  empty: false,
  searching: false,
  hasOlder: true,
  hasNewer: false,
  failed: false,
  onOlder: vi.fn(),
  onNewer: vi.fn(),
  onRefresh: vi.fn(),
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("catalog pagination", () => {
  it("renders only loading and error states without a paging toolbar", () => {
    for (const state of [
      navigation(),
      { ...navigation(), loading: true },
      { ...navigation(), empty: true, searching: true },
      { ...navigation(), failed: true },
    ])
      expect(
        renderToStaticMarkup(
          <ThreadCatalogPager navigation={state} locale="zh" />,
        ),
      ).toMatchSnapshot();
  });
  it("has no paging controls for loaded, empty or historical pages", () => {
    for (const state of [
      navigation(),
      { ...navigation(), empty: true, searching: true },
      { ...navigation(), hasNewer: true },
    ]) {
      expect(
        renderToStaticMarkup(
          <ThreadCatalogPager navigation={state} locale="zh" />,
        ),
      ).toBe("");
      expect(state.onOlder).not.toHaveBeenCalled();
      expect(state.onNewer).not.toHaveBeenCalled();
      expect(state.onRefresh).not.toHaveBeenCalled();
    }
  });
  it("retains error retry and shows only loading state during a request", () => {
    const element = document.createElement("div");
    const root = createRoot(element);
    const state = { ...navigation(), failed: true };
    try {
      act(() =>
        root.render(<ThreadCatalogPager navigation={state} locale="en" />),
      );
      const button = [...element.querySelectorAll("button")].find(
        (button) => button.textContent === "Retry",
      )!;
      act(() => button.click());
      expect(state.onRefresh).toHaveBeenCalledTimes(1);
      expect(state.onOlder).not.toHaveBeenCalled();
      expect(state.onNewer).not.toHaveBeenCalled();
      act(() =>
        root.render(
          <ThreadCatalogPager
            navigation={{ ...state, loading: true }}
            locale="en"
          />,
        ),
      );
      expect(element.querySelectorAll("button")).toHaveLength(0);
      expect(element.querySelector('[role="status"]')?.textContent).toContain(
        "Loading",
      );
    } finally {
      act(() => root.unmount());
    }
  });
});
