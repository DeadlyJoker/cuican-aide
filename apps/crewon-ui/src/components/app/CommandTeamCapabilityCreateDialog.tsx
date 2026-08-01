import { X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import type {
  ExpertAgentType,
  ExpertRole,
} from "../../lib/experts/expertTeamRecord";

export type CommandTeamCapabilityKind = "experts" | "workflow";

export type CommandTeamCapabilityCreateInput =
  | {
      kind: "workflow";
      goal: string;
      lead: string;
      title: string;
    }
  | {
      kind: "experts";
      goal: string;
      leader: ExpertRole;
      experts: [ExpertRole, ExpertRole];
      title: string;
    };

type ExpertDraft = {
  agentType: ExpertAgentType;
  name: string;
  role: string;
};

const EMPTY_EXPERT: ExpertDraft = {
  agentType: "explorer",
  name: "",
  role: "",
};

export function CommandTeamCapabilityCreateDialog({
  kind,
  busy = false,
  error = null,
  workspaceCwd,
  onClose,
  onSubmit,
}: {
  kind: CommandTeamCapabilityKind;
  busy?: boolean;
  error?: string | null;
  workspaceCwd: string;
  onClose: () => void;
  onSubmit: (input: CommandTeamCapabilityCreateInput) => void;
}) {
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [lead, setLead] = useState("");
  const [leaderRole, setLeaderRole] = useState("");
  const [formError, setFormError] = useState("");
  const [experts, setExperts] = useState<[ExpertDraft, ExpertDraft]>([
    EMPTY_EXPERT,
    { ...EMPTY_EXPERT, agentType: "worker" },
  ]);
  const workflow = kind === "workflow";

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) {
      return;
    }
    setFormError("");
    const normalizedGoal = goal.trim();
    const normalizedLead = lead.trim();
    const normalizedTitle = title.trim();
    if (!normalizedGoal || !normalizedLead || !normalizedTitle) {
      setFormError("请完整填写名称、目标和负责人信息。");
      return;
    }
    if (workflow) {
      onSubmit({
        kind: "workflow",
        goal: normalizedGoal,
        lead: normalizedLead,
        title: normalizedTitle,
      });
      return;
    }

    const normalizedLeaderRole = leaderRole.trim();
    const normalizedExperts = experts.map((expert) => ({
      agentType: expert.agentType,
      name: expert.name.trim(),
      role: expert.role.trim(),
    })) as [ExpertRole, ExpertRole];
    if (
      !normalizedLeaderRole ||
      normalizedExperts.some((expert) => !expert.name || !expert.role)
    ) {
      setFormError("请完整填写团长职责和两名后台专家。");
      return;
    }
    const roleNames = [
      normalizedLead,
      ...normalizedExperts.map((expert) => expert.name),
    ];
    if (
      new Set(roleNames.map((name) => name.toLocaleLowerCase())).size !==
      roleNames.length
    ) {
      setFormError("团长和后台专家需要使用不同名称。");
      return;
    }
    onSubmit({
      kind: "experts",
      experts: normalizedExperts,
      goal: normalizedGoal,
      leader: {
        agentType: "worker",
        name: normalizedLead,
        role: normalizedLeaderRole,
      },
      title: normalizedTitle,
    });
  }

  function updateExpert(index: 0 | 1, patch: Partial<ExpertDraft>) {
    setExperts((current) => {
      const next: [ExpertDraft, ExpertDraft] = [
        { ...current[0] },
        { ...current[1] },
      ];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  }

  return (
    <div className="modal-backdrop open" role="dialog" aria-modal="true">
      <form
        className="office-modal-card team-capability-create-card"
        onSubmit={submit}
      >
        <header className="arrangement-modal-header">
          <div>
            <span className="modal-kicker">
              {workflow ? "协作流创建" : "专家团创建"}
            </span>
            <h2>{workflow ? "创建协作流" : "创建专家团"}</h2>
          </div>
          <button
            className="icon-action compact"
            type="button"
            aria-label="关闭"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <label className="form-field">
          <span>{workflow ? "协作流名称" : "专家团名称"}</span>
          <input
            ref={titleRef}
            required
            maxLength={120}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        {workflow ? (
          <label className="form-field">
            <span>组长与首个节点负责人</span>
            <input
              required
              maxLength={120}
              placeholder="例如：交付组长智能体"
              value={lead}
              onChange={(event) => setLead(event.target.value)}
            />
          </label>
        ) : null}
        <label className="form-field">
          <span>目标与交付边界</span>
          <textarea
            required
            maxLength={2_000}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
          />
        </label>
        {!workflow ? (
          <>
            <section
              className="team-capability-scope-preview"
              aria-labelledby="expert-leader-title"
            >
              <strong id="expert-leader-title">团长 · 用户唯一对话入口</strong>
              <div className="modal-form-grid">
                <label className="form-field">
                  <span>团长名称</span>
                  <input
                    required
                    maxLength={120}
                    placeholder="例如：代码审查组长"
                    value={lead}
                    onChange={(event) => setLead(event.target.value)}
                  />
                </label>
                <label className="form-field">
                  <span>团长职责</span>
                  <input
                    required
                    maxLength={160}
                    placeholder="例如：澄清目标、分派与汇总"
                    value={leaderRole}
                    onChange={(event) => setLeaderRole(event.target.value)}
                  />
                </label>
              </div>
              <em>
                用户只和团长保持一个连续会话，后台专家不会直接插入消息。
              </em>
            </section>
            {experts.map((expert, index) => {
              const expertIndex = index as 0 | 1;
              return (
                <section
                  className="team-capability-scope-preview"
                  aria-labelledby={`expert-member-${index}-title`}
                  key={index}
                >
                  <strong id={`expert-member-${index}-title`}>后台专家 {index + 1}</strong>
                  <div className="modal-form-grid">
                    <label className="form-field">
                      <span>专家名称</span>
                      <input
                        required
                        maxLength={120}
                        placeholder={
                          index === 0
                            ? "例如：仓库探索专家"
                            : "例如：实现交付专家"
                        }
                        value={expert.name}
                        onChange={(event) =>
                          updateExpert(expertIndex, { name: event.target.value })
                        }
                      />
                    </label>
                    <label className="form-field">
                      <span>专家职责</span>
                      <input
                        required
                        maxLength={160}
                        placeholder={
                          index === 0
                            ? "例如：定位代码与风险"
                            : "例如：实现与验证"
                        }
                        value={expert.role}
                        onChange={(event) =>
                          updateExpert(expertIndex, { role: event.target.value })
                        }
                      />
                    </label>
                    <label className="form-field">
                      <span>协作类型</span>
                      <select
                        value={expert.agentType}
                        onChange={(event) =>
                          updateExpert(expertIndex, {
                            agentType: event.target.value as ExpertAgentType,
                          })
                        }
                      >
                        <option value="explorer">Explorer · 探索与调研</option>
                        <option value="worker">Worker · 实现与交付</option>
                      </select>
                    </label>
                  </div>
                </section>
              );
            })}
          </>
        ) : null}
        <div className="team-capability-scope-preview">
          <strong>{workflow ? "云端执行边界" : "团长单聊工作空间"}</strong>
          <span title={workflow ? undefined : workspaceCwd}>
            {workflow ? "Agent Platform 云端" : workspaceCwd || "无工作空间"}
          </span>
          <em>
            {workflow
              ? "创建真实 Workflow 定义，不上传本机路径或工作空间内容"
              : "后台专家不直接进入用户会话"}
          </em>
        </div>
        {formError || error ? (
          <p className="team-office-create-error" role="alert">
            {formError || error}
          </p>
        ) : null}
        <footer className="arrangement-modal-actions">
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button className="button primary" disabled={busy} type="submit">
            {busy
              ? "创建中…"
              : workflow
                ? "创建协作流"
                : "创建并进入团长单聊"}
          </button>
        </footer>
      </form>
    </div>
  );
}
