import { useEffect, useRef, useState } from "react";
import type {
  DesktopLocalPluginSourceImportClient,
  DesktopLocalPluginSourceConfirmed,
  DesktopLocalPluginSourcePreview,
} from "../desktop/desktopLocalPluginSourceImportProtocol";
import {
  clearLocalPluginSourceImportTicket,
  localPluginSourceImportTicket,
  retainLocalPluginSourceImportTicket,
  validateLocalPluginSourceImportResult,
  validateLocalPluginSourceImportStatus,
} from "./localPluginSourceImportRecovery";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../agent-platform/agentPlatformClient";
import type { Locale } from "../i18n";

/** Supplied by the Native route; a URL or renderer boolean does not supply this capability. */
type Binding = Readonly<{
  client: DesktopLocalPluginSourceImportClient;
  ownerKey: string;
}>;
type State = Readonly<{
  preview: DesktopLocalPluginSourcePreview | null;
  publicAssets: readonly string[];
  trustNodeExecution: boolean;
  trustUiModule: boolean;
  busy: boolean;
  error: string | null;
  feedback: string | null;
}>;
type Owner = {
  binding: Binding;
  retired: boolean;
  operation: Readonly<{ kind: "preview" | "confirm"; token: symbol }> | null;
  preview: DesktopLocalPluginSourcePreview | null;
  statusRead: number;
  terminalResult: boolean;
};
const EMPTY: State = Object.freeze({
  preview: null,
  publicAssets: Object.freeze([]),
  trustNodeExecution: false,
  trustUiModule: false,
  busy: false,
  error: null,
  feedback: null,
});

