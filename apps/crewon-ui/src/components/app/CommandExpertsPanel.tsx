import { ArrowUpRight, Sparkles } from "lucide-react";

import type {
  ExpertAgentType,
  ExpertTeamRecordReference,
} from "../../lib/experts/expertTeamRecord";
import { CommandTeamEmptyState } from "./CommandTeamEmptyState";

function agentTypeLabel(agentType: ExpertAgentType) {
  return agentType === "explorer" ? "探索专家" : "执行专家";
}

export function CommandExpertsPanel({
  records,
  status = "ready",
  onCreate,
  onRetry,
  onSelect,
}: {
  records: ExpertTeamRecordReference[];
  status?: "loading" | "ready" | "unavailable";
  onCreate?: () => void;
  onRetry?: () => void;
  onSelect: (record: ExpertTeamRecordReference) => void;
}) {
  if (records.length === 0) {
    const loading = status === "loading";
    const unavailable = status === "unavailable";
    return (
      <CommandTeamEmptyState
        action={
          unavailable && onRetry
            ? { label: "重新同步", onClick: onRetry }
            : status === "ready" && onCreate
              ? { label: "创建专家团", onClick: onCreate, primary: true }
              : null
        }
        description={
          loading
            ? "正在读取当前工作空间中的专家团。"
            : unavailable
              ? "暂时无法读取专家团，稍后可以重新同步。"
              : "创建后由团长承接你的消息，其他专家在后台协作。"
        }
        eyebrow="专家团"
        icon={Sparkles}
        state={loading ? "loading" : unavailable ? "unavailable" : "empty"}
        statusLabel={
          loading ? "正在加载" : unavailable ? "连接暂时中断" : undefined
        }
        title={
          loading
            ? "正在读取专家团"
            : unavailable
              ? "暂时无法打开专家团"
              : "还没有专家团"
        }
      />
    );
  }

  return (
    <section className="expert-team-grid" aria-label="专家团">
      {records.map((record) => {
        const { config } = record;
        return (
          <article className="expert-team-card" key={record.filePath}>
            <div className="expert-team-card-head">
              <span className="expert-team-card-glyph" aria-hidden="true">
                {Array.from(config.title.trim())[0] || "专"}
              </span>
              <div className="catalog-card-head">
                <span>团长单聊 · 后台协作</span>
                <strong>{config.title}</strong>
              </div>
            </div>
            <p className="expert-team-goal">{config.goal}</p>
            <div className="expert-member-stack">
              <span className="is-leader" title={config.leader.role}>
                <i aria-hidden="true">团</i>
                <span>
                  <b>团长：{config.leader.name}</b>
                  <small>{config.leader.role}</small>
                </span>
              </span>
              {config.experts.map((expert, index) => (
                <span
                  key={`${expert.name}-${expert.role}-${expert.agentType}-${index}`}
                  title={expert.role}
                >
                  <i aria-hidden="true">
                    {expert.agentType === "explorer" ? "探" : "执"}
                  </i>
                  <span>
                    <b>
                      {agentTypeLabel(expert.agentType)}：{expert.name}
                    </b>
                    <small>{expert.role}</small>
                  </span>
                </span>
              ))}
            </div>
            <footer className="expert-team-card-foot">
              <span>{config.experts.length + 1} 名成员 · 1 个对话入口</span>
              <button
                className="button primary compact"
                type="button"
                onClick={() => onSelect(record)}
              >
                进入团长单聊
                <ArrowUpRight aria-hidden="true" />
              </button>
            </footer>
          </article>
        );
      })}
    </section>
  );
}
