import { useEffect, useState } from "react";
import type { Locale } from "../../lib/i18n";
import type { ConnectionState } from "../../lib/shared/connectionState";
import {
  DESKTOP_PROVIDER_CHANGED_EVENT,
  providerCredentialStore,
} from "../../lib/model-provider/providerCredentialStore";

/** An unconfigured desktop needs setup, not repeated connection attempts. */
export function CommandRuntimeConnectionStatus({
  connectionState,
  locale,
  onConfigureModel,
  onReconnect,
}: {
  connectionState: ConnectionState;
  locale: Locale;
  onConfigureModel?: () => void;
  onReconnect?: () => void;
}) {
  const [needsModel, setNeedsModel] = useState(false);
  useEffect(() => {
    const store = providerCredentialStore();
    if (!store || connectionState !== "disconnected") return;
    let active = true;
    let generation = 0;
    const refresh = () => {
      const request = ++generation;
      void store
        .catalog()
        .then((catalog) => {
          if (!active || request !== generation) return;
          const binding = catalog.bindings.find((item) => item.isActive);
          setNeedsModel(!binding?.credentialAvailable || !binding.modelId);
        })
        .catch(() => {
          if (active && request === generation) setNeedsModel(false);
        });
    };
    refresh();
    globalThis.addEventListener(DESKTOP_PROVIDER_CHANGED_EVENT, refresh);
    return () => {
      active = false;
      globalThis.removeEventListener(DESKTOP_PROVIDER_CHANGED_EVENT, refresh);
    };
  }, [connectionState]);

  if (connectionState === "disconnected" && needsModel && onConfigureModel) {
    return (
      <>
        <span className="composer-state" role="status">
          {locale === "zh"
            ? "先配置 AI 模型，即可开始任务"
            : "Configure an AI model to start tasks"}
        </span>
        <button
          className="button compact"
          type="button"
          onClick={onConfigureModel}
        >
          {locale === "zh" ? "配置 AI 模型" : "Configure AI model"}
        </button>
      </>
    );
  }
  const labels = {
    connected: ["对话服务已连接", "Conversation service connected"],
    connecting: ["正在连接对话服务", "Connecting to conversation service"],
    demo: ["演示模式", "Demo mode"],
    disconnected: ["对话服务已断开", "Conversation service disconnected"],
  } as const;
  const label = labels[connectionState][locale === "zh" ? 0 : 1];
  return (
    <>
      {connectionState === "disconnected" && onReconnect ? (
        <button className="button compact" type="button" onClick={onReconnect}>
          {locale === "zh" ? "重新连接" : "Reconnect"}
        </button>
      ) : null}
      <span
        aria-label={label}
        className="connection-indicator"
        data-state={connectionState}
        role="status"
        title={label}
      />
    </>
  );
}
