import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "../shared/ModalDialog";
import type {
  ExpertAgentType,
  ExpertRole,
} from "../../lib/experts/expertTeamRecord";

export type CommandTeamCapabilityKind = "experts" | "workflow";

export type WorkflowAgentOption = {
  description: string;
  id: string;
  modelName: string;
  name: string;
  systemPrompt: string;
};

export type WorkflowAgentNodeInput = {
  type: "agent" | "verification";
  agentId: string;
  instruction: string;
  title: string;
} | {
  type: "humanGate";
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
  type: "agent" | "humanGate" | "verification";
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
  type: "agent",
  agentId: "",
  instruction: "",
  title: "",
};

export function CommandTeamCapabilityCreateDialog({
  kind,
  busy = false,
  error = null,
  workflowRequiresVerification = false,
  workflowAgents = [],
  workspaceCwd,
  onClose,
  onSubmit,
}: {
  kind: CommandTeamCapabilityKind;
  busy?: boolean;
  error?: string | null;
  workflowRequiresVerification?: boolean;
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
  const [workflowNodes, setWorkflowNodes] = useState<WorkflowNodeDraft[]>(() => [
    workflowAgents.length > 0
      ? EMPTY_WORKFLOW_NODE
      : { ...EMPTY_WORKFLOW_NODE, type: "humanGate" },
  ]);
  const workflow = kind === "workflow";

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
      const normalizedNodes = workflowNodes.map((node) => {
        if (node.type === "humanGate") {
          return {
            type: "humanGate" as const,
            instruction: node.instruction.trim(),
            title: node.title.trim(),
          };
        }
        const agentId = node.agentId.trim();
        return {
          type: node.type,
          agentId,
          instruction: node.instruction.trim(),
          title: node.title.trim(),
        };
      });
      if (
        normalizedNodes.length === 0 ||
        normalizedNodes.some(
          (node) =>
            !node.title ||
            !node.instruction ||
            (node.type !== "humanGate" &&
              (!node.agentId ||
                !workflowAgents.some((agent) => agent.id === node.agentId))),
        )
      ) {
        setFormError("请至少配置一个完整的 Agent 或 Human Gate 节点。");
        return;
      }
      const verification = normalizedNodes.at(-1);
      if (
        workflowRequiresVerification &&
        (verification?.type !== "verification" ||
          normalizedNodes.some(
            (node, index) =>
              index < normalizedNodes.length - 1 &&
              node.type === "agent" &&
              node.agentId === verification.agentId,
          ))
      ) {
        setFormError("最后一个节点必须由未参与前序产出的独立验证智能体执行。");
        return;
      }
      const firstNode = normalizedNodes[0];
      const leadAgent =
        firstNode?.type !== "humanGate"
          ? workflowAgents.find((agent) => agent.id === firstNode.agentId)
          : null;
      onSubmit({
        kind: "workflow",
        goal: normalizedGoal,
        lead: leadAgent?.name ?? firstNode?.title ?? "Workflow Lead",
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
    <ModalDialog
      busy={busy}
      closeLabel="关闭"
      kicker={workflow ? "协作流创建" : "专家团创建"}
      onClose={onClose}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        titleRef.current?.focus();
      }}
      size="wide"
      title={workflow ? "创建协作流" : "创建专家团"}
    >
      <form
        className="grid gap-3.5 team-capability-create-card"
        onSubmit={submit}
      >
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
                <p>
                  {workflowRequiresVerification
                    ? "Agent 节点自动执行；Human Gate 会持久等待批准或驳回。最后必须由独立 Verification 节点验收输出。"
                    : "Agent 节点自动执行；Human Gate 会持久等待批准或驳回，再决定是否继续。"}
                </p>
              </div>
              <button
                className="button compact"
                type="button"
                onClick={() =>
                  setWorkflowNodes((current) => [
                    ...current,
                    {
                      ...EMPTY_WORKFLOW_NODE,
                      type:
                        workflowAgents.length > 0 ? "agent" : "humanGate",
                    },
                  ])
                }
              >
                <Plus aria-hidden="true" />
                添加节点
              </button>
            </div>
            {workflowAgents.length === 0 ? (
              <p className="team-office-create-error" role="alert">
                当前工作空间还没有本地智能体；仍可配置 Human Gate，Agent 节点需先创建或导入本地智能体。
              </p>
            ) : null}
            <div className="workflow-node-list">
              {workflowNodes.map((node, index) => (
                <article className="workflow-node-editor" key={index}>
                  <header>
                    <span>{index + 1}</span>
                    <strong>
                      {node.type === "humanGate"
                        ? "Human Gate"
                        : node.type === "verification"
                          ? "Verification"
                          : "Agent 节点"}
                    </strong>
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
                      <span>节点类型</span>
                      <select
                        required
                        value={node.type}
                        onChange={(event) => {
                          updateWorkflowNode(index, {
                            type: event.target.value as
                              | "agent"
                              | "humanGate"
                              | "verification",
                            agentId:
                              event.target.value === "humanGate"
                                ? ""
                                : node.agentId,
                          });
                        }}
                      >
                        <option value="agent">Agent · 自动执行</option>
                        <option value="humanGate">Human Gate · 人工确认</option>
                        {workflowRequiresVerification ? (
                          <option value="verification">
                            Verification · 独立验收
                          </option>
                        ) : null}
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
                  {node.type !== "humanGate" ? (
                    <label className="form-field">
                      <span>
                        {node.type === "verification"
                          ? "验证智能体"
                          : "本地智能体"}
                      </span>
                      <select
                        required
                        value={node.agentId}
                        onChange={(event) => {
                          const agent = workflowAgents.find(
                            (candidate) => candidate.id === event.target.value,
                          );
                          updateWorkflowNode(index, {
                            agentId: event.target.value,
                            title: node.title || agent?.name || "",
                          });
                        }}
                      >
                        <option value="">选择智能体</option>
                        {workflowAgents.map((agent) => (
                          <option key={agent.id} value={agent.id}>
                            {agent.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <label className="form-field">
                    <span>
                      {node.type === "humanGate" ? "确认口径" : "本节点任务"}
                    </span>
                    <textarea
                      required
                      maxLength={2_000}
                      placeholder={
                        node.type === "humanGate"
                          ? "说明人工需要确认的内容，以及批准或驳回的判断口径。"
                          : "说明这个节点要完成的任务、输出格式和验收要求。"
                      }
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
          <strong>{workflow ? "本地执行边界" : "团长单聊工作空间"}</strong>
          <span title={workflow ? undefined : workspaceCwd}>
            {workflow
              ? workspaceCwd || "当前工作空间"
              : workspaceCwd || "无工作空间"}
          </span>
          <em>
            {workflow
              ? "定义、节点 Agent 和运行状态由本地 App Server 管理"
              : "后台专家不直接进入用户会话"}
          </em>
        </div>
        {formError || error ? (
          <p className="team-office-create-error" role="alert">
            {formError || error}
          </p>
        ) : null}
        <footer className="arrangement-modal-actions">
          <Button
            disabled={busy}
            type="button"
            variant="outline"
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            disabled={busy || (workflow && workflowAgents.length === 0)}
            type="submit"
          >
            {busy
              ? "创建中…"
              : workflow
                ? "创建协作流"
                : "创建并进入团长单聊"}
          </Button>
        </footer>
      </form>
    </ModalDialog>
  );
}
