// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import type {
  InstallPluginPackageRequest,
  PluginSelectionView,
  SelectPluginPackageRequest,
} from "@crewon/contracts";
import { usePluginInstallationSettings } from "../../lib/plugins/usePluginInstallationSettings";
import {
  INSTALLED_PLUGIN_SELECTION_CHANGED,
  installedPluginSelectionChange,
} from "../../lib/plugins/installedPluginChanges";
import {
  SettingsFetchFixture,
  SETTINGS_PLUGIN_ID,
  settingsInstallReceipt,
  settingsPackage,
  settingsSelection,
  settingsSelectionReceipt,
  settleSettings,
} from "./InstalledPluginSettings.test-support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("actual installation/select client mutations notify only their exact plugin identity", async () => {
  const fixture = new SettingsFetchFixture();
  const container = document.createElement("div");
  const root = createRoot(container);
  let state!: ReturnType<typeof usePluginInstallationSettings>;
  const changes: ({
    pluginId: string;
    selection: PluginSelectionView | null;
  } | null)[] = [];
  const listener = (event: Event) =>
    changes.push(installedPluginSelectionChange(event));
  window.addEventListener(INSTALLED_PLUGIN_SELECTION_CHANGED, listener);
  function Harness() {
    state = usePluginInstallationSettings(fixture.client.plugins, "zh");
    return null;
  }
  fixture.onMutation = (request) => {
    if (request.method === "POST") {
      const body = request.body as InstallPluginPackageRequest;
      const serial =
        body.expectedPackageDigest === settingsPackage(2).packageDigest ? 2 : 1;
      if (fixture.selections.length === 0)
        fixture.selections = [settingsSelection()];
      return settingsInstallReceipt(serial, fixture.selections[0]!);
    }
    const body = request.body as SelectPluginPackageRequest;
    const next = {
      ...settingsSelection(body.expectedSelectionRevision + 1, body.state),
      selectedPackageDigest: body.selectedPackageDigest,
    };
    fixture.selections = [next];
    return settingsSelectionReceipt(next);
  };
  try {
    await act(async () => {
      root.render(<Harness />);
      await settleSettings();
    });
    await act(async () => {
      await settleSettings();
    });
    await act(async () => {
      await state.install(fixture.sources[0]!);
      await settleSettings();
    });
    await act(async () => {
      await state.select(settingsSelection(), {
        state: "enabled",
        selectedPackageDigest: settingsSelection().selectedPackageDigest,
      });
      await settleSettings();
    });
    await act(async () => {
      await state.install(fixture.sources[1]!);
      await settleSettings();
    });
    expect(changes).toEqual([
      { pluginId: SETTINGS_PLUGIN_ID, selection: settingsSelection() },
      {
        pluginId: SETTINGS_PLUGIN_ID,
        selection: settingsSelection(2, "enabled"),
      },
      {
        pluginId: SETTINGS_PLUGIN_ID,
        selection: settingsSelection(2, "enabled"),
      },
    ]);
    expect(fixture.mutations).toHaveLength(3);
  } finally {
    window.removeEventListener(INSTALLED_PLUGIN_SELECTION_CHANGED, listener);
    await act(async () => {
      root.unmount();
      await settleSettings();
    });
  }
});
