import type { AgentConfig } from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";

export function AgentConfigHeader({
  config,
  locale,
  onBack,
}: {
  config: AgentConfig;
  locale: Locale;
  onBack: () => void;
}) {
  return (
    <header className="agent-config-top">
      <button type="button" className="office-back" onClick={onBack}>
        {locale === "zh" ? "返回智能体" : "Back to agents"}
      </button>
      <div className="agent-config-id">
        <span
          className="agent-config-avatar"
          data-accent={config.accent}
          aria-hidden="true"
        >
          {config.glyph}
        </span>
        <div>
          <h1>{config.name}</h1>
          <p>{config.role}</p>
        </div>
      </div>
    </header>
  );
}