export function useLocalPluginSourceImport({
  client,
  ownerKey,
  locale,
}: Readonly<{
  client: DesktopLocalPluginSourceImportClient;
  ownerKey: string;
  locale: Locale;
}>) {
  const binding: Binding = { client, ownerKey };
  const [state, setState] = useState<State>(EMPTY);
  const stateRef = useRef(state);
  stateRef.current = state;
  const requested = useRef(binding);
  requested.current = binding;
  const owner = useRef<Owner | null>(null);
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const text = (zh: string, en: string) =>
    localeRef.current === "zh" ? zh : en;
  const alive = (current: Owner) =>
    owner.current === current &&
    !current.retired &&
    sameBinding(requested.current, current.binding);
  const showResult = (
    current: Owner,
    result: DesktopLocalPluginSourceConfirmed,
  ) => {
    current.terminalResult = true;
    current.preview = null;
    setState({
      ...EMPTY,
      feedback:
        result.runtimeStatus === "restartRequired"
          ? text(
              "来源已保存。请重启 CrewON 后安装，再选择是否启用。",
              "Source saved. Restart CrewON, then install it and choose whether to enable it.",
            )
          : text(
              "来源已添加。请在可安装插件中安装，再选择是否启用。",
              "Source added. Install it from Available, then choose whether to enable it.",
            ),
    });
  };
  const showUnconfirmed = () =>
    setState({
      ...EMPTY,
      error: text(
        "添加结果未确认，请刷新插件列表后检查；需要时重新选择目录。",
        "The result is unconfirmed. Refresh the plugin list to check, then choose the directory again if needed.",
      ),
    });
  const recoverStatus = async (current: Owner): Promise<boolean> => {
    const ticket = localPluginSourceImportTicket(current.binding);
    const read = current.binding.client.readStatus;
    if (!ticket || typeof read !== "function" || !alive(current)) return false;
    const sequence = ++current.statusRead;
    try {
      const result = await read({ previewId: ticket.identity.previewId });
      if (
        !alive(current) ||
        current.statusRead !== sequence ||
        localPluginSourceImportTicket(current.binding) !== ticket
      )
        return false;
      if (result === null) {
        if (current.operation?.kind !== "confirm" && !current.terminalResult)
          showUnconfirmed();
        return false;
      }
      validateLocalPluginSourceImportStatus(result, ticket);
      if (result.state === "committed") showResult(current, result.result);
      else if (result.state === "failed") {
        current.terminalResult = true;
        current.preview = null;
        setState({
          ...EMPTY,
          error: text(
            "添加来源失败，请检查插件列表后重新选择目录。",
            "Adding the source failed. Check the plugin list, then choose the directory again.",
          ),
        });
      } else if (!current.terminalResult) {
        setState({ ...EMPTY, busy: true });
      }
      return true;
    } catch {
      if (
        alive(current) &&
        current.statusRead === sequence &&
        localPluginSourceImportTicket(current.binding) === ticket &&
        !current.terminalResult
      )
        showUnconfirmed();
      return false;
    }
  };

  useEffect(() => {
    setState({ ...EMPTY });
    const current: Owner = {
      binding,
      retired: false,
      operation: null,
      preview: null,
      statusRead: 0,
      terminalResult: false,
    };
    owner.current = current;
    const withdraw = (reason: "owner" | "account") => {
      if (current.retired) return;
      const confirming = current.operation?.kind === "confirm";
      current.retired = true;
      current.operation = null;
      clearLocalPluginSourceImportTicket(current.binding);
      discard(current);
      setState(
        reason === "owner" && confirming
          ? {
              ...EMPTY,
              feedback: text(
                "本机会话正在切换，请等待当前会话重新读取插件来源。",
                "The local session is changing. Wait for the current session to reload plugin sources.",
              ),
            }
          : {
              ...EMPTY,
              error: text(
                "会话已变化，请重新打开插件设置。",
                "Your session changed. Reopen plugin settings.",
              ),
            },
      );
    };
    const withdrawOwner = () => withdraw("owner");
    const withdrawAccount = () => withdraw("account");
    let unsubscribe: (() => void) | undefined;
    let unsubscribeStatus: (() => void) | undefined;
    try {
      unsubscribe = client.subscribeOwnerChanged(withdrawOwner);
      if (typeof unsubscribe !== "function") throw new Error("invalid_owner");
      if (
        typeof client.readStatus === "function" &&
        typeof client.subscribeStatusChanged === "function"
      ) {
        unsubscribeStatus = client.subscribeStatusChanged(
          () => void recoverStatus(current),
        );
        if (typeof unsubscribeStatus !== "function")
          throw new Error("invalid_status_listener");
        if (localPluginSourceImportTicket(current.binding)) {
          setState({ ...EMPTY, busy: true });
          void recoverStatus(current);
        }
      }
    } catch {
      withdrawOwner();
    }
    window.addEventListener(
      AGENT_PLATFORM_SESSION_CHANGED_EVENT,
      withdrawAccount,
    );
    return () => {
      current.retired = true;
      current.operation = null;
      discard(current);
      unsubscribe?.();
      unsubscribeStatus?.();
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        withdrawAccount,
      );
    };
  }, [client, ownerKey]);

  const previewDirectory = async () => {
    const current = owner.current;
    if (!current || !alive(current) || current.operation !== null) return;
    clearLocalPluginSourceImportTicket(current.binding);
    current.terminalResult = false;
    current.statusRead++;
    discard(current);
    const operation = { kind: "preview" as const, token: Symbol("preview") };
    current.operation = operation;
    setState({ ...EMPTY, busy: true });
    try {
      const result = await current.binding.client.previewDirectory();
      if (!alive(current) || current.operation !== operation) {
        if (result !== null) cancel(current.binding.client, result.previewId);
        return;
      }
      if (result === null) {
        setState(EMPTY);
        return;
      }
      const preview = Object.freeze({
        ...result,
        uiEntry:
          result.uiEntry === null ? null : Object.freeze({ ...result.uiEntry }),
        publicAssetCandidates: Object.freeze([...result.publicAssetCandidates]),
      });
      current.preview = preview;
      setState({ ...EMPTY, preview });
    } catch {
      if (alive(current) && current.operation === operation)
        setState({
          ...EMPTY,
          error: text(
            "无法预览插件目录，请重新选择预构建目录。",
            "Could not preview the plugin. Choose a prebuilt directory again.",
          ),
        });
    } finally {
      if (current.operation === operation) current.operation = null;
    }
  };

  const closePreview = () => {
    const current = owner.current;
    if (!current || !alive(current)) return;
    current.operation = null;
    discard(current);
    setState(EMPTY);
  };

  const change = (update: (previous: State) => State) => {
    const current = owner.current;
    if (
      !current ||
      !alive(current) ||
      current.operation !== null ||
      !current.preview
    )
      return;
    setState(update);
  };
  const setPublicAsset = (path: string, selected: boolean) => {
    change((previous) => {
      if (!previous.preview?.publicAssetCandidates.includes(path))
        return previous;
      const chosen = new Set(previous.publicAssets);
      if (selected) chosen.add(path);
      else chosen.delete(path);
      return {
        ...previous,
        publicAssets: Object.freeze(
          previous.preview.publicAssetCandidates.filter((item) =>
            chosen.has(item),
          ),
        ),
        trustUiModule: chosen.size === 0 ? false : previous.trustUiModule,
      };
    });
  };
  const setNodeTrust = (trustNodeExecution: boolean) =>
    change((previous) => ({ ...previous, trustNodeExecution }));
  const setUiTrust = (trustUiModule: boolean) =>
    change((previous) => ({ ...previous, trustUiModule }));

  const confirmPreview = async () => {
    const current = owner.current;
    const snapshot = stateRef.current;
    if (
      !current ||
      !alive(current) ||
      current.operation !== null ||
      current.preview !== snapshot.preview ||
      !canConfirm(snapshot)
    )
      return;
    const preview = snapshot.preview;
    if (preview === null) return;
    const operation = { kind: "confirm" as const, token: Symbol("confirm") };
    current.operation = operation;
    const command = Object.freeze({
      previewId: preview.previewId,
      pluginId: preview.pluginId,
      publisherId: preview.publisherId,
      version: preview.version,
      packageDigest: preview.packageDigest,
      publicAssets: Object.freeze([...snapshot.publicAssets]),
      trustNodeExecution:
        preview.nodeEntry !== null && snapshot.trustNodeExecution,
      trustUiModule:
        snapshot.publicAssets.length !== 0 && snapshot.trustUiModule,
    });
    setState({ ...snapshot, busy: true, error: null, feedback: null });
    retainLocalPluginSourceImportTicket(current.binding, command);
    try {
      const result = await current.binding.client.confirmPreview(command);
      if (!alive(current) || current.operation !== operation) return;
      validateLocalPluginSourceImportResult(result, preview);
      showResult(current, result);
    } catch {
      if (alive(current) && current.operation === operation) {
        // Cleanup or a renderer transport error cannot overturn Main's committed
        // receipt. Read the same opaque ticket; never retry the mutation here.
        if ((await recoverStatus(current)) || !alive(current)) return;
        if (current.terminalResult) return;
        discard(current);
        showUnconfirmed();
      }
    } finally {
      if (current.operation === operation) current.operation = null;
    }
  };

  const visible =
    owner.current !== null && sameBinding(binding, owner.current.binding)
      ? state
      : EMPTY;
  return {
    ...visible,
    available: owner.current !== null && alive(owner.current),
    canConfirm:
      canConfirm(visible) && owner.current !== null && alive(owner.current),
    previewDirectory,
    confirmPreview,
    closePreview,
    setPublicAsset,
    setNodeTrust,
    setUiTrust,
  };
}
export type LocalPluginSourceImportState = ReturnType<
  typeof useLocalPluginSourceImport
>;

function sameBinding(left: Binding, right: Binding): boolean {
  return left.client === right.client && left.ownerKey === right.ownerKey;
}
function canConfirm(state: State): boolean {
  const preview = state.preview;
  if (
    preview === null ||
    state.busy ||
    (preview.nodeEntry !== null && !state.trustNodeExecution)
  )
    return false;
  return (
    state.publicAssets.length === 0 ||
    (preview.uiEntry?.mode === "trustedModule" &&
      state.trustUiModule &&
      state.publicAssets.includes(preview.uiEntry.path))
  );
}
function cancel(
  client: DesktopLocalPluginSourceImportClient,
  previewId: string,
): void {
  try {
    void Promise.resolve(client.cancelPreview({ previewId })).catch(() => {});
  } catch {
    // Native withdrawal already retires its references; cancellation never grants authority.
  }
}
function discard(owner: Owner): void {
  const preview = owner.preview;
  owner.preview = null;
  if (preview !== null) cancel(owner.binding.client, preview.previewId);
}
