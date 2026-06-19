import type { AgentConfig } from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";

export function AgentPromptCard({
  config,
  locale,
  onUpdate,
}: {
  config: AgentConfig;
  locale: Locale;
  onUpdate: (patch: Partial<AgentConfig>) => void;
}) {
  return (
    <section className="agent-config-card agent-config-prompt">
      <div className="agent-config-card-head">
        <strong>{locale === "zh" ? "系统提示词" : "System prompt"}</strong>
        <span>
          {locale === "zh"
            ? "定义这个智能体的身份、风格和边界"
            : "Defines this agent's identity, style, and boundaries"}
        </span>
      </div>
      <textarea
        value={config.systemPrompt}
        spellCheck={false}
        placeholder={
          locale === "zh"
            ? "例如：你是一名严谨的代码审查者…"
            : "e.g. You are a rigorous code reviewer…"
        }
        onChange={(event) => onUpdate({ systemPrompt: event.target.value })}
      />
    </section>
  );
}
