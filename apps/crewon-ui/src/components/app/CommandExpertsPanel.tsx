import { ArrowUpRight } from "lucide-react";

import type {
  ExpertAgentType,
  ExpertTeamRecordReference,
} from "../../lib/experts/expertTeamRecord";

function agentTypeLabel(agentType: ExpertAgentType) {
  return agentType === "explorer" ? "探索专家" : "执行专家";
}

export function CommandExpertsPanel({
  records,
  onSelect,
}: {
  records: ExpertTeamRecordReference[];
  onSelect: (record: ExpertTeamRecordReference) => void;
}) {
  if (records.length === 0) {
    return (
      <section className="team-office-empty team-capability-live-empty">
        <span className="team-office-empty-kicker">团长单聊 · 后台协作</span>
        <h2>还没有专家团</h2>
        <p>
          创建后由团长承接你的消息，探索与执行专家只在后台向团长汇报。
        </p>
      </section>
    );
  }

  return (
    <section className="expert-team-grid" aria-label="专家团">
      {records.map((record) => {
        const { config } = record;
        return (
          <article className="expert-team-card" key={record.filePath}>
            <div className="catalog-card-head">
              <span>单聊执行目标</span>
              <strong>{config.title}</strong>
            </div>
            <p>{config.goal}</p>
            <div className="expert-member-stack">
              <span title={config.leader.role}>
                团长：{config.leader.name} · {config.leader.role}
              </span>
              {config.experts.map((expert, index) => (
                <span
                  key={`${expert.name}-${expert.role}-${expert.agentType}-${index}`}
                  title={expert.role}
                >
                  {agentTypeLabel(expert.agentType)}：{expert.name} · {expert.role}
                </span>
              ))}
            </div>
            <button
              className="button primary compact"
              type="button"
              onClick={() => onSelect(record)}
            >
              进入团长单聊
              <ArrowUpRight aria-hidden="true" />
            </button>
          </article>
        );
      })}
    </section>
  );
}
