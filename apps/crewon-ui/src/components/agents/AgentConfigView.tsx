import { useState } from "react";

import type { Locale } from "../../lib/i18n";
import type {
  AgentCapabilityOption,
  AgentConfig,
  LibraryPanel,
} from "../../lib/crewonDomain";

type AgentConfigViewProps = {
  panel: LibraryPanel;
  locale: Locale;
  onBack: () => void;
  onUpdate: (patch: Partial<AgentConfig>) => void;
  onToggleCapability: (group: "mcp" | "skills", id: string) => void;
  onSave: () => void | Promise<void>;
  onOpenThread: (threadId: string) => void;
};

export function AgentConfigView({
  panel,
  locale,
  onBack,
  onUpdate,
  onToggleCapability,
  onSave,
  onOpenThread,
}: AgentConfigViewProps) {
  const config = panel.agentConfig;
  const [saved, setSaved] = useState(false);

  if (!config) {
    return null;
  }

  const enabledMcp = config.mcp.filter((option) => option.enabled).length;
  const enabledSkills = config.skills.filter((option) => option.enabled).length;

  function renderCapabilityGroup(
    group: "mcp" | "skills",
    options: AgentCapabilityOption[],
  ) {
    return (
      <div className="agent-cap-list">
        {options.map((option) => (
          <button
            type="button"
            className="agent-cap"
            data-enabled={option.enabled}
            key={option.id}
            onClick={() => {
              setSaved(false);
              onToggleCapability(group, option.id);
            }}
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

  return (
    <main className="agent-config" aria-label={config.name}>
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

      <div className="agent-config-body">
        <section className="agent-config-card">
          <div className="agent-config-card-head">
            <strong>{locale === "zh" ? "基础配置" : "Basics"}</strong>
          </div>
          <label className="agent-field">
            <span>{locale === "zh" ? "模型" : "Model"}</span>
            <select
              value={config.model}
              onChange={(event) => {
                setSaved(false);
                onUpdate({ model: event.target.value });
              }}
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
              onChange={(event) => {
                setSaved(false);
                onUpdate({ permission: event.target.value });
              }}
            >
              {config.permissions.map((permission) => (
                <option key={permission} value={permission}>
                  {permission}
                </option>
              ))}
            </select>
          </label>
        </section>

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
            onChange={(event) => {
              setSaved(false);
              onUpdate({ systemPrompt: event.target.value });
            }}
          />
        </section>

        <section className="agent-config-card">
          <div className="agent-config-card-head">
            <strong>{locale === "zh" ? "MCP 连接器" : "MCP connectors"}</strong>
            <span>
              {locale === "zh"
                ? `已启用 ${enabledMcp} / ${config.mcp.length}`
                : `${enabledMcp} / ${config.mcp.length} enabled`}
            </span>
          </div>
          {renderCapabilityGroup("mcp", config.mcp)}
        </section>

        <section className="agent-config-card">
          <div className="agent-config-card-head">
            <strong>{locale === "zh" ? "Skill" : "Skills"}</strong>
            <span>
              {locale === "zh"
                ? `已启用 ${enabledSkills} / ${config.skills.length}`
                : `${enabledSkills} / ${config.skills.length} enabled`}
            </span>
          </div>
          {renderCapabilityGroup("skills", config.skills)}
        </section>

        <section className="agent-config-card agent-config-history">
          <div className="agent-config-card-head">
            <strong>
              {locale === "zh" ? "后端记录" : "Backend records"}
            </strong>
            <span>
              {config.threadId
                ? locale === "zh"
                  ? "来自智能体线程"
                  : "Loaded from the agent thread"
                : locale === "zh"
                  ? "保存后创建"
                  : "Created after save"}
            </span>
          </div>
          <div className="agent-history-list">
            {panel.items.length > 0 ? (
              panel.items.map((item) =>
                item.section ? (
                  <div
                    className="library-section"
                    key={`${item.title}:${item.meta}`}
                  >
                    <strong>{item.title}</strong>
                    <span>{item.meta}</span>
                    {item.description ? <p>{item.description}</p> : null}
                  </div>
                ) : (
                  <article
                    className="agent-history-item"
                    data-accent={item.accent ?? "slate"}
                    key={`${item.title}:${item.meta}`}
                  >
                    <span aria-hidden="true">{item.glyph ?? "✓"}</span>
                    <div>
                      <strong>{item.title}</strong>
                      <em>{item.meta}</em>
                      {item.description ? <p>{item.description}</p> : null}
                    </div>
                  </article>
                ),
              )
            ) : (
              <article className="agent-history-item" data-accent="slate">
                <span aria-hidden="true">◷</span>
                <div>
                  <strong>
                    {locale === "zh" ? "暂无后端记录" : "No backend records"}
                  </strong>
                  <em>
                    {locale === "zh" ? "等待首次保存" : "Waiting for save"}
                  </em>
                  <p>
                    {locale === "zh"
                      ? "保存配置后会写入 app-server 智能体线程。"
                      : "Saving writes this configuration to an app-server agent thread."}
                  </p>
                </div>
              </article>
            )}
          </div>
        </section>

        <div className="agent-config-actions">
          <button
            type="button"
            className="agent-config-save"
            onClick={() => {
              onSave();
              setSaved(true);
            }}
          >
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
      </div>
    </main>
  );
}
