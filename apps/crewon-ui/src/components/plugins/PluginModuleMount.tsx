import { useEffect, useLayoutEffect, useRef } from "react";
import type { PluginUiLease } from "@crewon/contracts/plugins";
import type { PluginUiProps } from "@crewon/plugin-sdk/ui";
import {
  TrustedPluginUiLoader,
  type PluginUiMountHandle,
} from "../../lib/plugins/trustedPluginUiLoader";
import { PluginUiLoaderError } from "../../lib/plugins/pluginUiValidation";

export type PluginModuleMountProps = Readonly<{
  loader: TrustedPluginUiLoader;
  /** Trusted host closure captures the session/profile/selection; plugins never receive this function. */
  acquireMount(signal: AbortSignal): Promise<PluginUiLease>;
  mountKey: string;
  active: boolean;
  props: PluginUiProps;
  className?: string;
  onError?(error: unknown): void;
  onMounted?(): void;
}>;

/** A content-slot mount only. Navigation, theme initialization and the application shell remain host-owned. */
export function PluginModuleMount({
  loader,
  acquireMount,
  mountKey,
  active,
  props,
  className,
  onError,
  onMounted,
}: PluginModuleMountProps) {
  const root = useRef<HTMLDivElement>(null);
  const current = useRef<{ handle: PluginUiMountHandle; key: string } | null>(
    null,
  );
  const pending = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const latestProps = useRef(props);
  const errorHandler = useRef(onError);
  const mountedHandler = useRef(onMounted);
  latestProps.current = props;
  errorHandler.current = onError;
  mountedHandler.current = onMounted;

  function report(error: unknown) {
    if (
      error instanceof PluginUiLoaderError &&
      (error.code === "plugin_ui_operation_aborted" ||
        error.code === "plugin_ui_update_superseded")
    )
      return;
    errorHandler.current?.(error);
  }

  useLayoutEffect(
    () => () => {
      ++epoch.current;
      pending.current?.abort();
      pending.current = null;
      const owned = current.current;
      current.current = null;
      if (owned) void owned.handle.stop().catch(report);
    },
    [loader, active],
  );

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const generation = ++epoch.current;
    pending.current?.abort();
    pending.current = controller;
    let published = false;
    const isCurrent = () =>
      !controller.signal.aborted && epoch.current === generation;
    const mount = async () => {
      const lease = await acquireMount(controller.signal);
      if (!isCurrent() || !root.current) {
        await loader.closeUnusedMount(lease);
        return;
      }
      const initialProps = latestProps.current;
      const handle = await loader.mount({
        root: root.current,
        lease,
        props: initialProps,
        signal: controller.signal,
      });
      if (!isCurrent()) {
        await handle.stop();
        return;
      }
      published = true;
      current.current = { handle, key: mountKey };
      if (pending.current === controller) pending.current = null;
      if (latestProps.current !== initialProps)
        await handle.update(latestProps.current);
      if (isCurrent()) mountedHandler.current?.();
    };
    void mount().catch(report);
    // A pending replacement is cancelled, while an already published previous module stays until the new one is ready.
    return () => {
      if (!published) controller.abort();
    };
  }, [loader, acquireMount, mountKey, active]);

  useEffect(() => {
    const owned = current.current;
    if (active && owned?.key === mountKey)
      void owned.handle.update(props).catch(report);
  }, [props, mountKey, active]);

  return (
    <div
      ref={root}
      className={className}
      data-plugin-content-slot="main.content"
    />
  );
}
