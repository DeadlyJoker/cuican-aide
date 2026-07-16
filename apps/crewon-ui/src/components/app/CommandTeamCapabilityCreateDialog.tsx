import { X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

export type CommandTeamCapabilityKind = "experts" | "workflow";

export type CommandTeamCapabilityCreateInput = {
  goal: string;
  lead: string;
  title: string;
};

export function CommandTeamCapabilityCreateDialog({
  kind,
  workspaceCwd,
  onClose,
  onSubmit,
}: {
  kind: CommandTeamCapabilityKind;
  workspaceCwd: string;
  onClose: () => void;
  onSubmit: (input: CommandTeamCapabilityCreateInput) => void;
}) {
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [lead, setLead] = useState("");
  const workflow = kind === "workflow";

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = {
      goal: goal.trim(),
      lead: lead.trim(),
      title: title.trim(),
    };
    if (!input.goal || !input.lead || !input.title) {
      return;
    }
    onSubmit(input);
  }

  return (
    <div className="modal-backdrop open" role="dialog" aria-modal="true">
      <form className="office-modal-card team-capability-create-card" onSubmit={submit}>
        <header className="arrangement-modal-header">
          <div>
            <span className="modal-kicker">
              {workflow ? "协作流创建" : "专家团创建"}
            </span>
            <h2>{workflow ? "创建协作流" : "创建专家团"}</h2>
          </div>
          <button className="icon-action compact" type="button" aria-label="关闭" onClick={onClose}>
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
          <span>{workflow ? "组长与首个节点负责人" : "前台团长"}</span>
          <input
            required
            maxLength={120}
            placeholder={workflow ? "例如：交付组长智能体" : "例如：代码审查组长"}
            value={lead}
            onChange={(event) => setLead(event.target.value)}
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
        <div className="team-capability-scope-preview">
          <strong>{workflow ? "群聊运行工作空间" : "团长单聊工作空间"}</strong>
          <span title={workspaceCwd}>{workspaceCwd || "无工作空间"}</span>
          <em>
            {workflow
              ? "节点成员在同一协作流群聊中推进"
              : "后台专家不直接进入用户会话"}
          </em>
        </div>
        <footer className="arrangement-modal-actions">
          <button className="button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" type="submit">
            {workflow ? "创建并进入协作流" : "创建并进入团长单聊"}
          </button>
        </footer>
      </form>
    </div>
  );
}
