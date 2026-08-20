import type { Locale } from "../../lib/i18n";
import type { ScenePreset } from "../../lib/scene/sceneCatalog";

export function CommandHomeCapabilityStrip({
  locale,
  mode,
  preset,
}: {
  locale: Locale;
  mode: string;
  preset: ScenePreset;
}) {
  const copy =
    locale === "zh"
      ? {
          capabilities: "推荐能力",
          context: "核心上下文",
          deliverable: "默认交付",
          mode: "任务方式",
        }
      : {
          capabilities: "Recommended",
          context: "Core context",
          deliverable: "Default output",
          mode: "Task mode",
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
    </section>
  );
}
