import type { Locale } from "../../lib/i18n";
import type { InstalledPluginGenerationContextState } from "../../lib/plugins/useInstalledPluginGenerationContext.types";
import { Button } from "../ui/button";
import styles from "./InstalledPluginTaskControls.module.css";

/** The Host owns conversation preparation and verified navigation; the module owns its saved business input. */
export function InstalledPluginGenerationControls({
  state,
  locale,
}: Readonly<{ state: InstalledPluginGenerationContextState; locale: Locale }>) {
  const zh = locale === "zh";
  const { context } = state;
  const unresolved =
    context.intent?.phase === "pending" ||
    context.intent?.phase === "uncertain";
  const busy = context.phase === "loading" || context.phase === "preparing";
  return (
    <section
      className={styles.controls}
      aria-label={zh ? "生成任务会话" : "Generation conversation"}
    >
      <div className={styles.actions}>
        {!context.thread && !unresolved ? (
          <Button
            size="sm"
            disabled={busy || context.phase === "idle"}
            onClick={state.prepareThread}
          >
            {context.phase === "uncertain"
              ? zh
                ? "重试创建会话"
                : "Retry creating conversation"
              : zh
                ? "创建任务会话"
                : "Create task conversation"}
          </Button>
        ) : (
          <span role="status">
            {unresolved
              ? zh
                ? "生成请求待确认"
                : "Generation request unconfirmed"
              : zh
                ? "任务会话已就绪"
                : "Task conversation ready"}
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={busy || context.phase === "idle"}
          onClick={state.refresh}
        >
          {zh ? "刷新会话状态" : "Refresh conversation"}
        </Button>
        {state.canOpenTask ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void state.openTask();
            }}
          >
            {zh ? "打开生成任务" : "Open generation task"}
          </Button>
        ) : null}
      </div>
      {busy ? (
        <p role="status">{zh ? "正在读取会话…" : "Reading conversation…"}</p>
      ) : null}
      {state.error ? (
        <p role="alert">
          {unresolved
            ? zh
              ? "生成结果尚未确认，请保留原请求。"
              : "Generation is unconfirmed. Keep the original request."
            : context.phase === "uncertain"
              ? zh
                ? "会话创建结果尚未确认，请重试同一次请求。"
                : "Conversation creation is unconfirmed. Retry the same request."
              : zh
                ? "任务会话暂不可用，请刷新后重试。"
                : "The task conversation is unavailable. Refresh to retry."}
        </p>
      ) : null}
    </section>
  );
}
