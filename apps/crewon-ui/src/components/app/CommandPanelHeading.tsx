import { Folder } from "lucide-react";
import type { ReactNode } from "react";
import type { Locale } from "../../lib/i18n";
import {
  scenePresets,
  scenePresetsEn,
  type CommandScene,
} from "../../lib/scene/sceneCatalog";
import { CommandThreadSceneSwitcher } from "./CommandSceneHeader";

export function CommandPanelSceneControl({
  locale,
  scene,
  onSceneChange,
}: {
  locale: Locale;
  scene: CommandScene;
  onSceneChange: (scene: CommandScene) => void;
}) {
  return (
    <div className="command-panel-scene-control">
      <CommandThreadSceneSwitcher
        locale={locale}
        scene={scene}
        onSceneChange={onSceneChange}
      />
      <select
        aria-label={
          locale === "zh" ? "当前会话场景" : "Current conversation scene"
        }
        className="command-panel-scene-select"
        value={scene}
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === "office" || value === "code" || value === "design")
            onSceneChange(value);
        }}
      >
        {Object.values(locale === "zh" ? scenePresets : scenePresetsEn).map(
          (preset) => (
            <option key={preset.scene} value={preset.scene}>
              {preset.tabLabel}
            </option>
          ),
        )}
      </select>
    </div>
  );
}

export function CommandPanelHeading({
  title,
  actions,
}: {
  title: string;
  actions?: ReactNode;
}) {
  return (
    <div className="command-panel-heading">
      <Folder aria-hidden="true" />
      <strong title={title}>{title}</strong>
      <div className="command-panel-actions">{actions}</div>
    </div>
  );
}
