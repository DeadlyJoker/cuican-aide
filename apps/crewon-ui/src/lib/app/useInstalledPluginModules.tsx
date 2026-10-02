import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ControlApiClient } from "@crewon/control-client";
import type { PluginUiTheme } from "@crewon/plugin-sdk/ui";
import type { CommandWorkspaceHostModule } from "../../components/app/CommandWorkspaceHostModule";
import { createControlPluginUiHost } from "../plugins/controlPluginUiHost";
import {
  readControlPluginUiCatalog,
  type ControlPluginUiCatalog,
} from "../plugins/controlPluginUiCatalog";
import { PluginUiLoaderError } from "../plugins/pluginUiValidation";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../agent-platform/agentPlatformClient";
import type { Locale } from "../i18n";
import type { Theme } from "../theme";
import { InstalledPluginModule } from "../../components/plugins/InstalledPluginModule";
import { readPluginUiTheme } from "../../components/plugins/pluginUiPresentation";

const CATALOG_REFRESH_INTERVAL_MS = 5_000;
const CATALOG_SNAPSHOT_DEADLINE_MS = 10_000;
const EMPTY_MODULES: readonly CommandWorkspaceHostModule[] = Object.freeze([]);

/** Formal App composition. Directory data never supplies an account, transport or global shell. */
export function useInstalledPluginModules({
  client,
  sessionKey,
  theme,
  locale,
}: Readonly<{
  client: ControlApiClient | null;
  /** A host account lifecycle key only; HTTP authority continues to come from its authenticated session. */
  sessionKey: string | null;
  theme: Theme;
  locale: Locale;
}>) {
  const [suspendedClient, setSuspendedClient] =
    useState<ControlApiClient | null>(null);
  const diagnostics = useRef<readonly string[]>(Object.freeze([]));
  const onDiagnostic = useCallback((error: unknown) => {
    let text: string;
    try {
      text = String(error).slice(0, 1024);
    } catch {
      text = "plugin_ui_diagnostic_unavailable";
    }
    diagnostics.current = Object.freeze([
      ...diagnostics.current.slice(-15),
      text,
    ]);
  }, []);
  const scope = useMemo(() => {
    if (
      !client ||
      client === suspendedClient ||
      (location.protocol !== "http:" && location.protocol !== "https:") ||
      client.requestOrigin !== location.origin
    )
      return null;
    return { client, sessionKey };
  }, [client, suspendedClient, sessionKey]);
  const current = useRef(scope);
  current.current = scope;
  const host = useMemo(
    () =>
      scope
        ? createControlPluginUiHost({
            client: scope.client,
            assertCurrent: () => {
              if (current.current !== scope)
                throw new PluginUiLoaderError("plugin_ui_session_changed");
            },
            onDiagnostic,
          })
        : null,
    [scope, onDiagnostic],
  );
  const [snapshot, setSnapshot] = useState<Readonly<{
    scope: NonNullable<typeof scope>;
    catalog: ControlPluginUiCatalog;
  }> | null>(null);
  const [presentation, setPresentation] = useState<PluginUiTheme>(() =>
    readPluginUiTheme(document.documentElement, theme),
  );
  useLayoutEffect(() => {
    const refresh = () => {
      const next = readPluginUiTheme(document.documentElement, theme);
      setPresentation((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, [theme]);
  useLayoutEffect(() => {
    const invalidate = () => {
      // Withdraw before a replacement client bootstrap finishes, including a bootstrap that fails.
      current.current = null;
      setSuspendedClient(client);
      setSnapshot(null);
    };
    window.addEventListener(AGENT_PLATFORM_SESSION_CHANGED_EVENT, invalidate);
    return () =>
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        invalidate,
      );
  }, [client]);
  useEffect(() => {
    if (!scope || !host) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = async () => {
      try {
        const catalog = await readControlPluginUiCatalog({
          client: scope.client,
          assertCurrent: () => {
            if (current.current !== scope)
              throw new PluginUiLoaderError("plugin_ui_session_changed");
          },
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(CATALOG_SNAPSHOT_DEADLINE_MS),
          ]),
        });
        if (!controller.signal.aborted && current.current === scope)
          setSnapshot((previous) =>
            previous?.scope === scope &&
            previous.catalog.fingerprint === catalog.fingerprint
              ? previous
              : { scope, catalog },
          );
      } catch (error) {
        if (!controller.signal.aborted && current.current === scope) {
          setSnapshot(null);
          onDiagnostic(error);
        }
      } finally {
        if (!controller.signal.aborted && current.current === scope)
          timer = setTimeout(() => void refresh(), CATALOG_REFRESH_INTERVAL_MS);
      }
    };
    void refresh();
    return () => {
      controller.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [scope, host, onDiagnostic]);
  const catalog = snapshot?.scope === scope ? snapshot.catalog : null;
  const hostModules = useMemo<readonly CommandWorkspaceHostModule[]>(() => {
    if (!host || !catalog) return EMPTY_MODULES;
    return Object.freeze(
      catalog.modules.map((module) =>
        Object.freeze({
          id: module.key,
          label: module.title,
          content: ({ active }: Readonly<{ active: boolean }>) => (
            <InstalledPluginModule
              key={module.mountKey}
              host={host}
              module={module}
              active={active}
              theme={presentation}
              locale={locale}
              onDiagnostic={onDiagnostic}
            />
          ),
        }),
      ),
    );
  }, [host, catalog, presentation, locale, onDiagnostic]);
  return { hostModules, getDiagnostics: () => diagnostics.current };
}
