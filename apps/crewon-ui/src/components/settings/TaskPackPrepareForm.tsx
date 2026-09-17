import { useEffect, useRef, useState } from "react";
import {
  MAX_TASK_PACK_SOURCE_BYTES,
  MAX_TASK_PACK_SOURCE_LINES,
  prepareTaskPack,
  type TaskPack,
  type TaskPackConfiguration,
} from "@crewon/capability-packs";
import type { Locale } from "../../lib/i18n";
import type { TaskPackDraftHandler } from "../../lib/plugin/prepareTaskPackDraft";
import { Button } from "../ui/button";

export function TaskPackPrepareForm({
  pack,
  configuration,
  locale,
  onPrepare,
}: {
  pack: TaskPack;
  configuration: TaskPackConfiguration;
  locale: Locale;
  onPrepare: TaskPackDraftHandler | undefined;
}) {
  const zh = locale === "zh";
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const preparing = useRef(false);
  const alive = useRef(true);
  const prepareHandler = useRef(onPrepare);
  prepareHandler.current = onPrepare;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const bytes = new TextEncoder().encode(source).length;
  const lines = source.replace(/\r\n?/g, "\n").split("\n").length;
  const exceedsLimit =
    bytes > MAX_TASK_PACK_SOURCE_BYTES || lines > MAX_TASK_PACK_SOURCE_LINES;
  return (
    <form
      className="task-pack-prepare"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!onPrepare || preparing.current) return;
        preparing.current = true;
        setBusy(true);
        setError("");
        try {
          const prepared = await prepareTaskPack({
            packId: pack.id,
            packVersion: pack.version,
            configuration,
            source,
          });
          if (!alive.current) return;
          const failure = prepareHandler.current?.(prepared.prompt);
          if (failure) setError(failure);
        } catch {
          if (alive.current)
            setError(
              zh
                ? "准备失败，请检查材料后重试。原草稿未被覆盖。"
                : "Could not prepare the draft. Check the material and retry. Your existing draft was not replaced.",
            );
        } finally {
          preparing.current = false;
          if (alive.current) setBusy(false);
        }
      }}
    >
      <label>
        <strong>{zh ? "会议材料" : "Meeting material"}</strong>
        <textarea
          rows={7}
          value={source}
          disabled={busy}
          required
          aria-invalid={exceedsLimit || undefined}
          aria-describedby={`task-pack-source-hint-${pack.id}`}
          placeholder={
            zh
              ? "粘贴原始记录、决定和行动项。保留发言人、时间与资料来源；不必预先整理。"
              : "Paste raw notes, decisions and actions with speakers, dates and sources."
          }
          onChange={(event) => {
            setSource(event.target.value);
            setError("");
          }}
        />
      </label>
      <p id={`task-pack-source-hint-${pack.id}`}>
        {lines} / {MAX_TASK_PACK_SOURCE_LINES} {zh ? "行" : "lines"} ·{" "}
        {Number((bytes / 1000).toFixed(1))} /{" "}
        {MAX_TASK_PACK_SOURCE_BYTES / 1000} kB ·{" "}
        {zh
          ? "发送后，材料将保存在本次会话中。"
          : "Once sent, the material is saved in this conversation."}
      </p>
      {exceedsLimit && (
        <p role="alert">
          {zh
            ? "材料超过 16 kB 或 200 行，请精简后重试。内容不会自动截断。"
            : "Material exceeds 16 kB or 200 lines. Shorten it and retry. Nothing is truncated automatically."}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="task-pack-actions">
        <Button
          type="submit"
          disabled={!onPrepare || busy || !source.trim() || exceedsLimit}
        >
          {busy
            ? zh
              ? "准备中…"
              : "Preparing…"
            : zh
              ? "准备草稿"
              : "Prepare draft"}
        </Button>
      </div>
      <p>
        {zh
          ? "草稿会放入新任务，不会自动发送。发送前请检查内容、模型、执行方式和权限。结果可在右侧工作台查看。"
          : "The draft opens in a new task without being sent. Check its content, model, execution mode and permissions before sending. View results in the right workbench."}
      </p>
    </form>
  );
}
