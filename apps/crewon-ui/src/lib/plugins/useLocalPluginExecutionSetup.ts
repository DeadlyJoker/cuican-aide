import { useEffect, useRef, useState } from "react";
import type {
  DesktopLocalPluginExecutionIdentity,
  DesktopLocalPluginExecutionPreview,
  DesktopLocalPluginExecutionResult,
  DesktopLocalPluginExecutionSetupAccess,
} from "../desktop/desktopLocalPluginExecutionSetupProtocol";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../agent-platform/agentPlatformClient";
import type { Locale } from "../i18n";
import {
  captureExecutionSetupPreview,
  captureExecutionSetupResult,
  captureExecutionSetupStatus,
  sameExecutionIdentity,
  type ExecutionSetupParameters,
} from "./localPluginExecutionSetupValidation";
import {
  clearLocalPluginExecutionSetupTicket,
  localPluginExecutionSetupTicket,
  retainLocalPluginExecutionSetupTicket,
} from "./localPluginExecutionSetupRecovery";

type Phase =
  | "loading"
  | "idle"
  | "preview"
  | "confirming"
  | "pending"
  | "unknown"
  | "committed"
  | "failed"
  | "unavailable";
type State = Readonly<{
  phase: Phase;
  preview: DesktopLocalPluginExecutionPreview | null;
  consent: boolean;
  historicalQueryConsent: boolean;
  result: DesktopLocalPluginExecutionResult | null;
  policyCommitted: boolean;
  error: string | null;
}>;
type Operation = Readonly<{ kind: "preview" | "confirm"; token: symbol }>;
type Owner = {
  access: DesktopLocalPluginExecutionSetupAccess;
  identity: DesktopLocalPluginExecutionIdentity;
  parameters: ExecutionSetupParameters;
  key: string;
  retired: boolean;
  preview: DesktopLocalPluginExecutionPreview | null;
  operation: Operation | null;
  statusRead: number;
  terminal: boolean;
};
const EMPTY: State = Object.freeze({
  phase: "idle",
  preview: null,
  consent: false,
  historicalQueryConsent: false,
  result: null,
  policyCommitted: false,
  error: null,
});

