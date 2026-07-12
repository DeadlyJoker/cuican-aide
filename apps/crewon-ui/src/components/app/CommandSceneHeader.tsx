import {
  scenePresets,
  type CommandScene,
  type SceneQuickAction,
} from "../../lib/scene/sceneCatalog";
import { classNames } from "./commandWorkspaceUtils";

export function CommandSceneHeader({
  scene,
  onQuickAction,
  onSceneChange,
}: {
  scene: CommandScene;
  onQuickAction: (action: SceneQuickAction) => void;
  onSceneChange: (scene: CommandScene) => void;
}) {
  const preset = scenePresets[scene];

  return (
    <>
      <header className="home-title" data-od-id="desktop-command-header">
        <span className="home-eyebrow">CREWON</span>
        <h1>让 CrewON 完成你的工作</h1>
        <p className="scene-subtitle" data-scene-subtitle="">
          {preset.subtitle}
        </p>
      </header>

      <div className="scene-tabs scene-pills" data-od-id="scene-tabs">
        {Object.values(scenePresets).map((option) => (
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
        推荐能力：{preset.capabilitySummary}
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
