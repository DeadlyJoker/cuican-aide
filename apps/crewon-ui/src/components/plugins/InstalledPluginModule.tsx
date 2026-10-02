import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PluginUiLease } from "@crewon/contracts/plugins";
import type { PluginUiProps, PluginUiTheme } from "@crewon/plugin-sdk/ui";
import type { ControlPluginUiHost } from "../../lib/plugins/controlPluginUiHost";
import type { ControlPluginUiModule } from "../../lib/plugins/controlPluginUiCatalog";
import type { Locale } from "../../lib/i18n";
import { PluginModuleMount } from "./PluginModuleMount";

const LEASE_CHECK_INTERVAL_MS = 1_000;
type Monitor = {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
};

/** One installed content slot. The host owns its session, reference, theme and cleanup. */
export function InstalledPluginModule({
  host,
  module,
  active,
  theme,
  locale,
  onDiagnostic,
}: Readonly<{
  host: ControlPluginUiHost;
  module: ControlPluginUiModule;
  active: boolean;
  theme: PluginUiTheme;
  locale: Locale;
  onDiagnostic(error: unknown): void;
}>) {
  // Catalog refresh recreates DTOs. Only a changed host or complete package/contribution pin replaces this instance.
  const modulePin = useMemo(
    () =>
      JSON.stringify([
        module.key,
        module.mountKey,
        module.contributionId,
        module.plugin,
      ]),
    [module],
  );
  const context = useMemo(
    () => ({ host, module, active }),
    [host, modulePin, active],
  );
  const current = useRef(context);
  current.current = context;
  const monitor = useRef<Monitor | null>(null);
  const [failed, setFailed] = useState<typeof context | null>(null);
  const [ready, setReady] = useState<typeof context | null>(null);
  const diagnostic = useRef(onDiagnostic);
  diagnostic.current = onDiagnostic;
  const stopMonitor = useCallback(() => {
    const owned = monitor.current;
    monitor.current = null;
    if (!owned) return;
    owned.controller.abort();
    if (owned.timer !== null) clearTimeout(owned.timer);
  }, []);
  useLayoutEffect(() => () => stopMonitor(), [context, stopMonitor]);
  const report = useCallback(
    (error: unknown) => {
      if (current.current === context && context.active) {
        stopMonitor();
        setFailed(context);
      }
      try {
        diagnostic.current(error);
      } catch {
        // Diagnostics must not interrupt revocation or leave an unhandled asynchronous failure.
      }
    },
    [context, stopMonitor],
  );
  const acquireMount = useCallback(
    async (signal: AbortSignal): Promise<PluginUiLease> => {
      const lease = await context.host.acquireMount(
        context.module.plugin,
        context.module.contributionId,
        signal,
      );
      if (signal.aborted || current.current !== context) return lease;
      stopMonitor();
      const owned: Monitor = { controller: new AbortController(), timer: null };
      monitor.current = owned;
      const check = async () => {
        if (
          owned.controller.signal.aborted ||
          monitor.current !== owned ||
          current.current !== context
        )
          return;
        try {
          await context.host.validateLease(lease, owned.controller.signal);
          if (
            !owned.controller.signal.aborted &&
            monitor.current === owned &&
            current.current === context
          )
            owned.timer = setTimeout(
              () => void check(),
              LEASE_CHECK_INTERVAL_MS,
            );
        } catch (error) {
          if (
            !owned.controller.signal.aborted &&
            monitor.current === owned &&
            current.current === context
          )
            report(error);
        }
      };
      owned.timer = setTimeout(() => void check(), LEASE_CHECK_INTERVAL_MS);
      return lease;
    },
    [context, report, stopMonitor],
  );
  const props = useMemo<PluginUiProps>(
    () => ({
      schemaVersion: "crewon.plugin-ui-props.v1",
      contributionId: module.contributionId,
      theme,
      data: Object.freeze({ locale }),
    }),
    [module.contributionId, theme, locale],
  );
  const onMounted = useCallback(() => {
    if (current.current === context && context.active) setReady(context);
  }, [context]);
  if (!active) return null;
  if (failed === context)
    return (
      <p role="alert">
        {locale === "zh"
          ? "模块暂时不可用，请稍后重新进入。"
          : "This module is temporarily unavailable. Reopen it to try again."}
      </p>
    );
  return (
    <>
      {ready !== context ? (
        <p role="status">
          {locale === "zh" ? "正在加载模块…" : "Loading module…"}
        </p>
      ) : null}
      <PluginModuleMount
        active={active}
        loader={host.loader}
        acquireMount={acquireMount}
        mountKey={module.mountKey}
        props={props}
        onError={report}
        onMounted={onMounted}
      />
    </>
  );
}
