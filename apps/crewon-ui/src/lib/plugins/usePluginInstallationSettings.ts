import { useCallback, useEffect, useRef, useState } from "react";
import {
  ControlApiClientError,
  type PluginControlClient,
} from "@crewon/control-client";
import type {
  InstallPluginPackageRequest,
  PluginSelectionListResponse,
  PluginSelectionView,
  PluginSourceListResponse,
  PluginSourceView,
  SelectPluginPackageRequest,
} from "@crewon/contracts";
import type { Locale } from "../i18n";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../agent-platform/agentPlatformClient";
import { notifyInstalledPluginSelectionChanged } from "./installedPluginChanges";
import {
  NativePluginSelectionOutcomeUnknownError,
  setPluginInstallationSelection,
} from "./pluginInstallationSelection";

export type PluginInstallationSettingsClient = Pick<
  PluginControlClient,
  | "listSources"
  | "listSelections"
  | "listPackages"
  | "getSelection"
  | "installPackage"
  | "setSelection"
>;
type Catalog = Readonly<{
  sources: PluginSourceListResponse;
  selections: PluginSelectionListResponse;
}>;
type Intent =
  | Readonly<{
      kind: "install";
      key: string;
      request: InstallPluginPackageRequest;
    }>
  | Readonly<{
      kind: "select";
      key: string;
      pluginId: string;
      request: SelectPluginPackageRequest;
    }>;
const PAGE_SIZE = 10;
const REQUEST_TIMEOUT_MS = 15_000;

