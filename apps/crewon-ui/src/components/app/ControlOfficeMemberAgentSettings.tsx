import { BookOpen, Check, Plug, Sparkles } from "lucide-react";

import type { AgentCapabilityOption } from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";
import type { OfficeMemberAgentProfile } from "../../lib/office/officeMemberAgentProfile";

type CapabilityGroup = "knowledge" | "mcp" | "skills";

const capabilityMeta: Record<
  CapabilityGroup,
  { icon: typeof Sparkles; zh: string; en: string }
> = {
  skills: { icon: Sparkles, zh: "Skill", en: "Skills" },
  mcp: { icon: Plug, zh: "MCP 服务", en: "MCP services" },
  knowledge: { icon: BookOpen, zh: "知识库", en: "Knowledge" },
};

export function ControlOfficeMemberAgentSettings({
  error,
  loading,
  locale,
  onChange,
  onRetry,
  profile,
}: {
  error: string | null;
  loading: boolean;
  locale: Locale;
  onChange: (profile: OfficeMemberAgentProfile) => void;
  onRetry: () => void;
  profile: OfficeMemberAgentProfile | null;
}) {
  const zh = locale === "zh";

  if (loading && !profile) {
    return (
      <section className="control-office-agent-settings is-loading" aria-busy>
        <span className="control-office-agent-settings-spinner" />
        <div>
          <strong>{zh ? "正在读取成员配置" : "Loading member settings"}</strong>
          <p>{zh ? "马上就好" : "This will only take a moment"}</p>
        </div>
      </section>
    );
  }

  if (!profile) {
    return (
      <section className="control-office-agent-settings is-error" role="alert">
        <div>
          <strong>
            {zh ? "成员配置暂时不可用" : "Member settings unavailable"}
          </strong>
          <p>
            {error ??
              (zh
                ? "请检查连接后再试。"
                : "Check the connection and try again.")}
          </p>
        </div>
        <button type="button" onClick={onRetry}>
          {zh ? "重试" : "Try again"}
        </button>
      </section>
    );
  }

  function updateCapability(group: CapabilityGroup, id: string) {
    if (!profile) return;
    onChange({
      ...profile,
      [group]: profile[group].map((option) =>
        option.id === id ? { ...option, enabled: !option.enabled } : option,
      ),
    });
  }

  return (
    <section className="control-office-agent-settings">
      <div className="control-office-agent-settings-title">
        <strong>{zh ? "工作方式" : "How this member works"}</strong>
        <p>
          {zh
            ? "只影响当前办公室里的这个成员"
            : "Only affects this member in this Office"}
        </p>
      </div>

      <label className="control-office-agent-prompt">
        <span>{zh ? "系统提示词" : "System prompt"}</span>
        <textarea
          maxLength={2_000}
          placeholder={
            zh
              ? "例如：你负责质量验收，优先检查遗漏、风险和证据…"
              : "For example: You own quality review. Prioritize gaps, risks, and evidence…"
          }
          rows={5}
          spellCheck={false}
          value={profile.systemPrompt}
          onChange={(event) =>
            onChange({ ...profile, systemPrompt: event.currentTarget.value })
          }
        />
        <small>
          {zh
            ? "说明它该怎么判断、表达，以及哪些事不要做"
            : "Describe how it should decide, communicate, and where to stop"}
        </small>
      </label>

      <div className="control-office-agent-capabilities">
        {(["skills", "mcp", "knowledge"] as const).map((group) => (
          <CapabilityPicker
            group={group}
            key={group}
            locale={locale}
            options={profile[group]}
            onToggle={(id) => updateCapability(group, id)}
          />
        ))}
      </div>
      {error ? (
        <p className="control-office-agent-inline-error">{error}</p>
      ) : null}
    </section>
  );
}

function CapabilityPicker({
  group,
  locale,
  onToggle,
  options,
}: {
  group: CapabilityGroup;
  locale: Locale;
  onToggle: (id: string) => void;
  options: readonly AgentCapabilityOption[];
}) {
  const zh = locale === "zh";
  const enabled = options.filter((option) => option.enabled).length;
  const meta = capabilityMeta[group];
  const Icon = meta.icon;

  return (
    <details className="control-office-agent-capability">
      <summary>
        <span
          className="control-office-agent-capability-icon"
          aria-hidden="true"
        >
          <Icon />
        </span>
        <strong>{zh ? meta.zh : meta.en}</strong>
        <em>
          {options.length === 0
            ? zh
              ? "暂无"
              : "None"
            : zh
              ? `${enabled} 已选`
              : `${enabled} selected`}
        </em>
      </summary>
      <div className="control-office-agent-capability-list">
        {options.length > 0 ? (
          options.map((option) => (
            <button
              aria-pressed={option.enabled}
              key={option.id}
              title={option.description}
              type="button"
              onClick={() => onToggle(option.id)}
            >
              <span data-accent={option.accent} aria-hidden="true">
                {option.glyph}
              </span>
              <span>
                <strong>{option.name}</strong>
                <small>{option.description}</small>
              </span>
              <i aria-hidden="true">{option.enabled ? <Check /> : null}</i>
            </button>
          ))
        ) : (
          <p>
            {group === "knowledge"
              ? zh
                ? "知识库中还没有可选择的内容"
                : "No knowledge sources are available yet"
              : zh
                ? "当前没有可选择的能力"
                : "No capabilities are available yet"}
          </p>
        )}
      </div>
    </details>
  );
}
