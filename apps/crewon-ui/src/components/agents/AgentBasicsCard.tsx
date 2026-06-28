import type {
  AgentConfig,
  LibraryAccent,
} from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";

const AGENT_ACCENTS: LibraryAccent[] = [
  "blue",
  "cyan",
  "green",
  "amber",
  "violet",
  "rose",
  "slate",
];

export function AgentBasicsCard({
  config,
  locale,
  onUpdate,
}: {
  config: AgentConfig;
  locale: Locale;
  onUpdate: (patch: Partial<AgentConfig>) => void;
}) {
  return (
    <section className="agent-config-card">
      <div className="agent-config-card-head">
        <strong>{locale === "zh" ? "基础配置" : "Basics"}</strong>
      </div>
      <label className="agent-field">
        <span>{locale === "zh" ? "智能体名称" : "Agent name"}</span>
        <input
          value={config.name}
          maxLength={64}
          spellCheck={false}
          placeholder={locale === "zh" ? "输入智能体名称" : "Name this agent"}
          onChange={(event) => onUpdate({ name: event.target.value })}
        />
      </label>
      <label className="agent-field">
        <span>{locale === "zh" ? "职责" : "Role"}</span>
        <input
          value={config.role}
          maxLength={120}
          spellCheck={false}
          placeholder={
            locale === "zh"
              ? "例如：研究分析、代码审查、测试执行"
              : "For example: research, review, test execution"
          }
          onChange={(event) => onUpdate({ role: event.target.value })}
        />
      </label>
      <div className="agent-field-row">
        <label className="agent-field">
          <span>{locale === "zh" ? "头像符号" : "Glyph"}</span>
          <input
            value={config.glyph}
            maxLength={2}
            spellCheck={false}
            onChange={(event) => onUpdate({ glyph: event.target.value })}
          />
        </label>
        <label className="agent-field">
          <span>{locale === "zh" ? "强调色" : "Accent"}</span>
          <select
            value={config.accent}
            onChange={(event) =>
              onUpdate({ accent: event.target.value as LibraryAccent })
            }
          >
            {AGENT_ACCENTS.map((accent) => (
              <option key={accent} value={accent}>
                {accent}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="agent-field">
        <span>{locale === "zh" ? "模型" : "Model"}</span>
        <select
          value={config.model}
          onChange={(event) => onUpdate({ model: event.target.value })}
        >
          {config.models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </label>
      <label className="agent-field">
        <span>{locale === "zh" ? "权限档案" : "Permission profile"}</span>
        <select
          value={config.permission}
          onChange={(event) => onUpdate({ permission: event.target.value })}
        >
          {config.permissions.map((permission) => (
            <option key={permission} value={permission}>
              {permission}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}
