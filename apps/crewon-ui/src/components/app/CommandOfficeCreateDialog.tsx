import { useMemo, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "../shared/ModalDialog";
import type { AgentConfig } from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";
import type { CommandOfficeCreationInput } from "./commandOfficeCreation";

type AgentRecord = { config: AgentConfig; filePath: string };

export function CommandOfficeCreateDialog({
  agents,
  busy,
  error,
  locale,
  onClose,
  onSubmit,
  supportsGoal = true,
  supportsRoleReuse = false,
}: {
  agents: AgentRecord[];
  busy: boolean;
  error: string | null;
  locale: Locale;
  onClose: () => void;
  onSubmit: (input: CommandOfficeCreationInput) => void | Promise<void>;
  supportsGoal?: boolean;
  supportsRoleReuse?: boolean;
}) {
  const zh = locale === "zh";
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [responsibilities, setResponsibilities] = useState<
    Record<string, string>
  >({});
  const [reuseSelectedAgent, setReuseSelectedAgent] = useState(false);
  const [teamRoles, setTeamRoles] = useState(() =>
    zh
      ? ["发布组长", "质量验收", "安全审查", "SRE 运维"]
      : [
          "Release lead",
          "Quality assurance",
          "Security review",
          "SRE operations",
        ],
  );
  const availableAgents = useMemo(
    () => agents.filter((record) => Boolean(record.config.agentId?.trim())),
    [agents],
  );

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
    const selectedMembers = availableAgents.flatMap((record) => {
      const agentId = record.config.agentId?.trim();
      return agentId && selectedAgentIds.includes(agentId)
        ? [
            {
              config: record.config,
              responsibility: responsibilities[agentId] ?? record.config.role,
            },
          ]
        : [];
    });
    const roleMembers =
      supportsRoleReuse && reuseSelectedAgent && selectedMembers.length === 1
        ? teamRoles.flatMap((role) => {
            const displayName = role.trim();
            return displayName
              ? [
                  {
                    config: selectedMembers[0]!.config,
                    displayName,
                    responsibility: displayName,
                  },
                ]
              : [];
          })
        : selectedMembers;
    void onSubmit({
      goal,
      members: roleMembers,
      title,
    });
  }

  const roleReuseActive =
    supportsRoleReuse && reuseSelectedAgent && selectedAgentIds.length === 1;
  return (
    <ModalDialog
      busy={busy}
      closeLabel={zh ? "关闭" : "Close"}
      kicker={zh ? "办公室创建" : "Office builder"}
      onClose={onClose}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        titleInputRef.current?.focus();
      }}
      size="wide"
      title={zh ? "创建办公室" : "Create office"}
    >
      <form
        className="grid gap-3.5"
        data-od-id="team-office-create-modal"
        id="team-office-create-modal"
        onSubmit={submit}
      >
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
                  ? "首位成员担任组长，其余成员分别推进任务，再由组长汇总结论。"
                  : "The first member leads, the others work independently, and the lead synthesizes their findings."}
              </p>
            )}
            {supportsRoleReuse && selectedAgentIds.length === 1 ? (
              <label className="agent-pick-card">
                <input
                  type="checkbox"
                  checked={reuseSelectedAgent}
                  onChange={(event) =>
                    setReuseSelectedAgent(event.target.checked)
                  }
                />
                <span>
                  <b>{zh ? "组建多角色团队" : "Build a multi-role team"}</b>
                  <em>
                    {zh
                      ? "复用这个本地 Agent 的运行能力，以四个独立角色和线程执行；第一项是组长。"
                      : "Reuse this local Agent runtime across four independent roles and threads; the first role leads."}
                  </em>
                </span>
              </label>
            ) : null}
            {roleReuseActive ? (
              <div className="form-field">
                <span>
                  {zh ? "团队角色（第一项为组长）" : "Team roles (lead first)"}
                </span>
                <div className="office-role-matrix">
                  {teamRoles.map((role, index) => (
                    <label key={index}>
                      <span>
                        {index === 0
                          ? zh
                            ? "组长"
                            : "Lead"
                          : `${zh ? "成员" : "Member"} ${index}`}
                      </span>
                      <input
                        type="text"
                        required
                        maxLength={120}
                        value={role}
                        onChange={(event) =>
                          setTeamRoles((current) =>
                            current.map((value, roleIndex) =>
                              roleIndex === index ? event.target.value : value,
                            ),
                          )
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>
            ) : selectedAgentIds.length > 0 ? (
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
                    ? "当前没有可用的智能体，暂时无法创建办公室。"
                    : "No agent is available, so the office cannot be created yet."}
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
          <Button
            disabled={busy}
            type="button"
            variant="outline"
            onClick={onClose}
          >
            {zh ? "取消" : "Cancel"}
          </Button>
          <Button
            disabled={
              busy ||
              (!supportsGoal &&
                (availableAgents.length === 0 || selectedAgentIds.length === 0))
            }
            type="submit"
          >
            {busy
              ? zh
                ? "正在创建…"
                : "Creating…"
              : zh
                ? "创建办公室"
                : "Create office"}
          </Button>
        </footer>
      </form>
    </ModalDialog>
  );
}
