import type { ProjectFoundationCreationParameters } from "@crewon/plugin-sdk/project-foundation-ui";
import { useState } from "react";
export function defaultCreationParameters(
  origin: "creative" | "novel",
): ProjectFoundationCreationParameters {
  return {
    genre: null,
    episodeMode: origin === "creative" ? "single" : "series",
    episodeCount: origin === "creative" ? 1 : null,
    episodeDurationSeconds:
      origin === "novel" ? { minimum: 120, maximum: 300 } : null,
    aspectRatio: "16:9",
    visualStyle: origin === "novel" ? "semi-realistic" : null,
    needsCharacters: true,
    needsArt: true,
    adaptation:
      origin === "novel"
        ? { strategy: "core", retainedCharacters: [], retainedScenes: [] }
        : null,
  };
}
/** The same persisted parameters are edited at creation and inside the project. */
export function ProjectCreationParametersFields({
  origin,
  value,
  disabled,
  onChange,
}: {
  origin: "creative" | "novel";
  value: ProjectFoundationCreationParameters;
  disabled: boolean;
  onChange(value: ProjectFoundationCreationParameters): void;
}) {
  const change = (patch: Partial<ProjectFoundationCreationParameters>) =>
    onChange({ ...value, ...patch });
  const split = (text: string) =>
    text
      .split(/[,，\r\n]+/u)
      .map((part) => part.trim())
      .filter(Boolean);
  const [characters, setCharacters] = useState(
    value.adaptation?.retainedCharacters.join("\n") ?? "",
  );
  const [scenes, setScenes] = useState(
    value.adaptation?.retainedScenes.join("\n") ?? "",
  );
  return (
    <fieldset className="drama-creation-parameters" disabled={disabled}>
      <legend className="visually-hidden">创作参数</legend>
      <div className="drama-form-columns">
        <label className="form-field">
          作品形式
          <select
            value={value.episodeMode}
            onChange={(event) =>
              change({
                episodeMode: event.target.value as "single" | "series",
                episodeCount: event.target.value === "single" ? 1 : null,
              })
            }
          >
            <option value="single">单集短剧</option>
            <option value="series">系列短剧</option>
          </select>
        </label>
        <label className="form-field">
          {value.episodeMode === "single" ? "集数" : "总集数（可选）"}
          <input
            type="number"
            min={1}
            max={10000}
            disabled={value.episodeMode === "single"}
            value={value.episodeCount ?? ""}
            onChange={(event) =>
              change({
                episodeCount:
                  event.target.value === "" ? null : Number(event.target.value),
              })
            }
            placeholder="稍后与 Agent 确定"
          />
        </label>
        <label className="form-field">
          画面比例
          <select
            value={value.aspectRatio}
            onChange={(event) =>
              change({ aspectRatio: event.target.value as "16:9" | "9:16" })
            }
          >
            <option value="16:9">横屏 · 16:9</option>
            <option value="9:16">竖屏 · 9:16</option>
          </select>
        </label>
        <label className="form-field">
          题材（可选）
          <input
            value={value.genre ?? ""}
            onChange={(event) => change({ genre: event.target.value || null })}
            placeholder="例如：悬疑、都市、奇幻"
          />
        </label>
      </div>
      <div className="drama-checkbox-row">
        <label>
          <input
            type="checkbox"
            checked={value.needsCharacters}
            onChange={(event) =>
              change({ needsCharacters: event.target.checked })
            }
          />
          需要角色
        </label>
        <label>
          <input
            type="checkbox"
            checked={value.needsArt}
            onChange={(event) => change({ needsArt: event.target.checked })}
          />
          需要美术
        </label>
      </div>
      {origin === "novel" && value.adaptation && (
        <>
          <div className="drama-form-columns">
            <label className="form-field">
              改编方式
              <select
                value={value.adaptation.strategy}
                onChange={(event) =>
                  change({
                    adaptation: {
                      ...value.adaptation!,
                      strategy: event.target.value as
                        | "faithful"
                        | "core"
                        | "reimagined",
                    },
                  })
                }
              >
                <option value="faithful">忠实 · 保留原作</option>
                <option value="core">抽核 · 提炼故事核心</option>
                <option value="reimagined">借壳 · 重新创作</option>
              </select>
            </label>
            <label className="form-field">
              画风
              <select
                value={value.visualStyle ?? "semi-realistic"}
                onChange={(event) =>
                  change({
                    visualStyle: event.target.value as
                      | "semi-realistic"
                      | "hand-drawn",
                  })
                }
              >
                <option value="semi-realistic">半写实</option>
                <option value="hand-drawn">手绘动画</option>
              </select>
            </label>
            <label className="form-field">
              单集最短时长（分钟）
              <input
                type="number"
                min={1 / 60}
                max={60}
                step="any"
                value={(value.episodeDurationSeconds?.minimum ?? 120) / 60}
                onChange={(event) =>
                  change({
                    episodeDurationSeconds: {
                      minimum: Math.round(Number(event.target.value) * 60),
                      maximum: value.episodeDurationSeconds?.maximum ?? 300,
                    },
                  })
                }
              />
            </label>
            <label className="form-field">
              单集最长时长（分钟）
              <input
                type="number"
                min={1 / 60}
                max={60}
                step="any"
                value={(value.episodeDurationSeconds?.maximum ?? 300) / 60}
                onChange={(event) =>
                  change({
                    episodeDurationSeconds: {
                      minimum: value.episodeDurationSeconds?.minimum ?? 120,
                      maximum: Math.round(Number(event.target.value) * 60),
                    },
                  })
                }
              />
            </label>
          </div>
          <label className="form-field">
            必留人物（可选）
            <textarea
              className="drama-short-input"
              value={characters}
              onChange={(event) => {
                setCharacters(event.target.value);
                change({
                  adaptation: {
                    ...value.adaptation!,
                    retainedCharacters: split(event.target.value),
                  },
                });
              }}
              placeholder="用逗号或换行分隔"
            />
          </label>
          <label className="form-field">
            必留情节（可选）
            <textarea
              className="drama-short-input"
              value={scenes}
              onChange={(event) => {
                setScenes(event.target.value);
                change({
                  adaptation: {
                    ...value.adaptation!,
                    retainedScenes: split(event.target.value),
                  },
                });
              }}
              placeholder="用逗号或换行分隔"
            />
          </label>
        </>
      )}
    </fieldset>
  );
}
