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
  it("renders loading, empty continuation, error and navigation states", () => {
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
  it("continues an empty search page and disables navigation while the request is running", () => {
    const element = document.createElement("div");
    const root = createRoot(element);
    const state = { ...navigation(), empty: true, searching: true };
    try {
      act(() =>
        root.render(<ThreadCatalogPager navigation={state} locale="en" />),
      );
      const button = [...element.querySelectorAll("button")].find(
        (button) => button.textContent === "Continue search",
      )!;
      act(() => button.click());
      expect(state.onOlder).toHaveBeenCalledTimes(1);
      act(() =>
        root.render(
          <ThreadCatalogPager
            navigation={{ ...state, loading: true }}
            locale="en"
          />,
        ),
      );
      expect(
        [...element.querySelectorAll("button")].every(
          (button) => button.disabled,
        ),
      ).toBe(true);
      expect(element.querySelector('[role="status"]')?.textContent).toContain(
        "Loading",
      );
    } finally {
      act(() => root.unmount());
    }
  });
});
