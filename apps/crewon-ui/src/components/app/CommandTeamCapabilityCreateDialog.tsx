import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import type {
  ExpertAgentType,
  ExpertRole,
} from "../../lib/experts/expertTeamRecord";

export type CommandTeamCapabilityKind = "experts" | "workflow";

export type WorkflowAgentOption = {
  apiEnabled: boolean;
  description: string;
  id: number;
  name: string;
};

export type WorkflowAgentNodeInput = {
  agentId: number;
  instruction: string;
  title: string;
};

export type CommandTeamCapabilityCreateInput =
  | {
      kind: "workflow";
      goal: string;
      lead: string;
      nodes: WorkflowAgentNodeInput[];
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

type WorkflowNodeDraft = {
  agentId: string;
  instruction: string;
  title: string;
};

const EMPTY_EXPERT: ExpertDraft = {
  agentType: "explorer",
  name: "",
  role: "",
};

const EMPTY_WORKFLOW_NODE: WorkflowNodeDraft = {
  agentId: "",
  instruction: "",
  title: "",
};

export function CommandTeamCapabilityCreateDialog({
  kind,
  busy = false,
  error = null,
  workflowAgents = [],
  workspaceCwd,
  onClose,
  onSubmit,
}: {
  kind: CommandTeamCapabilityKind;
  busy?: boolean;
  error?: string | null;
  workflowAgents?: WorkflowAgentOption[];
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
  const [workflowNodes, setWorkflowNodes] = useState<WorkflowNodeDraft[]>([
    EMPTY_WORKFLOW_NODE,
  ]);
  const workflow = kind === "workflow";
  const runnableWorkflowAgents = workflowAgents.filter(
    (agent) => agent.apiEnabled,
  );

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
    if (
      !normalizedGoal ||
      (!workflow && !normalizedLead) ||
      !normalizedTitle
    ) {
      setFormError("请完整填写名称、目标和负责人信息。");
      return;
    }
    if (workflow) {
      const normalizedNodes = workflowNodes.map((node) => ({
        agentId: Number(node.agentId),
        instruction: node.instruction.trim(),
        title: node.title.trim(),
      }));
      if (
        normalizedNodes.length === 0 ||
        normalizedNodes.some(
          (node) =>
            !Number.isInteger(node.agentId) ||
            node.agentId <= 0 ||
            !node.title ||
            !node.instruction,
        )
      ) {
        setFormError("请至少配置一个完整的 Agent 节点。");
        return;
      }
      const leadAgent = workflowAgents.find(
        (agent) => agent.id === normalizedNodes[0]?.agentId,
      );
      onSubmit({
        kind: "workflow",
        goal: normalizedGoal,
        lead: leadAgent?.name ?? normalizedNodes[0]?.title ?? "Workflow Lead",
        nodes: normalizedNodes,
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

  function updateWorkflowNode(
    index: number,
    patch: Partial<WorkflowNodeDraft>,
  ) {
    setWorkflowNodes((current) =>
      current.map((node, nodeIndex) =>
        nodeIndex === index ? { ...node, ...patch } : node,
      ),
    );
  }

  function moveWorkflowNode(index: number, direction: -1 | 1) {
    setWorkflowNodes((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) {
        return current;
      }
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
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
        <label className="form-field">
          <span>目标与交付边界</span>
          <textarea
            required
            maxLength={2_000}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
          />
        </label>
        {workflow ? (
          <section
            className="workflow-node-builder"
            aria-labelledby="workflow-node-builder-title"
          >
            <div className="workflow-node-builder-head">
              <div>
                <strong id="workflow-node-builder-title">执行节点</strong>
                <p>节点按当前顺序串行执行，前一个 Agent 的输出会交给下一个。</p>
              </div>
              <button
                className="button compact"
                type="button"
                disabled={runnableWorkflowAgents.length === 0}
                onClick={() =>
                  setWorkflowNodes((current) => [
                    ...current,
                    { ...EMPTY_WORKFLOW_NODE },
                  ])
                }
              >
                <Plus aria-hidden="true" />
                添加节点
              </button>
            </div>
            {runnableWorkflowAgents.length === 0 ? (
              <p className="team-office-create-error" role="alert">
                当前没有已启用 Open API 的云智能体。请先在智能体页启用 Agent API，再创建协作流。
              </p>
            ) : null}
            <div className="workflow-node-list">
              {workflowNodes.map((node, index) => (
                <article className="workflow-node-editor" key={index}>
                  <header>
                    <span>{index + 1}</span>
                    <strong>Agent 节点</strong>
                    <div>
                      <button
                        className="icon-action compact"
                        type="button"
                        aria-label="上移节点"
                        disabled={index === 0}
                        onClick={() => moveWorkflowNode(index, -1)}
                      >
                        <ArrowUp aria-hidden="true" />
                      </button>
                      <button
                        className="icon-action compact"
                        type="button"
                        aria-label="下移节点"
                        disabled={index === workflowNodes.length - 1}
                        onClick={() => moveWorkflowNode(index, 1)}
                      >
                        <ArrowDown aria-hidden="true" />
                      </button>
                      <button
                        className="icon-action compact"
                        type="button"
                        aria-label="删除节点"
                        disabled={workflowNodes.length === 1}
                        onClick={() =>
                          setWorkflowNodes((current) =>
                            current.filter((_, nodeIndex) => nodeIndex !== index),
                          )
                        }
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    </div>
                  </header>
                  <div className="modal-form-grid">
                    <label className="form-field">
                      <span>云智能体</span>
                      <select
                        required
                        value={node.agentId}
                        onChange={(event) => {
                          const agent = workflowAgents.find(
                            (candidate) =>
                              String(candidate.id) === event.target.value,
                          );
                          updateWorkflowNode(index, {
                            agentId: event.target.value,
                            title: node.title || agent?.name || "",
                          });
                        }}
                      >
                        <option value="">选择智能体</option>
                        {workflowAgents.map((agent) => (
                          <option
                            disabled={!agent.apiEnabled}
                            key={agent.id}
                            value={agent.id}
                          >
                            {agent.name}
                            {agent.apiEnabled ? "" : " · API 未启用"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="form-field">
                      <span>节点名称</span>
                      <input
                        required
                        maxLength={120}
                        placeholder="例如：需求审阅"
                        value={node.title}
                        onChange={(event) =>
                          updateWorkflowNode(index, {
                            title: event.target.value,
                          })
                        }
                      />
                    </label>
                  </div>
                  <label className="form-field">
                    <span>本节点任务</span>
                    <textarea
                      required
                      maxLength={2_000}
                      placeholder="说明这个节点要完成的任务、输出格式和验收要求。"
                      value={node.instruction}
                      onChange={(event) =>
                        updateWorkflowNode(index, {
                          instruction: event.target.value,
                        })
                      }
                    />
                  </label>
                </article>
              ))}
            </div>
          </section>
        ) : null}
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
          <button
            className="button primary"
            disabled={busy || (workflow && runnableWorkflowAgents.length === 0)}
            type="submit"
          >
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
