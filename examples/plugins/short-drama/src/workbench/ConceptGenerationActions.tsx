import { useSyncExternalStore } from "react";
import type { ConceptGenerationIntentController } from "./ConceptGenerationIntentController";

export function ConceptGenerationActions({
  controller,
}: {
  controller: ConceptGenerationIntentController;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  return (
    <section className="detail-panel" aria-label="概念图生成">
      <h2>生成概念图</h2>
      {state.intentPhase === "pending" ? (
        <p className="detail-note" role="status">
          正在提交原生成请求，请稍候…
        </p>
      ) : state.intentPhase === "uncertain" ? (
        <>
          <p className="detail-note" role="status">
            生成结果尚未确认。原请求已保留，请勿再次新建生成。
          </p>
          <button
            className="button secondary"
            disabled={!controller.canRetry}
            onClick={() => void controller.retry()}
          >
            重试原生成请求
          </button>
          {!state.retryable && (
            <p className="detail-note">当前无法重试，请先刷新会话状态。</p>
          )}
        </>
      ) : state.intentPhase === "accepted" ? (
        <p className="detail-note" role="status">
          生成任务已受理，可刷新下方任务记录。
        </p>
      ) : state.intentPhase === "refused" ? (
        <>
          <p className="detail-note" role="status">
            本次生成尚未发送，请重新确认输入与任务会话。
          </p>
          <button
            className="button secondary"
            disabled={state.recovery === "loading"}
            onClick={() => void controller.refreshRefused()}
          >
            重新确认生成准备状态
          </button>
        </>
      ) : (
        <>
          <button
            className="button primary"
            disabled={!state.canGenerate}
            onClick={() => void controller.generate()}
          >
            生成概念图
          </button>
          {state.phase === "checking" && (
            <p className="detail-note" role="status">
              正在确认生成准备状态…
            </p>
          )}
          {state.phase === "unavailable" && (
            <button
              className="button secondary"
              onClick={() => void controller.refreshReadiness()}
            >
              刷新生成准备状态
            </button>
          )}
          {state.phase === "idle" && (
            <p className="detail-note">
              先保存输入，再在上方创建或选择任务会话；已有生成的版本需保存为新修订。
            </p>
          )}
        </>
      )}
      {state.reason && (
        <p className="detail-note" role="status">
          {state.reason}
        </p>
      )}
      {state.recovery === "loading" && (
        <p className="detail-note" role="status">
          正在恢复原生成请求的已保存输入…
        </p>
      )}
      {state.recovery === "unavailable" && (
        <>
          <p className="detail-note" role="alert">
            原生成输入暂时无法读取，请重试；原请求仍保留。
          </p>
          <button
            className="button secondary"
            onClick={() => void controller.restoreSource()}
          >
            重新读取原生成输入
          </button>
        </>
      )}
      <p className="detail-note">提交前会检查插件积分是否足够。</p>
    </section>
  );
}
