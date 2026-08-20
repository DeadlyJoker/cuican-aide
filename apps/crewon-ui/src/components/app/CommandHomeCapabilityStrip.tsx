import { BookOpen, ListChecks, Plug, ShieldCheck, Target } from "lucide-react";

import type { Locale } from "../../lib/i18n";
import type { CommandScene, ScenePreset } from "../../lib/scene/sceneCatalog";
import type { CommandExecutionIntent } from "../../lib/thread/threadRuntimeSettings";
import { classNames } from "./commandWorkspaceUtils";

export type CommandHomeResource = Readonly<{
  id: string;
  kind: "knowledge" | "mcp" | "skill" | "tool";
  label: string;
  title: string;
}>;

export function commandSceneMayWrite(
  scene: CommandScene,
  mode: string,
): boolean {
  return (
    mode === "coordinate" ||
    mode === "implement" ||
    mode === "produce" ||
    mode === "refine" ||
    (scene === "code" && mode !== "ask" && mode !== "plan" && mode !== "auto")
  );
}

function resourceIcon(kind: CommandHomeResource["kind"]) {
  return kind === "knowledge" ? (
    <BookOpen aria-hidden="true" />
  ) : (
    <Plug aria-hidden="true" />
  );
}

export function CommandHomeCapabilityStrip({
  intent,
  locale,
  mode,
  preset,
  resources,
  risky,
  onIntentChange,
  onResourceSelect,
}: {
  intent: CommandExecutionIntent;
  locale: Locale;
  mode: string;
  preset: ScenePreset;
  resources: readonly CommandHomeResource[];
  risky: boolean;
  onIntentChange: (intent: Exclude<CommandExecutionIntent, "none">) => void;
  onResourceSelect: (resource: CommandHomeResource) => void;
}) {
  const copy =
    locale === "zh"
      ? {
          capabilities: "推荐能力",
          context: "核心上下文",
          deliverable: "默认交付",
          goal: "目标",
          mode: "任务方式",
          plan: "计划",
          risk: "外部写入保持草稿，提交前需要确认",
          safe: "只使用已授权能力，执行状态会持续回传",
        }
      : {
          capabilities: "Recommended",
          context: "Core context",
          deliverable: "Default output",
          goal: "Goal",
          mode: "Task mode",
          plan: "Plan",
          risk: "External writes remain drafts until confirmed",
          safe: "Only authorized capabilities are used; run state stays visible",
        };

  return (
    <section className="command-home-capability-strip">
      <div className="command-home-summary">
        <span>
          <small>{copy.mode}</small>
          <strong>
            {preset.modes.find((option) => option.value === mode)?.label ??
              preset.modes[0]?.label}
          </strong>
        </span>
        <span>
          <small>{copy.context}</small>
          <strong>{preset.contextSummary}</strong>
        </span>
        <span>
          <small>{copy.deliverable}</small>
          <strong>{preset.deliverableSummary}</strong>
        </span>
      </div>
      <p className="command-home-recommendation">
        <strong>{copy.capabilities}</strong>
        {preset.capabilitySummary}
      </p>
      <div
        aria-label={locale === "zh" ? "任务意图" : "Task intent"}
        className="execution-intent-switch"
        role="group"
      >
        <button
          aria-pressed={intent === "goal"}
          className={classNames(intent === "goal" && "is-selected")}
          type="button"
          onClick={() => onIntentChange("goal")}
        >
          <Target aria-hidden="true" />
          {copy.goal}
        </button>
        <button
          aria-pressed={intent === "plan"}
          className={classNames(intent === "plan" && "is-selected")}
          type="button"
          onClick={() => onIntentChange("plan")}
        >
          <ListChecks aria-hidden="true" />
          {copy.plan}
        </button>
      </div>
      {resources.length > 0 ? (
        <div
          aria-label={locale === "zh" ? "当前可用资源" : "Available resources"}
          className="command-home-resource-dock"
        >
          {resources.slice(0, 4).map((resource) => (
            <button
              data-resource-kind={resource.kind}
              key={resource.id}
              title={`${resource.label} · ${resource.title}`}
              type="button"
              onClick={() => onResourceSelect(resource)}
            >
              {resourceIcon(resource.kind)}
              <span>{resource.title}</span>
              <small>{resource.label}</small>
            </button>
          ))}
        </div>
      ) : null}
      <p className={classNames("command-home-risk", risky && "is-risky")}>
        <ShieldCheck aria-hidden="true" />
        {risky ? copy.risk : copy.safe}
      </p>
    </section>
  );
}
