import { describe, expect, it, vi } from "vitest";

import type { CapabilityPanel, CapabilityPanelItem } from "./capabilityPanelTypes";
import {
  openPluginPathFromPanelAction,
  updateCapabilityPanelFieldAction,
} from "./appCapabilityPanelActions";
import type { LibraryPanel } from "../domain/crewonDomain";

describe("app capability panel actions", () => {
  it("opens plugin paths as directory capability panel items", () => {
    const openedItems: CapabilityPanelItem[] = [];

    openPluginPathFromPanelAction({
      openCapabilityPanelItem: (item) => {
        openedItems.push(item);
      },
      path: "/repo/plugins/github",
    });

    expect(openedItems).toEqual([
      {
        label: "github",
        path: "/repo/plugins/github",
        kind: "directory",
      },
    ]);
  });

  it("updates matching fields in capability and library panels", () => {
    let capabilityPanel: CapabilityPanel | null = {
      title: "Capability",
      fields: [
        { id: "shared", label: "Shared", value: "old" },
        { id: "other", label: "Other", value: "kept" },
      ],
    };
    let libraryPanel: LibraryPanel | null = {
      kind: "tools",
      title: "Tools",
      subtitle: "Library",
      items: [],
      fields: [{ id: "shared", label: "Shared", value: "old" }],
    };

    updateCapabilityPanelFieldAction({
      fieldId: "shared",
      setCapabilityPanel: (updater) => {
        capabilityPanel = updater(capabilityPanel);
      },
      setLibraryPanel: (updater) => {
        libraryPanel = updater(libraryPanel);
      },
      value: "new",
    });

    expect(capabilityPanel?.fields).toEqual([
      { id: "shared", label: "Shared", value: "new" },
      { id: "other", label: "Other", value: "kept" },
    ]);
    expect(libraryPanel?.fields).toEqual([
      { id: "shared", label: "Shared", value: "new" },
    ]);
  });
});
