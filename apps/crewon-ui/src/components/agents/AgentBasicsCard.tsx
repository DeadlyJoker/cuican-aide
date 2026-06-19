import type { AgentConfig } from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";

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
