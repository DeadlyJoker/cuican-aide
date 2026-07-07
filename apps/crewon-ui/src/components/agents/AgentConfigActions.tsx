import type { AgentConfig } from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";

export function AgentConfigActions({
  config,
  locale,
  saved,
  onOpenThread,
  onSave,
}: {
  config: AgentConfig;
  locale: Locale;
  saved: boolean;
  onOpenThread: (threadId: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="agent-config-actions">
      <button type="button" className="agent-config-save" onClick={onSave}>
        {saved
          ? locale === "zh"
            ? "已保存"
            : "Saved"
          : locale === "zh"
            ? "保存配置"
            : "Save config"}
      </button>
      {config.threadId ? (
        <button
          type="button"
          className="agent-config-save"
          onClick={() => onOpenThread(config.threadId as string)}
        >
          {locale === "zh" ? "打开后端线程" : "Open backend thread"}
        </button>
      ) : null}
      <span className="agent-config-hint">
        {locale === "zh"
          ? "保存后，这个智能体被招募进办公室时会带上以上 MCP、Skill 和系统提示词。"
          : "Once saved, recruiting this agent into an office carries the selected MCP, skills, and system prompt."}
      </span>
    </div>
  );
}
