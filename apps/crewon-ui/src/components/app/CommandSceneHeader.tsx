import {
  scenePresets,
  scenePresetsEn,
  type CommandScene,
  type SceneQuickAction,
} from "../../lib/scene/sceneCatalog";
import type { Locale } from "../../lib/i18n";
import { classNames } from "./commandWorkspaceUtils";

export function CommandSceneHeader({
  locale = "zh",
  scene,
  onQuickAction,
  onSceneChange,
}: {
  locale?: Locale;
  scene: CommandScene;
  onQuickAction: (action: SceneQuickAction) => void;
  onSceneChange: (scene: CommandScene) => void;
}) {
  const localizedPresets = locale === "zh" ? scenePresets : scenePresetsEn;
  const preset = localizedPresets[scene];

  return (
    <>
      <header className="home-title" data-od-id="desktop-command-header">
        <h1>
          {locale === "zh"
            ? "让 CrewON 完成你的工作"
            : "Put CrewON to work"}
        </h1>
        <p className="scene-subtitle" data-scene-subtitle="">
          {preset.subtitle}
        </p>
      </header>

      <div className="scene-tabs scene-pills" data-od-id="scene-tabs">
        {Object.values(localizedPresets).map((option) => (
          <button
            aria-pressed={scene === option.scene}
            className={classNames(scene === option.scene && "active")}
            data-scene-target={option.scene}
            key={option.scene}
            title={option.subtitle}
            type="button"
            onClick={() => onSceneChange(option.scene)}
          >
            {option.tabLabel}
          </button>
        ))}
      </div>

      <div className="capability-summary" data-scene-capabilities="">
        {locale === "zh" ? "推荐能力：" : "Recommended: "}
        {preset.capabilitySummary}
      </div>

      <div className="quick-row" data-od-id="quick-scenarios">
        {preset.quickActions.map((action) => (
          <button
            data-scene={scene}
            key={`${scene}-${action.label}`}
            type="button"
            onClick={() => onQuickAction(action)}
          >
            {action.label}
          </button>
        ))}
      </div>
    </>
  );
}
