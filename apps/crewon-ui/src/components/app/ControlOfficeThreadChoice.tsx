import type { ThreadView } from "@crewon/contracts";
import type { Locale } from "../../lib/i18n";

export function ControlOfficeThreadChoice({
  candidate,
  unbound,
  locale,
  busy,
  onClaim,
  onCreate,
  onRetry,
}: {
  candidate: ThreadView | null;
  unbound: boolean;
  locale: Locale;
  busy: boolean;
  onClaim: () => void;
  onCreate: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="office-chat-empty" data-office-thread-choice="">
      <strong>
        {unbound
          ? locale === "zh"
            ? "选择办公室会话"
            : "Choose the Office conversation"
          : locale === "zh"
            ? "暂时无法加载会话"
            : "Conversation unavailable"}
      </strong>
      <p>
        {!unbound
          ? locale === "zh"
            ? "请重试以读取办公室会话。"
            : "Retry to load the Office conversation."
          : candidate
            ? locale === "zh"
              ? `找到已有会话“${candidate.title ?? "未命名"}”。确认后可继续使用其中的历史。`
              : `Found “${candidate.title ?? "Untitled"}”. Choose it to continue its history.`
            : locale === "zh"
              ? "暂时无法确定已有会话。可以稍后重试，或为这个办公室创建独立会话。"
              : "The existing conversation could not be determined. Try again later, or create a separate conversation for this Office."}
      </p>
      {candidate ? (
        <button
          className="office-back"
          disabled={busy}
          type="button"
          onClick={onClaim}
        >
          {locale === "zh" ? "继续已有会话" : "Use existing conversation"}
        </button>
      ) : null}
      <button
        className="office-back"
        disabled={busy}
        type="button"
        onClick={onRetry}
      >
        {locale === "zh" ? "重新查找" : "Retry lookup"}
      </button>
      {unbound ? (
        <button
          className="office-back"
          disabled={busy}
          type="button"
          onClick={onCreate}
        >
          {locale === "zh" ? "新建独立会话" : "Create separate conversation"}
        </button>
      ) : null}
    </div>
  );
}
