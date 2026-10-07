import { useEffect, useSyncExternalStore } from "react";
import type { PublicMediaInput } from "../project-media-inputs-ui-client";
import { ProjectMediaGenerationController } from "./ProjectMediaGenerationController";

export function ProjectMediaGenerationActions({
  controller,
  input,
  inputBlocked,
  blocked,
}: {
  controller: ProjectMediaGenerationController;
  input: PublicMediaInput | null;
  inputBlocked: boolean;
  blocked: boolean;
}) {
  const s = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    controller.setInput(input, inputBlocked);
  }, [controller, input, inputBlocked]);
  useEffect(() => {
    controller.activate();
  }, [controller]);
  const working = s.status === "preparing" || s.status === "checking";
  return (
    <section className="detail-panel" aria-label="生成参考画面">
      <div className="panel-heading">
        <h3>生成画面</h3>
        <span className="version-chip">
          {input ? `使用输入 v${input.inputRevision}` : "先保存输入"}
        </span>
      </div>
      <p className="detail-note">
        使用已采用的参考图生成画面，任务会进入这个项目的原会话。
      </p>
      {!input && (
        <p className="detail-note">先保存画面描述和参考来源，再开始生成。</p>
      )}
      {input && inputBlocked && (
        <p className="detail-note">
          请先保存修改，并使用当前需求下的最新输入。
        </p>
      )}
      {!controller.hasThread && (
        <p className="detail-note">
          请先从“项目会话”打开关联会话，再返回这里生成。
        </p>
      )}
      {s.phase === "loading" && (
        <p className="detail-note" role="status">
          正在读取原请求记录…
        </p>
      )}
      {working && (
        <p className="detail-note" role="status">
          {s.status === "checking"
            ? "正在确认项目会话…"
            : "正在准备参考图并提交任务，请稍候…"}
        </p>
      )}
      {s.error && (
        <p className="detail-note" role="alert">
          {s.error}
        </p>
      )}
      {controller.foreignIntent && s.status === "uncertain" && (
        <p className="detail-note" role="alert">
          有另一个项目的请求待确认，请返回该项目恢复。不会自动重新生成。
        </p>
      )}
      {s.status === "uncertain" && (
        <p className="detail-note">
          原请求：输入 v{s.request?.inputRevision}
          。恢复只读取记录；重试会继续使用原请求号。
        </p>
      )}
      {s.receipt && (
        <p className="detail-note" role="status">
          任务已受理，请在项目会话查看执行进度和产出。
        </p>
      )}
      <div className="detail-actions">
        {s.status !== "uncertain" && (
          <button
            className="button primary"
            disabled={blocked || !controller.canGenerate}
            onClick={() => void controller.generate()}
          >
            {s.receipt ? "再次生成画面" : "生成画面"}
          </button>
        )}
        {working && (
          <button
            className="button secondary"
            onClick={() => controller.cancel()}
          >
            停止等待
          </button>
        )}
        {!working && (
          <button
            className="text-button"
            disabled={blocked || s.phase === "loading"}
            onClick={() => void controller.recover()}
          >
            恢复原请求状态
          </button>
        )}
        {s.status === "uncertain" && (
          <button
            className="button secondary"
            disabled={blocked || !controller.canRetry}
            onClick={() => void controller.retry()}
          >
            用原请求重试
          </button>
        )}
        {s.receipt && (
          <button
            className="button secondary"
            disabled={blocked}
            onClick={() => void controller.openConversation()}
          >
            打开项目会话
          </button>
        )}
      </div>
    </section>
  );
}
