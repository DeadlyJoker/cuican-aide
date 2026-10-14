import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { PluginUiLease } from "@crewon/contracts/plugins";
import type { PluginUiProps } from "@crewon/plugin-sdk/ui";
import {
  TrustedPluginUiLoader,
  type PluginUiMountHandle,
} from "../../lib/plugins/trustedPluginUiLoader";
import { PluginUiLoaderError } from "../../lib/plugins/pluginUiValidation";
import { PluginUiUpdateDeferredError } from "../../lib/plugins/pluginUiPresentationUpdate";

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
  const owner = useMemo(
    () => ({ loader, acquireMount, mountKey, active }),
    [loader, acquireMount, mountKey, active],
  );
  const committedOwner = useRef(owner);
  const current = useRef<{
    handle: PluginUiMountHandle;
    owner: typeof owner;
  } | null>(null);
  const pending = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const latestProps = useRef(props);
  const errorHandler = useRef(onError);
  const mountedHandler = useRef(onMounted);
  // Invalidate an old completion during commit, before passive effects replace its mount.
  // A changed callback alone still belongs to the same owner and receives completion.
  useLayoutEffect(() => {
    committedOwner.current = owner;
    latestProps.current = props;
    errorHandler.current = onError;
    mountedHandler.current = onMounted;
  });

  function report(error: unknown, handler = errorHandler.current) {
    // The host retains the latest props until its live lease observation recovers.
    // The original transient error remains in loader diagnostics, without unmounting authorized content.
    if (error instanceof PluginUiUpdateDeferredError) return;
    if (
      error instanceof PluginUiLoaderError &&
      (error.code === "plugin_ui_operation_aborted" ||
        error.code === "plugin_ui_update_superseded")
    )
      return;
    handler?.(error);
  }

  useLayoutEffect(
    () => () => {
      ++epoch.current;
      pending.current?.abort();
      pending.current = null;
      const owned = current.current;
      current.current = null;
      const handler = errorHandler.current;
      if (owned)
        void owned.handle.stop().catch((error) => report(error, handler));
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
      !controller.signal.aborted &&
      epoch.current === generation &&
      committedOwner.current === owner;
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
      current.current = { handle, owner };
      if (pending.current === controller) pending.current = null;
      if (latestProps.current !== initialProps) {
        try {
          await handle.update(latestProps.current);
        } catch (error) {
          if (!(error instanceof PluginUiUpdateDeferredError)) throw error;
        }
      }
      if (isCurrent()) mountedHandler.current?.();
    };
    void mount().catch((error) => {
      if (isCurrent()) report(error);
    });
    // A pending replacement is cancelled, while an already published previous module stays until the new one is ready.
    return () => {
      if (!published) controller.abort();
    };
  }, [owner, loader, acquireMount, mountKey, active]);

  useEffect(() => {
    const owned = current.current;
    if (active && owned?.owner === owner)
      void owned.handle.update(props).catch((error) => {
        if (committedOwner.current === owner && current.current === owned)
          report(error);
      });
  }, [props, owner, active]);

  return (
    <div
      ref={root}
      className={className}
      data-plugin-content-slot="main.content"
    />
  );
}
