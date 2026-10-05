import { useState } from "react";
import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import type { Locale } from "../../lib/i18n";
import { useProjectPlanningOrigin } from "./ProjectPlanningScope";
import { transcriptProjectPlanningProposal } from "./projectPlanningProposal";
const zhStages = { brief: "创作需求", outline: "分集大纲", script: "分集剧本" };
export function TranscriptProjectPlanningCard({
  item,
  locale,
}: {
  item: Extract<ThreadItem, { type: "dynamicToolCall" }>;
  locale: Locale;
}) {
  const { navigation, runId } = useProjectPlanningOrigin();
  const [error, setError] = useState(false);
  const proposal = transcriptProjectPlanningProposal(item, {
    threadId: navigation?.threadId ?? null,
    runId,
  });
  if (!proposal || !navigation) return null;
  const available = navigation.canOpen(proposal);
  const input = proposal.input;
  return (
    <section
      className="tool-call-section"
      aria-label={locale === "zh" ? "短剧项目建议" : "Short-drama proposal"}
    >
      <strong>{input.title}</strong>
      <p>
        {locale === "zh"
          ? `${zhStages[input.start]} → ${zhStages[input.target]}${input.episodeCount === null ? "" : ` · ${input.episodeCount} 集`}`
          : `${input.start} → ${input.target}${input.episodeCount === null ? "" : ` · ${input.episodeCount} episodes`}`}
      </p>
      <p>{input.briefText}</p>
      <p>
        {locale === "zh"
          ? "确认后在短剧工作台创建项目；这条建议尚未开始执行。"
          : "Review this draft in the workbench before creating or executing a project."}
      </p>
      <button
        type="button"
        className="button secondary"
        disabled={!available}
        onClick={() => {
          try {
            navigation.open(proposal);
            setError(false);
          } catch {
            setError(true);
          }
        }}
      >
        {locale === "zh"
          ? "在 AI 短剧中使用此想法"
          : "Use this idea in AI Short Drama"}
      </button>
      {(!available || error) && (
        <p role="status">
          {locale === "zh"
            ? "对应插件或当前会话已变化，请重新读取能力后生成建议。"
            : "The plugin or conversation changed. Refresh capabilities and create a new proposal."}
        </p>
      )}
    </section>
  );
}
