import type { Locale } from "../../lib/i18n";
import type { ConnectionState } from "../../lib/shared/connectionState";
import { useDesktopModelSetup } from "./useDesktopModelSetup";

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
  const needsModel = useDesktopModelSetup(connectionState === "disconnected");

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
