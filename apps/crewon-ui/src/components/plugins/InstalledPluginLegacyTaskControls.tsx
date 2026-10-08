import type { Locale } from "../../lib/i18n";
import type { InstalledPluginTaskContextState } from "../../lib/plugins/useInstalledPluginTaskContext.types";
import { Button } from "../ui/button";
import styles from "./InstalledPluginLegacyTaskControls.module.css";

/** Explicit task navigation for legacy projection consumers; no connection panel or automatic task creation. */
export function InstalledPluginLegacyTaskControls({
  state,
  locale,
  onOpenTask,
}: Readonly<{
  state: InstalledPluginTaskContextState;
  locale: Locale;
  onOpenTask?: (threadId: string) => void;
}>) {
  const zh = locale === "zh";
  const thread = state.thread;
  const busy =
    state.phase === "idle" ||
    state.phase === "loading" ||
    state.phase === "preparing";
  return (
    <section
      className={styles.navigation}
      aria-label={zh ? "模块任务" : "Module tasks"}
    >
      <div className={styles.actions}>
        {state.phase === "error" ? (
          <Button variant="outline" size="sm" onClick={state.refresh}>
            {zh ? "重试读取任务" : "Retry reading task"}
          </Button>
        ) : thread ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !onOpenTask}
            onClick={() => onOpenTask?.(thread.threadId)}
          >
            {zh ? "打开任务" : "Open task"}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={state.prepareThread}
          >
            {state.phase === "uncertain"
              ? zh
                ? "重试创建任务"
                : "Retry creating task"
              : zh
                ? "创建任务"
                : "Create task"}
          </Button>
        )}
      </div>
      {state.error ? (
        <p role="alert">
          {state.phase === "uncertain"
            ? zh
              ? "创建结果尚未确认，重试会沿用同一次请求。"
              : "Creation is not confirmed. Retry the same request."
            : zh
              ? "任务暂时无法读取，请重试。"
              : "The task could not be read. Please retry."}
        </p>
      ) : null}
    </section>
  );
}