/** Only an explicit confirmation mutates Main. Recovery reads the original receipt, never repeats it. */
export function useLocalPluginExecutionSetup(
  input: Readonly<{
    access: DesktopLocalPluginExecutionSetupAccess;
    identity: DesktopLocalPluginExecutionIdentity;
    parameters: ExecutionSetupParameters;
    disabled: boolean;
    locale: Locale;
  }>,
) {
  const { access, identity, parameters, disabled, locale } = input;
  const key = JSON.stringify([access.ownerKey, identity, parameters]);
  const requested = useRef({ client: access.client, key });
  requested.current = { client: access.client, key };
  const owner = useRef<Owner | null>(null);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const [state, setState] = useState<State>(EMPTY);
  const stateRef = useRef(state);
  stateRef.current = state;
  const text = (zh: string, en: string) =>
    localeRef.current === "zh" ? zh : en;
  const alive = (current: Owner) =>
    owner.current === current &&
    !current.retired &&
    requested.current.client === current.access.client &&
    requested.current.key === current.key;
  const discardPreview = (current: Owner) => {
    const preview = current.preview;
    current.preview = null;
    if (preview) cancel(current.access, preview.previewId);
  };
  const showResult = (
    current: Owner,
    result: DesktopLocalPluginExecutionResult,
  ) => {
    current.terminal = true;
    current.preview = null;
    setState({ ...EMPTY, phase: "committed", result });
  };
  const unconfirmed = () =>
    setState({
      ...EMPTY,
      phase: "unknown",
      error: text(
        "准备结果尚未确认。请重新读取原准备状态，不要重复批准。",
        "Preparation is unconfirmed. Reload its original status without approving again.",
      ),
    });

  const readStatus = async (current: Owner): Promise<boolean> => {
    if (
      !alive(current) ||
      current.operation?.kind === "preview" ||
      current.preview
    )
      return false;
    const ticket = localPluginExecutionSetupTicket(current.access);
    if (ticket && !sameExecutionIdentity(ticket.preview, current.identity)) {
      clearLocalPluginExecutionSetupTicket(current.access, ticket);
      if (!current.terminal) setState(EMPTY);
      return false;
    }
    const sequence = ++current.statusRead;
    try {
      const raw = await current.access.client.readStatus({
        pluginId: current.identity.pluginId,
      });
      if (
        !alive(current) ||
        sequence !== current.statusRead ||
        current.terminal ||
        localPluginExecutionSetupTicket(current.access) !== ticket
      )
        return false;
      const status = captureExecutionSetupStatus(
        raw,
        current.identity,
        ticket?.preview.previewId,
      );
      if (status === null) {
        if (ticket || current.operation?.kind === "confirm") unconfirmed();
        // The owner ref was initialized after the first render. A fast status
        // read can batch with loading, so idle must still trigger a render.
        else setState({ ...EMPTY });
        return false;
      }
      if (status.state === "committed") showResult(current, status.result);
      else if (status.state === "failed") {
        current.terminal = true;
        setState({
          ...EMPTY,
          phase: "failed",
          policyCommitted: status.policyCommitted,
          error: status.policyCommitted
            ? text(
                "执行批准已保存，但准备未完成。请核对当前状态后重新准备。",
                "Execution approval was saved, but preparation failed. Check the current status before preparing again.",
              )
            : text(
                "执行准备失败。请重新预览并确认。",
                "Execution preparation failed. Preview and confirm again.",
              ),
        });
      } else setState({ ...EMPTY, phase: "pending" });
      return true;
    } catch {
      if (
        alive(current) &&
        sequence === current.statusRead &&
        !current.terminal &&
        localPluginExecutionSetupTicket(current.access) === ticket
      )
        unconfirmed();
      return false;
    }
  };

  useEffect(() => {
    const current: Owner = {
      access,
      identity: Object.freeze({ ...identity }),
      parameters: Object.freeze({ ...parameters }),
      key,
      retired: false,
      preview: null,
      operation: null,
      statusRead: 0,
      terminal: false,
    };
    owner.current = current;
    setState({ ...EMPTY, phase: "loading" });
    const withdraw = () => {
      if (!alive(current)) return;
      current.retired = true;
      current.statusRead++;
      // Claimed confirmations have no cancellable preview. Main owns their join and durable outcome.
      discardPreview(current);
      clearLocalPluginExecutionSetupTicket(current.access);
      setState({
        ...EMPTY,
        phase: "unavailable",
        error: text(
          "会话已变化，请重新打开插件参数配置。",
          "Your session changed. Reopen plugin parameters.",
        ),
      });
    };
    let releaseOwner: (() => void) | undefined;
    let releaseStatus: (() => void) | undefined;
    try {
      releaseOwner = access.client.subscribeOwnerChanged(withdraw);
      releaseStatus = access.client.subscribeStatusChanged(() => {
        void readStatus(current);
      });
      if (
        typeof releaseOwner !== "function" ||
        typeof releaseStatus !== "function"
      )
        throw new Error("invalid_execution_listener");
      void readStatus(current);
    } catch {
      withdraw();
    }
    window.addEventListener(AGENT_PLATFORM_SESSION_CHANGED_EVENT, withdraw);
    return () => {
      current.retired = true;
      current.statusRead++;
      discardPreview(current);
      releaseOwner?.();
      releaseStatus?.();
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        withdraw,
      );
    };
  }, [access.client, key]);

  useEffect(() => {
    const current = owner.current;
    if (disabled && current && alive(current) && current.preview) {
      current.statusRead++;
      discardPreview(current);
      setState(EMPTY);
    }
  }, [disabled, key]);

  useEffect(() => {
    const preview = state.preview;
    if (!preview) return;
    const timer = window.setTimeout(
      () => {
        const current = owner.current;
        if (!current || !alive(current) || current.preview !== preview) return;
        discardPreview(current);
        setState({
          ...EMPTY,
          error: text(
            "预览已过期，请重新读取。",
            "The preview expired. Read a new preview.",
          ),
        });
      },
      Math.max(0, preview.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [state.preview]);

  const preview = async () => {
    const current = owner.current;
    if (
      !current ||
      !alive(current) ||
      disabledRef.current ||
      current.operation ||
      ["pending", "unknown", "loading", "confirming"].includes(
        stateRef.current.phase,
      )
    )
      return;
    discardPreview(current);
    current.statusRead++;
    current.terminal = false;
    const operation: Operation = {
      kind: "preview",
      token: Symbol("execution-preview"),
    };
    current.operation = operation;
    setState({ ...EMPTY, phase: "loading" });
    try {
      const raw = await current.access.client.preview({
        pluginId: current.identity.pluginId,
      });
      const result = captureExecutionSetupPreview(
        raw,
        current.identity,
        current.parameters,
      );
      if (
        !alive(current) ||
        current.operation !== operation ||
        disabledRef.current
      ) {
        cancel(current.access, result.previewId);
        if (alive(current) && current.operation === operation) setState(EMPTY);
        return;
      }
      current.preview = result;
      setState({ ...EMPTY, phase: "preview", preview: result });
    } catch {
      if (alive(current) && current.operation === operation)
        setState({
          ...EMPTY,
          error: text(
            "无法预览执行准备，请重新读取当前配置。",
            "Could not preview execution setup. Reload the current configuration.",
          ),
        });
    } finally {
      if (current.operation === operation) current.operation = null;
    }
  };
  const closePreview = () => {
    const current = owner.current;
    if (!current || !alive(current) || current.operation?.kind === "confirm")
      return;
    current.operation = null;
    current.statusRead++;
    discardPreview(current);
    setState(EMPTY);
  };
  const setConsent = (consent: boolean) => {
    const current = owner.current;
    if (
      !current ||
      !alive(current) ||
      !current.preview ||
      current.operation ||
      disabledRef.current
    )
      return;
    setState((previous) => ({ ...previous, consent }));
  };
  const setHistoricalQueryConsent = (historicalQueryConsent: boolean) => {
    const current = owner.current;
    if (
      !current ||
      !alive(current) ||
      !current.preview?.historyQuery ||
      current.operation ||
      disabledRef.current
    )
      return;
    setState((previous) => ({ ...previous, historicalQueryConsent }));
  };
  const confirm = async () => {
    const current = owner.current;
    const before = stateRef.current;
    if (
      !current ||
      !alive(current) ||
      disabledRef.current ||
      current.operation ||
      !before.preview ||
      before.preview !== current.preview ||
      !before.consent ||
      (before.preview.historyQuery !== undefined &&
        !before.historicalQueryConsent)
    )
      return;
    if (before.preview.expiresAt <= Date.now()) {
      closePreview();
      return;
    }
    const ticket = retainLocalPluginExecutionSetupTicket(
      current.access,
      before.preview,
    );
    if (ticket === null) {
      closePreview();
      return;
    }
    const operation: Operation = {
      kind: "confirm",
      token: Symbol("execution-confirm"),
    };
    current.operation = operation;
    current.preview = null;
    current.statusRead++;
    setState({ ...EMPTY, phase: "confirming" });
    try {
      const raw = await current.access.client.confirm(
        Object.freeze({
          previewId: before.preview.previewId,
          approveExecution: true,
          ...(before.preview.historyQuery === undefined
            ? {}
            : { approveHistoricalQueries: true as const }),
        }),
      );
      if (
        !alive(current) ||
        current.operation !== operation ||
        current.terminal ||
        localPluginExecutionSetupTicket(current.access) !== ticket
      )
        return;
      showResult(current, captureExecutionSetupResult(raw, current.identity));
    } catch {
      if (
        !alive(current) ||
        current.operation !== operation ||
        current.terminal
      )
        return;
      if (!(await readStatus(current)) && alive(current) && !current.terminal)
        unconfirmed();
    } finally {
      if (current.operation === operation) current.operation = null;
    }
  };
  const dismiss = () => {
    const current = owner.current;
    if (
      !current ||
      !alive(current) ||
      current.operation ||
      stateRef.current.phase === "pending" ||
      stateRef.current.phase === "unknown"
    )
      return;
    clearLocalPluginExecutionSetupTicket(current.access);
    current.statusRead++;
    current.terminal = false;
    setState(EMPTY);
  };
  const current = owner.current;
  const sameOwner =
    current &&
    requested.current.client === current.access.client &&
    requested.current.key === current.key;
  const visible =
    current && (alive(current) || (sameOwner && current.retired))
      ? state
      : { ...EMPTY, phase: "unavailable" as const };
  return {
    ...visible,
    previewExecution: preview,
    confirm,
    closePreview,
    setConsent,
    setHistoricalQueryConsent,
    dismiss,
    refreshStatus: () =>
      current && alive(current) ? readStatus(current) : Promise.resolve(false),
    canPreview:
      !disabled && ["idle", "committed", "failed"].includes(visible.phase),
    canConfirm:
      !disabled &&
      visible.phase === "preview" &&
      visible.consent &&
      visible.preview !== null &&
      (visible.preview.historyQuery === undefined ||
        visible.historicalQueryConsent) &&
      visible.preview.expiresAt > Date.now(),
  };
}
function cancel(
  access: DesktopLocalPluginExecutionSetupAccess,
  previewId: string,
): void {
  try {
    void access.client.cancel({ previewId }).catch(() => {});
  } catch {
    /* Best-effort withdrawal of an unclaimed preview only. */
  }
}
