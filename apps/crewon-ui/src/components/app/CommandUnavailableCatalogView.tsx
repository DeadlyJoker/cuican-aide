import { classNames } from "./commandWorkspaceUtils";

export function CommandUnavailableCatalogView({
  active,
  kind,
}: {
  active: boolean;
  kind: "agents" | "knowledge";
}) {
  const agents = kind === "agents";
  return (
    <section
      className={classNames("shell-view shell-page-view", active && "active")}
      data-shell-view={kind}
      hidden={!active}
    >
      <section className="team-office-empty team-capability-live-empty">
        <h2>{agents ? "智能体与能力目录尚未迁移" : "知识目录尚未迁移"}</h2>
        <p>CrewON Control 暂未提供此目录的写入能力。</p>
      </section>
    </section>
  );
}
