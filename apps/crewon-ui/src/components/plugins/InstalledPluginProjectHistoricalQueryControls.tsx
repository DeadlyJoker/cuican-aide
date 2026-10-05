import type { Locale } from "../../lib/i18n";
import type { InstalledPluginProjectHistoricalQueryContextState } from "../../lib/plugins/useInstalledPluginProjectHistoricalQueryContext";
import { Button } from "../ui/button";
import styles from "./InstalledPluginTaskControls.module.css";

/** Only the business module chooses a saved operation; the Host verifies query navigation. */
export function InstalledPluginProjectHistoricalQueryControls({
  state,
  locale,
}: Readonly<{
  state: InstalledPluginProjectHistoricalQueryContextState;
  locale: Locale;
}>) {
  const zh = locale === "zh";
  const unresolved =
    state.context.intent?.phase === "pending" ||
    state.context.intent?.phase === "uncertain";
  return (
    <section
      className={styles.controls}
      aria-label={zh ? "历史任务查询" : "Historical task query"}
    >
      <div className={styles.actions}>
        <span role="status">
          {unresolved
            ? zh
              ? "查询请求待确认"
              : "Query request unconfirmed"
            : state.context.intent?.phase === "accepted"
              ? zh
                ? "查询任务已接受"
                : "Query task accepted"
              : zh
                ? "查询任务未提交"
                : "Query task not submitted"}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={
            state.context.phase === "idle" || state.context.phase === "loading"
          }
          onClick={state.refresh}
        >
          {zh ? "刷新查询会话" : "Refresh query conversation"}
        </Button>
        {state.canOpenTask ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void state.openTask();
            }}
          >
            {zh ? "打开查询任务" : "Open query task"}
          </Button>
        ) : null}
      </div>
      {state.error ? (
        <p role="alert">
          {unresolved
            ? zh
              ? "查询结果尚未确认，请保留原请求。"
              : "Query is unconfirmed. Keep the original request."
            : zh
              ? "查询任务暂不可用，请刷新后重试。"
              : "The query task is unavailable. Refresh to retry."}
        </p>
      ) : null}
    </section>
  );
}
