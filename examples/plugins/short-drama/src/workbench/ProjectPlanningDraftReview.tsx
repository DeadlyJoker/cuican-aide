import type { ProjectPlanningProposal } from "../project-planning-service";
export function ProjectPlanningDraftReview({
  proposal,
  disabled,
  onReview,
}: {
  proposal: ProjectPlanningProposal;
  disabled: boolean;
  onReview(): void;
}) {
  const labels = { brief: "创作需求", outline: "分集大纲", script: "分集剧本" };
  return (
    <section className="detail-panel" aria-label="Agent 项目建议">
      <div className="panel-heading">
        <h2>{proposal.input.title}</h2>
        <button
          className="button secondary"
          disabled={disabled}
          onClick={onReview}
        >
          查看并创建项目
        </button>
      </div>
      <p className="detail-note">
        {labels[proposal.input.start]} → {labels[proposal.input.target]}
        {proposal.input.episodeCount === null
          ? ""
          : ` · ${proposal.input.episodeCount} 集`}{" "}
        ·
        {proposal.input.adoption === "manual"
          ? "每步确认成果"
          : "上游未变化时自动选用"}
      </p>
      <p className="detail-note">{proposal.input.instruction}</p>
      <p className="detail-note">
        确认项目需求后可关联当前对话或新建项目对话，并确认执行计划。尚未调用生成服务。
      </p>
    </section>
  );
}
