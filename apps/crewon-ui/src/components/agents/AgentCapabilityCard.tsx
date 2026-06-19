import type { AgentCapabilityOption } from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";

type AgentCapabilityGroup = "mcp" | "skills";

function AgentCapabilityList({
  group,
  options,
  onToggleCapability,
}: {
  group: AgentCapabilityGroup;
  options: AgentCapabilityOption[];
  onToggleCapability: (group: AgentCapabilityGroup, id: string) => void;
}) {
  return (
    <div className="agent-cap-list">
      {options.map((option) => (
        <button
          type="button"
          className="agent-cap"
          data-enabled={option.enabled}
          key={option.id}
          onClick={() => onToggleCapability(group, option.id)}
        >
          <span
            className="agent-cap-glyph"
            data-accent={option.accent}
            aria-hidden="true"
          >
            {option.glyph}
          </span>
          <span className="agent-cap-text">
            <strong>{option.name}</strong>
            <span>{option.description}</span>
          </span>
          <span
            className="agent-cap-toggle"
            data-on={option.enabled}
            aria-hidden="true"
          >
            <i />
          </span>
        </button>
      ))}
    </div>
  );
}

export function AgentCapabilityCard({
  group,
  options,
  locale,
  onToggleCapability,
}: {
  group: AgentCapabilityGroup;
  options: AgentCapabilityOption[];
  locale: Locale;
  onToggleCapability: (group: AgentCapabilityGroup, id: string) => void;
}) {
  const enabled = options.filter((option) => option.enabled).length;
  const title =
    group === "mcp"
      ? locale === "zh"
        ? "MCP 连接器"
        : "MCP connectors"
      : locale === "zh"
        ? "Skill"
        : "Skills";

  return (
    <section className="agent-config-card">
      <div className="agent-config-card-head">
        <strong>{title}</strong>
        <span>
          {locale === "zh"
            ? `已启用 ${enabled} / ${options.length}`
            : `${enabled} / ${options.length} enabled`}
        </span>
      </div>
      <AgentCapabilityList
        group={group}
        options={options}
        onToggleCapability={onToggleCapability}
      />
    </section>
  );
}
