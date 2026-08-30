import {
  scenePresets,
  scenePresetsEn,
  type CommandScene,
  type SceneQuickAction,
} from "../../lib/scene/sceneCatalog";
import type { Locale } from "../../lib/i18n";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

      {/*
       * Radix Tabs owns the tablist contract: roving tabindex, arrow-key
       * navigation that moves focus, and aria-selected all come from the
       * primitive instead of hand-rolled handlers.
       */}
      <Tabs
        className="items-center"
        data-od-id="scene-tabs"
        onValueChange={(value) => onSceneChange(value as CommandScene)}
        value={scene}
      >
        <TabsList aria-label={locale === "zh" ? "场景" : "Scene"}>
          {sceneOptions.map((option) => (
            <TabsTrigger
              data-scene-target={option.scene}
              key={option.scene}
              title={option.subtitle}
              value={option.scene}
            >
              {option.tabLabel}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
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
    <div
      className="quick-scenarios grid gap-2.5"
      data-od-id="quick-scenarios"
    >
      {preset.quickActions.map((action) => (
        <button
          className="flex flex-col items-start gap-1.5 rounded-xl border bg-card px-4 py-3.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring"
          data-scene={scene}
          key={`${scene}-${action.label}`}
          type="button"
          onClick={() => onQuickAction(action)}
        >
          <span className="[&_svg]:size-[18px]">
            <SceneQuickActionIconGlyph name={action.icon} />
          </span>
          <span className="text-sm font-medium text-foreground">
            {action.label}
          </span>
          <span className="text-xs text-muted-foreground">{action.hint}</span>
        </button>
      ))}
    </div>
  );
}