/** Bounded visible pages and exact mutation retries; historical receipts never become current state. */
export function usePluginInstallationSettings(
  client: PluginInstallationSettingsClient,
  locale: Locale,
) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  const [sourceCursors, setSourceCursors] = useState<
    readonly (string | null)[]
  >([null]);
  const [selectionCursors, setSelectionCursors] = useState<
    readonly (string | null)[]
  >([null]);
  const [revision, setRevision] = useState(0);
  const owner = useRef({ client, controller: new AbortController() });
  const requestedClient = useRef(client);
  requestedClient.current = client;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const intent = useRef<Intent | null>(null);
  const mutationRunning = useRef(false);
  const sourceAfter = sourceCursors.at(-1)!;
  const selectionAfter = selectionCursors.at(-1)!;
  const zh = locale === "zh";
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const current = { client, controller: new AbortController() };
    owner.current = current;
    intent.current = null;
    mutationRunning.current = false;
    setBusy(false);
    setRetryable(false);
    setFeedback(null);
    setError(null);
    setCatalog(null);
    setSourceCursors([null]);
    setSelectionCursors([null]);
    const invalidate = () => {
      current.controller.abort();
      intent.current = null;
      setCatalog(null);
      setBusy(false);
      setLoading(false);
      setRetryable(false);
      setFeedback(null);
      setError(null);
      setReadError(
        localeRef.current === "zh"
          ? "账号已变化，请重新打开插件设置。"
          : "Your account changed. Reopen plugin settings.",
      );
    };
    window.addEventListener(AGENT_PLATFORM_SESSION_CHANGED_EVENT, invalidate);
    return () => {
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        invalidate,
      );
      current.controller.abort();
    };
  }, [client]);

  useEffect(() => {
    const current = owner.current;
    if (current.client !== client || current.controller.signal.aborted) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      current.controller.signal,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ]);
    setLoading(true);
    setReadError(null);
    // Both calls are awaited even if one fails; neither can publish into another page/session.
    void Promise.allSettled([
      client.listSources(
        { afterSourceId: sourceAfter, limit: PAGE_SIZE },
        { signal },
      ),
      client.listSelections(
        { afterPluginId: selectionAfter, limit: PAGE_SIZE },
        { signal },
      ),
    ]).then(([sources, selections]) => {
      if (
        controller.signal.aborted ||
        current.controller.signal.aborted ||
        owner.current !== current ||
        requestedClient.current !== current.client
      )
        return;
      setLoading(false);
      if (sources.status === "rejected" || selections.status === "rejected") {
        setCatalog(null);
        setReadError(
          pluginInstallationError(
            sources.status === "rejected"
              ? sources.reason
              : selections.status === "rejected"
                ? selections.reason
                : null,
            locale,
          ),
        );
        return;
      }
      setCatalog({ sources: sources.value, selections: selections.value });
    });
    return () => controller.abort();
  }, [client, sourceAfter, selectionAfter, revision, locale]);

  const run = async (build: (signal: AbortSignal) => Promise<Intent>) => {
    if (mutationRunning.current) return;
    const current = owner.current;
    if (current.client !== client || current.controller.signal.aborted) return;
    mutationRunning.current = true;
    setBusy(true);
    setError(null);
    setFeedback(null);
    const signal = AbortSignal.any([
      current.controller.signal,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ]);
    const available = () =>
      owner.current === current &&
      requestedClient.current === current.client &&
      !current.controller.signal.aborted;
    try {
      const command = intent.current ?? (await build(signal));
      if (!available()) return;
      intent.current = command;
      setRetryable(false);
      if (command.kind === "install") {
        const result = await client.installPackage(
          command.request,
          command.key,
          { signal },
        );
        if (!available()) return;
        notifyInstalledPluginSelectionChanged({
          pluginId: command.request.expectedPluginId,
          selection: result.selection,
        });
        setFeedback(
          zh
            ? "版本已安装。请在已安装插件中选择是否启用。"
            : "Version installed. Choose whether to enable it below.",
        );
      } else {
        const result = await setPluginInstallationSelection({
          client,
          pluginId: command.pluginId,
          request: command.request,
          idempotencyKey: command.key,
          signal,
          ownerSignal: current.controller.signal,
        });
        if (!available()) return;
        // This hint withdraws old UI immediately; the next directory still comes from the server.
        notifyInstalledPluginSelectionChanged({
          pluginId: command.pluginId,
          selection: result.mutation.selection,
        });
        setFeedback(
          result.projection.outcome === "pending"
            ? zh
              ? "选择已保存，运行状态尚未确认。请刷新检查。"
              : "Selection saved. Runtime status is pending; refresh to check."
            : zh
              ? "选择已保存。"
              : "Selection saved.",
        );
      }
      intent.current = null;
      setRetryable(false);
      refresh();
    } catch (cause) {
      if (!available()) return;
      // Known HTTP refusal consumed no new client intent. Unknown transport outcomes keep the exact key/body.
      const known =
        cause instanceof ControlApiClientError &&
        [400, 401, 403, 404, 409, 422].includes(cause.status);
      if (known) intent.current = null;
      setRetryable(!known && intent.current !== null);
      setError(pluginInstallationError(cause, locale));
      if (known) refresh();
      else if (
        cause instanceof NativePluginSelectionOutcomeUnknownError &&
        intent.current?.kind === "select"
      ) {
        // A failed activation can follow COMMIT. Withdraw stale modules using only an authenticated current read.
        const command = intent.current;
        try {
          const currentSelection = await client.getSelection(command.pluginId, {
            signal: AbortSignal.any([
              current.controller.signal,
              AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            ]),
          });
          if (!available()) return;
          notifyInstalledPluginSelectionChanged({
            pluginId: command.pluginId,
            ...(currentSelection.selection === null
              ? {}
              : { selection: currentSelection.selection }),
          });
          refresh();
        } catch {
          // A failed/withdrawn read cannot change the unknown outcome or the original retry intent.
        }
      }
    } finally {
      if (available()) {
        mutationRunning.current = false;
        setBusy(false);
      }
    }
  };

  const install = (source: PluginSourceView) => {
    if (intent.current !== null) return;
    return run(async (signal) => {
      const current = await client.getSelection(source.pluginId, { signal });
      return Object.freeze({
        kind: "install" as const,
        key: `plugin-settings-${crypto.randomUUID()}`,
        request: Object.freeze({
          sourceId: source.sourceId,
          expectedPluginId: source.pluginId,
          expectedPackageDigest: source.packageDigest,
          expectedSelectionRevision: current.selection?.revision ?? null,
        }),
      });
    });
  };
  const select = (
    selection: PluginSelectionView,
    next: Pick<SelectPluginPackageRequest, "state" | "selectedPackageDigest">,
  ) => {
    if (intent.current !== null) return;
    return run(async () =>
      Object.freeze({
        kind: "select" as const,
        key: `plugin-settings-${crypto.randomUUID()}`,
        pluginId: selection.pluginId,
        request: Object.freeze({
          ...next,
          expectedSelectionRevision: selection.revision,
        }),
      }),
    );
  };
  return {
    catalog:
      owner.current.client === client &&
      !owner.current.controller.signal.aborted
        ? catalog
        : null,
    loading,
    busy,
    error: error ?? readError,
    feedback,
    retryable,
    install,
    select,
    refresh,
    retry: () =>
      run(async () => {
        throw new Error("plugin_retry_intent_missing");
      }),
    sourcePage: sourceCursors.length,
    selectionPage: selectionCursors.length,
    previousSources: () =>
      setSourceCursors((values) =>
        values.length > 1 ? values.slice(0, -1) : values,
      ),
    previousSelections: () =>
      setSelectionCursors((values) =>
        values.length > 1 ? values.slice(0, -1) : values,
      ),
    nextSources: () => {
      if (catalog?.sources.next)
        setSourceCursors((values) => [...values, catalog.sources.next]);
    },
    nextSelections: () => {
      if (catalog?.selections.next)
        setSelectionCursors((values) => [...values, catalog.selections.next]);
    },
  };
}

export function pluginInstallationError(
  error: unknown,
  locale: Locale,
): string {
  const zh = locale === "zh";
  if (error instanceof ControlApiClientError) {
    if (
      error.status === 409 &&
      error.code === "desktop_plugin_candidate_selection_changed"
    )
      return zh
        ? "请先停用插件、选择所需版本并完成业务配置，再启用。"
        : "Disable the plugin, select and configure the desired version, then enable it.";
    if (error.status === 404)
      return zh
        ? "此环境尚未开启插件管理。"
        : "Plugin management is not enabled in this environment.";
    if (error.status === 401 || error.status === 403)
      return zh
        ? "当前账号无法管理这些插件。"
        : "Your account cannot manage these plugins.";
    if (error.status === 409)
      return zh
        ? "插件状态已变化，已重新读取。请检查后再操作。"
        : "Plugin state changed and was reloaded. Check before trying again.";
    if (error.status === 400 || error.status === 422)
      return zh
        ? "此版本未通过安装或兼容性检查。"
        : "This version did not pass installation or compatibility checks.";
  }
  return zh
    ? "暂时无法确认操作结果。请重试或刷新检查。"
    : "The result could not be confirmed. Retry or refresh to check.";
}
