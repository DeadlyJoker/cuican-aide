import { ChevronDown, Clock3, Layers3 } from "lucide-react";
import type { DramaProjectPreview } from "./short-drama-preview-data";

/** The confirmed brief and its revision controls remain parent-owned demo data. */
export function ShortDramaCreativeBrief({
  project,
  draft,
  currentBrief,
  onDraftChange,
  onSave,
  onOpenHistory,
}: {
  project: DramaProjectPreview;
  draft: string;
  currentBrief: string;
  onDraftChange(value: string): void;
  onSave(): void;
  onOpenHistory(): void;
}) {
  return (
    <section className="brief-panel">
      <div className="panel-heading">
        <h2>
          <Layers3 size={17} />
          创作需求
        </h2>
        <button className="text-button" onClick={() => onOpenHistory()}>
          v{project.briefs.length}
          <ChevronDown size={13} />
        </button>
      </div>
      <div className="brief-tags">
        <span>{project.genre}</span>
        <span>温暖 · 克制</span>
        <span>写实电影感</span>
      </div>
      <label className="visually-hidden" htmlFor="creative-brief">
        创作需求
      </label>
      <textarea
        id="creative-brief"
        className="description-input"
        value={draft}
        disabled={project.archived}
        maxLength={8192}
        onChange={(event) => onDraftChange(event.target.value)}
      />
      <div className="brief-footer">
        <span>
          <Clock3 size={13} />
          {project.updated}
        </span>
        <button
          className="button secondary"
          disabled={
            project.archived || !draft.trim() || draft.trim() === currentBrief
          }
          onClick={onSave}
        >
          保存为新版本
        </button>
      </div>
      <div className="brief-help">
        需求改变会保存新版本，原概念图与生成记录继续保留。
      </div>
    </section>
  );
}
