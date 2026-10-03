import { createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { InstalledPluginSettings } from "../components/settings/InstalledPluginSettings";
import { useInstalledPluginModules } from "../lib/app/useInstalledPluginModules";
import { loadControlApiClient } from "../lib/control-runtime/controlRuntimeBootstrap";
import { installDesktopFetch } from "../lib/desktop/desktopFetch";
import type { ControlApiClient } from "@crewon/control-client";
import "../styles/neutral-scale.css";
import "../styles/app.css";
import "../styles/appearance.css";

// A real file-mode component harness, not the full product App/login shell.
async function main() {
  const assetFetch = globalThis.fetch.bind(globalThis);
  await installDesktopFetch();
  const client = await loadControlApiClient();
  if (!client) throw new Error("actual_native_control_client_missing");
  const diagnostics: string[] = [];
  const inspection = { client, diagnostics, moduleCount: 0, assetFetch };
  Object.assign(window, { nativePluginManagement: inspection });
  function Page({ client }: { client: ControlApiClient }) {
    const installed = useInstalledPluginModules({
      client,
      sessionKey: "native-local-owner-lifecycle",
      theme: "light",
      locale: "zh",
    });
    const [selected, setSelected] = useState<string | null>(null);
    useEffect(() => {
      inspection.moduleCount = installed.hostModules.length;
    }, [installed.hostModules]);
    const module = installed.hostModules.find((item) => item.id === selected);
    return createElement(
      "main",
      null,
      createElement(
        "div",
        { id: "actual-plugin-settings" },
        createElement(InstalledPluginSettings, {
          client: client.plugins,
          locale: "zh",
        }),
      ),
      createElement(
        "nav",
        { id: "actual-plugin-directory" },
        installed.hostModules.map((item) =>
          createElement(
            "button",
            {
              key: item.id,
              type: "button",
              onClick: () => setSelected(item.id),
            },
            item.label,
          ),
        ),
      ),
      createElement(
        "div",
        { id: "actual-installed-module" },
        typeof module?.content === "function"
          ? module.content({ active: true })
          : (module?.content ?? null),
      ),
    );
  }
  createRoot(document.getElementById("root")!).render(
    createElement(Page, { client }),
  );
  window.addEventListener("unhandledrejection", (event) =>
    diagnostics.push(String(event.reason)),
  );
}
void main().catch((error) => {
  document.body.dataset.error = String(error);
});
