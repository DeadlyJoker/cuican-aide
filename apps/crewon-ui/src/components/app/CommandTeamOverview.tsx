import { GitBranch, MessagesSquare, UsersRound } from "lucide-react";

const modes = {
  office: {
    title: "把团队带进同一间办公室",
    description:
      "围绕一个目标持续讨论，办公室可 @ 指定成员，也可交给组长协调。",
    icon: MessagesSquare,
    hint: "共享上下文 · 灵活分工",
  },
  workflow: {
    title: "让每一步协作都有章可循",
    description: "把重复工作编排成流程，按步骤执行，在关键节点由你确认。",
    icon: GitBranch,
    hint: "步骤接力 · 人工确认",
  },
  experts: {
    title: "一个入口，汇集多位专家",
    description: "由团长拆解问题、协调后台专家，再将不同视角整合为一份结论。",
    icon: UsersRound,
    hint: "专家团只由团长对外回复",
  },
};

export function CommandTeamOverview({
  mode,
  offices,
  workflows,
  nodes,
  experts,
}: {
  mode: keyof typeof modes;
  offices: number;
  workflows: number;
  nodes: number;
  experts: number;
}) {
  const { title, description, icon: Icon, hint } = modes[mode];
  const detail =
    mode === "office"
      ? `${offices} 个办公室`
      : mode === "workflow"
        ? `${workflows} 条协作流 · ${nodes} 个节点`
        : `${experts} 个专家团`;

  return (
    <section
      className="catalog-source-bar team-mode-summary"
      aria-label="团队协作说明"
      data-team-mode={mode}
    >
      <div className="team-overview-copy">
        <div className="team-overview-eyebrow">
          <Icon aria-hidden="true" />
          <span>{hint}</span>
        </div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="team-overview-meta">
        <span className="team-mode-summary-detail">{detail}</span>
        <span className="catalog-context-note">团队能力来自左侧智能体页</span>
      </div>
    </section>
  );
}
