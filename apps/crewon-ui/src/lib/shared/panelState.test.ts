import { describe, expect, it } from "vitest";

import {
  panelHasField,
  panelFieldValue,
  patchPanelState,
  trimmedPanelFieldValue,
  updatePanelFieldValue,
} from "./panelState";

describe("panel state helpers", () => {
  it("reads panel field values with a fallback", () => {
    const panel = {
      title: "Panel",
      fields: [{ id: "query", label: "Query", value: "search" }],
    };

    expect(panelFieldValue(panel, "query")).toBe("search");
    expect(panelFieldValue(panel, "missing", "fallback")).toBe("fallback");
    expect(panelFieldValue(null, "query", "fallback")).toBe("fallback");
    expect(
      trimmedPanelFieldValue(
        { fields: [{ id: "query", value: "  x " }] },
        "query",
      ),
    ).toBe("x");
    expect(panelHasField(panel, "query")).toBe(true);
    expect(panelHasField(panel, "missing")).toBe(false);
    expect(panelHasField(null, "query")).toBe(false);
  });

  it("updates a matching field value without changing other fields", () => {
    expect(
      updatePanelFieldValue(
        {
          title: "Panel",
          fields: [
            { id: "query", label: "Query", value: "old" },
            { id: "root", label: "Root", value: "/repo" },
          ],
        },
        "query",
        "new",
      ),
    ).toEqual({
      title: "Panel",
      fields: [
        { id: "query", label: "Query", value: "new" },
        { id: "root", label: "Root", value: "/repo" },
      ],
    });
  });

  it("patches panel state when a panel is present", () => {
    expect(
      patchPanelState(
        {
          title: "Panel",
          body: "old",
          error: "stale",
        },
        {
          body: "new",
          error: undefined,
        },
      ),
    ).toEqual({
      title: "Panel",
      body: "new",
      error: undefined,
    });
    expect(patchPanelState(null, { body: "new" })).toBeNull();
  });

  it("preserves panels when there are no editable fields", () => {
    const panel = { title: "Panel" };

    expect(updatePanelFieldValue(panel, "query", "new")).toEqual(panel);
    expect(updatePanelFieldValue(null, "query", "new")).toBeNull();
  });
});
