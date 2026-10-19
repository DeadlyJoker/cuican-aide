import { Clock3 } from "lucide-react";
import {
  briefBytes,
  validBrief,
  type CreativeProjectController,
  type ProjectSnapshot,
  type ProjectDetails,
} from "./creative-project-controller";

/** Foundation and legacy projects share the original CAS/recovery owner. */
export function ProjectBriefRevisionEditor({
  controller,
  snapshot,
  details,
  blocked,
}: {
  controller: CreativeProjectController;
  snapshot: ProjectSnapshot;
  details: ProjectDetails;
  blocked: boolean;
}) {
  const disabled =
    blocked || details.project.state === "archived" || snapshot.opening;
  return (
    <details className="drama-secondary-disclosure">
      <summary>修改创作需求</summary>
      <label className="visually-hidden" htmlFor="creative-brief">
        创作需求
      </label>
      <textarea
        id="creative-brief"
        className="description-input"
        value={snapshot.draft}
        disabled={disabled}
        onChange={(event) => controller.setDraft(event.target.value)}
      />
      <div className="brief-footer">
        <span>
          <Clock3 size={13} />
          {briefBytes(snapshot.draft)} / 8,192 字节
        </span>
        <button
          type="button"
          className="button secondary"
          disabled={
            disabled ||
            !validBrief(snapshot.draft) ||
            snapshot.draft === details.brief.text
          }
          onClick={() => void controller.saveBrief()}
        >
          {snapshot.saving ? "正在保存…" : "保存为新版本"}
        </button>
      </div>
      {briefBytes(snapshot.draft) > 8192 && (
        <p className="detail-note" role="alert">
          需求超过 8,192 字节，请缩短后保存。
        </p>
      )}
    </details>
  );
}
