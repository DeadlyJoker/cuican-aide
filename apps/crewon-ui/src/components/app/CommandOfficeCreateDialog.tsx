import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import type { AgentConfig } from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";

type AgentRecord = { config: AgentConfig; filePath: string };

export type CommandOfficeCreationInput = {
  goal: string;
  members: Array<{
    config: AgentConfig;
    responsibility: string;
  }>;
  title: string;
};

export function CommandOfficeCreateDialog({
  agents,
  busy,
  error,
  locale,
  onClose,
  onSubmit,
  supportsGoal = true,
}: {
  agents: AgentRecord[];
  busy: boolean;
  error: string | null;
  locale: Locale;
  onClose: () => void;
  onSubmit: (input: CommandOfficeCreationInput) => void | Promise<void>;
  supportsGoal?: boolean;
}) {
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [responsibilities, setResponsibilities] = useState<
    Record<string, string>
  >({});
  const availableAgents = useMemo(
    () => agents.filter((record) => Boolean(record.config.agentId?.trim())),
    [agents],
  );

  useEffect(() => {
    titleInputRef.current?.focus();
  }, []);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) {
        onClose();
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onClose]);

  function toggleAgent(record: AgentRecord) {
    const agentId = record.config.agentId?.trim();
    if (!agentId) {
      return;
    }
    setSelectedAgentIds((current) =>
      current.includes(agentId)
        ? current.filter((value) => value !== agentId)
        : [...current, agentId],
    );
    setResponsibilities((current) =>
      current[agentId]
        ? current
        : { ...current, [agentId]: record.config.role },
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) {
      return;
    }
    void onSubmit({
      goal,
      members: availableAgents.flatMap((record) => {
        const agentId = record.config.agentId?.trim();
        return agentId && selectedAgentIds.includes(agentId)
          ? [
              {
                config: record.config,
                responsibility: responsibilities[agentId] ?? record.config.role,
              },
            ]
          : [];
      }),
      title,
    });
  }

  const zh = locale === "zh";
  return (
    <div
      className="modal-backdrop open"
      id="team-office-create-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="team-office-create-title"
    >
      <form
        className="office-modal-card office-create-card"
        data-od-id="team-office-create-modal"
        onSubmit={submit}
      >
        <header className="arrangement-modal-header">
          <div>
            <span className="modal-kicker">
              {zh ? "办公室创建" : "Office builder"}
            </span>
            <h2 id="team-office-create-title">
              {zh ? "创建办公室" : "Create office"}
            </h2>
          </div>
          <button
            className="icon-action compact"
            type="button"
            aria-label={zh ? "关闭" : "Close"}
            disabled={busy}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="office-create-layout">
          <div className="office-create-main">
            <label className="form-field">
              <span>{zh ? "办公室名称" : "Office name"}</span>
              <input
                ref={titleInputRef}
                type="text"
                required
                maxLength={120}
                placeholder={
                  zh ? "例如：设计交付办公室" : "e.g. Design delivery office"
                }
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            {supportsGoal ? (
              <label className="form-field">
                <span>{zh ? "负责的工作任务" : "Owned work task"}</span>
                <textarea
                  required
                  maxLength={2_000}
                  placeholder={
                    zh
                      ? "说明这个办公室长期负责的目标、边界和交付结果。"
                      : "Describe the durable goal, boundaries, and expected outcomes."
                  }
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                />
                <small className="office-manager-note">
                  {zh
                    ? "创建后自动生成独立的办公室主控（Leader Agent）；所选智能体作为员工加入。"
                    : "A dedicated Office manager (Leader Agent) is created automatically; selected agents join as members."}
                </small>
              </label>
            ) : (
              <p className="office-manager-note">
                {zh
                  ? "Control Office contract 当前只保存名称、成员和执行目标，不支持长期目标字段。"
                  : "The Control Office contract currently stores only the name, members, and execution targets; it has no durable goal field."}
              </p>
            )}
            {selectedAgentIds.length > 0 ? (
              <div className="form-field">
                <span>{zh ? "每个员工负责的内容" : "Responsibilities"}</span>
                <div className="office-role-matrix">
                  {availableAgents.flatMap((record) => {
                    const agentId = record.config.agentId?.trim();
                    return agentId && selectedAgentIds.includes(agentId)
                      ? [
                          <label key={agentId}>
                            <span>{record.config.name}</span>
                            <input
                              type="text"
                              maxLength={240}
                              value={
                                responsibilities[agentId] ?? record.config.role
                              }
                              onChange={(event) =>
                                setResponsibilities((current) => ({
                                  ...current,
                                  [agentId]: event.target.value,
                                }))
                              }
                            />
                          </label>,
                        ]
                      : [];
                  })}
                </div>
              </div>
            ) : null}
          </div>

          <aside
            className="agent-picker-panel"
            aria-label={zh ? "选择智能体" : "Select agents"}
          >
            <strong>{zh ? "从智能体页选择" : "Select from Agents"}</strong>
            {availableAgents.length > 0 ? (
              availableAgents.map((record) => {
                const agentId = record.config.agentId!.trim();
                return (
                  <label className="agent-pick-card" key={record.filePath}>
                    <input
                      type="checkbox"
                      checked={selectedAgentIds.includes(agentId)}
                      onChange={() => toggleAgent(record)}
                    />
                    <span>
                      <b>{record.config.name}</b>
                      <em>{record.config.role}</em>
                    </span>
                  </label>
                );
              })
            ) : (
              <p className="team-office-create-empty">
                {supportsGoal
                  ? zh
                    ? "当前没有可招募的真实智能体。可以先创建办公室，稍后在群聊内招募。"
                    : "No recruitable agents are available. Create the office now and recruit later from the room."
                  : zh
                    ? "当前没有已发布 AgentVersion，Control Office 创建暂不可用。"
                    : "No published AgentVersion is available, so Control Office creation is unavailable."}
              </p>
            )}
          </aside>
        </div>

        {error ? (
          <p className="team-office-create-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="arrangement-modal-actions">
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            {zh ? "取消" : "Cancel"}
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={busy || (!supportsGoal && availableAgents.length === 0)}
          >
            {busy
              ? zh
                ? "正在创建…"
                : "Creating…"
              : zh
                ? "创建办公室"
                : "Create office"}
          </button>
        </footer>
      </form>
    </div>
  );
}
