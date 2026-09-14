import { useState } from "react";
import { bundledTaskPacks, type TaskPack } from "@crewon/capability-packs";
import type { Locale } from "../../lib/i18n";
import type { TaskPackDraftHandler } from "../../lib/plugin/prepareTaskPackDraft";
import {
  readTaskPackPreferences,
  saveTaskPackPreferences,
} from "../../lib/plugin/taskPackPreferences";
import { Button } from "../ui/button";
import { TaskPackPrepareForm } from "./TaskPackPrepareForm";
import "./BundledTaskPackSettings.css";

export function BundledTaskPackSettings({
  locale,
  userId,
  onPrepare,
}: {
  locale: Locale;
  userId: number;
  onPrepare?: TaskPackDraftHandler;
}) {
  return (
    <section
      className="bundled-task-packs"
      aria-label={locale === "zh" ? "任务模板" : "Task templates"}
    >
      <header>
        <h2>{locale === "zh" ? "任务模板" : "Task templates"}</h2>
        <p>
          {locale === "zh"
            ? "保存常用偏好，下次准备任务时自动使用。"
            : "Save your preferences for the next task you prepare."}
        </p>
      </header>
      {bundledTaskPacks.list().map((pack) => (
        <TaskPackSettingsCard
          key={`${userId}:${pack.id}@${pack.version}`}
          pack={pack}
          userId={userId}
          locale={locale}
          onPrepare={onPrepare}
        />
      ))}
    </section>
  );
}

function TaskPackSettingsCard({
  pack,
  userId,
  locale,
  onPrepare,
}: {
  pack: TaskPack;
  userId: number;
  locale: Locale;
  onPrepare?: TaskPackDraftHandler;
}) {
  const zh = locale === "zh";
  const [loaded] = useState(() => readTaskPackPreferences(pack, userId));
  const [configuration, setConfiguration] = useState(loaded.configuration);
  const [saved, setSaved] = useState(loaded.configuration);
  const [feedback, setFeedback] = useState(
    loaded.warning
      ? zh
        ? "读取偏好失败，已使用默认值。请重新保存。"
        : "Could not load preferences. Defaults are shown; please save again."
      : "",
  );
  const [open, setOpen] = useState(false);
  const dirty = JSON.stringify(saved) !== JSON.stringify(configuration);
  return (
    <article className="task-pack-card">
      <header>
        <div>
          <h3>{pack.title[locale]}</h3>
        </div>
        <span>{zh ? "内置" : "Built in"}</span>
      </header>
      <p>{pack.description[locale]}</p>
      <div className="task-pack-preferences">
        {pack.settings.map((field) => (
          <label key={field.id}>
            <strong>{field.label[locale]}</strong>
            <select
              value={configuration[field.id]}
              onChange={(event) => {
                setConfiguration({
                  ...configuration,
                  [field.id]: event.target.value,
                });
                setFeedback("");
              }}
            >
              {field.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label[locale]}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="task-pack-actions">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            try {
              const next = saveTaskPackPreferences(pack, userId, configuration);
              setSaved(next);
              setFeedback(
                zh ? "已保存，将用于新草稿。" : "Saved for new drafts.",
              );
            } catch {
              setFeedback(
                zh ? "保存失败，请重试。" : "Could not save. Please try again.",
              );
            }
          }}
        >
          {zh ? "保存偏好" : "Save preferences"}
        </Button>
        <Button
          type="button"
          variant="outline"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open
            ? zh
              ? "收起材料区"
              : "Collapse material"
            : zh
              ? "使用模板"
              : "Use template"}
        </Button>
      </div>
      <p className="task-pack-save-state" role="status">
        {feedback ||
          (dirty
            ? zh
              ? "有未保存的修改。新草稿仍使用之前的偏好。"
              : "Unsaved changes. New drafts still use your previous preferences."
            : zh
              ? "偏好仅保存在当前设备。"
              : "Preferences are saved on this device only.")}
      </p>
      <div hidden={!open}>
        <TaskPackPrepareForm
          pack={pack}
          configuration={saved}
          locale={locale}
          onPrepare={onPrepare}
        />
      </div>
    </article>
  );
}
