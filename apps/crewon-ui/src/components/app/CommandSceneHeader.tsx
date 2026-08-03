import {
  scenePresets,
  scenePresetsEn,
  type CommandScene,
  type SceneQuickAction,
} from "../../lib/scene/sceneCatalog";
import type { CSSProperties, KeyboardEvent } from "react";
import type { Locale } from "../../lib/i18n";
import { classNames } from "./commandWorkspaceUtils";
import { SceneQuickActionIconGlyph } from "./sceneQuickActionIcons";

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
  const sceneOptions = Object.values(localizedPresets);
  const activeIndex = sceneOptions.findIndex(
    (option) => option.scene === scene,
  );

  /** Arrow keys move between tabs, which a tablist is expected to support. */
  function handleSceneKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const count = sceneOptions.length;
    const next = sceneOptions[(activeIndex + step + count) % count];
    onSceneChange(next.scene);
  }

  return (
    <>
      <header className="home-title" data-od-id="desktop-command-header">
        <h1>
          {locale === "zh" ? "让 CrewON 完成你的工作" : "Put CrewON to work"}
        </h1>
        <p className="scene-subtitle" data-scene-subtitle="">
          {preset.subtitle}
        </p>
      </header>

      <div
        className="scene-tabs scene-pills"
        data-od-id="scene-tabs"
        role="tablist"
        aria-label={locale === "zh" ? "场景" : "Scene"}
        style={
          {
            "--scene-count": sceneOptions.length,
            "--scene-index": activeIndex,
          } as CSSProperties
        }
      >
        {/*
         * A single element slides between the tabs instead of each tab painting
         * its own filled background, so switching reads as one control moving
         * rather than two unrelated states toggling.
         */}
        <span aria-hidden="true" className="scene-pill-thumb" />
        {sceneOptions.map((option) => (
          <button
            aria-selected={scene === option.scene}
            className={classNames(scene === option.scene && "active")}
            data-scene-target={option.scene}
            key={option.scene}
            role="tab"
            tabIndex={scene === option.scene ? 0 : -1}
            title={option.subtitle}
            type="button"
            onClick={() => onSceneChange(option.scene)}
            onKeyDown={handleSceneKeyDown}
          >
            {option.tabLabel}
          </button>
        ))}
      </div>

    </>
  );
}

/**
 * The scene's starter cards, rendered below the composer.
 *
 * They sit after the input rather than above it so the composer stays the first
 * thing under the scene tabs: the cards are a fallback for someone who does not
 * know what to type, not a step on the way to typing.
 */
export function CommandSceneQuickRow({
  locale = "zh",
  scene,
  onQuickAction,
}: {
  locale?: Locale;
  scene: CommandScene;
  onQuickAction: (action: SceneQuickAction) => void;
}) {
  const preset = (locale === "zh" ? scenePresets : scenePresetsEn)[scene];

  return (
    <div className="quick-row" data-od-id="quick-scenarios">
      {preset.quickActions.map((action) => (
        <button
          className="quick-card"
          data-scene={scene}
          key={`${scene}-${action.label}`}
          type="button"
          onClick={() => onQuickAction(action)}
        >
          <span className="quick-card-icon">
            <SceneQuickActionIconGlyph name={action.icon} />
          </span>
          <span className="quick-card-label">{action.label}</span>
          <span className="quick-card-hint">{action.hint}</span>
        </button>
      ))}
    </div>
  );
}
