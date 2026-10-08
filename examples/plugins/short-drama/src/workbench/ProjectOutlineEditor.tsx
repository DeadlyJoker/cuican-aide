import { useState, useSyncExternalStore } from "react";
import type { PublicProjectFoundation } from "@crewon/plugin-sdk/project-foundation-ui";
import type { ProjectOutlineItem } from "../project-outlines-service";
import type { ProjectDetails } from "./creative-project-controller";
import type { ProjectOutlineEditController } from "./ProjectOutlineEditController";

type EditableSection =
  | "overview"
  | "episodes"
  | "characters"
  | "scenes"
  | "props"
  | "beats";
const fields: Record<EditableSection, readonly (readonly [string, string])[]> =
  {
    overview: [
      ["title", "标题"],
      ["logline", "一句话故事"],
      ["synopsis", "故事梗概"],
    ],
    episodes: [
      ["title", "本集标题"],
      ["summary", "本集故事"],
      ["hook", "开场钩子"],
      ["suspense", "结尾悬念"],
    ],
    characters: [
      ["name", "姓名"],
      ["role", "身份与作用"],
      ["arc", "人物弧光"],
    ],
    scenes: [
      ["name", "场景名称"],
      ["reusePlan", "复用安排"],
    ],
    props: [
      ["name", "道具名称"],
      ["function", "剧情作用"],
    ],
    beats: [
      ["type", "爽点类型"],
      ["setup", "铺垫"],
      ["payoff", "回收"],
    ],
  };
const value = (item: ProjectOutlineItem, key: string) =>
  typeof item[key] === "string" ? (item[key] as string) : "";
export function OutlineItemEditor({
  edits,
  details,
  item,
  section,
  label,
  blocked = false,
}: {
  edits: ProjectOutlineEditController;
  details: ProjectDetails;
  item: ProjectOutlineItem;
  section: EditableSection;
  label: string;
  blocked?: boolean;
}) {
  const snapshot = useSyncExternalStore(
    edits.subscribe,
    edits.getSnapshot,
    edits.getSnapshot,
  );
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState(item);
  if (!open)
    return (
      <button
        type="button"
        className="text-button"
        disabled={blocked || edits.locked}
        onClick={() => {
          setDraft(item);
          setOpen(true);
        }}
      >
        {label}
      </button>
    );
  return (
    <form
      className="drama-output-editor"
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        const change: ProjectOutlineItem =
          section === "overview"
            ? { kind: "overview", value: draft }
            : {
                kind: "upsert",
                collection: section,
                items: [draft],
                removeIds: [],
              };
        void edits
          .save({
            projectId: details.project.projectId,
            briefRevision: details.brief.briefRevision,
            change,
          })
          .then((saved) => {
            if (saved) setOpen(false);
          });
      }}
    >
      {fields[section].map(([key, title]) => (
        <label className="drama-field" key={key}>
          {title}
          <textarea
            aria-label={title}
            rows={key === "summary" || key === "synopsis" ? 5 : 2}
            maxLength={16000}
            value={value(draft, key)}
            disabled={snapshot.pending}
            onChange={(event) =>
              setDraft({ ...draft, [key]: event.target.value })
            }
          />
        </label>
      ))}
      {section === "characters" && (
        <label className="drama-field">
          角色层级
          <select
            aria-label="角色层级"
            disabled={snapshot.pending}
            value={value(draft, "tier")}
            onChange={(event) =>
              setDraft({ ...draft, tier: event.target.value })
            }
          >
            <option value="lead">主角</option>
            <option value="support">配角</option>
            <option value="functional">功能角色</option>
          </select>
        </label>
      )}
      {section === "scenes" && (
        <label>
          <input
            type="checkbox"
            checked={draft.primary === true}
            disabled={snapshot.pending}
            onChange={(event) =>
              setDraft({ ...draft, primary: event.target.checked })
            }
          />{" "}
          主场景
        </label>
      )}
      <div className="detail-actions">
        <button
          className="button"
          type="submit"
          disabled={snapshot.pending || blocked}
        >
          {snapshot.saving ? "正在保存…" : "保存"}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={snapshot.pending}
          onClick={() => setOpen(false)}
        >
          取消
        </button>
      </div>
    </form>
  );
}

export function OutlineStartEditor({
  edits,
  details,
  foundation,
  sourceName,
  blocked,
}: {
  edits: ProjectOutlineEditController;
  details: ProjectDetails;
  foundation: PublicProjectFoundation;
  sourceName: string;
  blocked: boolean;
}) {
  const snapshot = useSyncExternalStore(
    edits.subscribe,
    edits.getSnapshot,
    edits.getSnapshot,
  );
  const [open, setOpen] = useState(false),
    [logline, setLogline] = useState(""),
    [synopsis, setSynopsis] = useState("");
  if (!open)
    return (
      <button
        className="button secondary"
        disabled={blocked || edits.locked}
        onClick={() => setOpen(true)}
      >
        填写分集大纲
      </button>
    );
  const params = foundation.parameters;
  return (
    <form
      className="drama-output-editor"
      aria-label="填写分集大纲"
      onSubmit={(event) => {
        event.preventDefault();
        void edits
          .save({
            projectId: details.project.projectId,
            briefRevision: details.brief.briefRevision,
            change: {
              kind: "initialize",
              document: {
                schemaVersion: "crewon.project-outline-document.v2",
                title: details.project.title,
                logline,
                synopsis,
                source: sourceName,
                lang: "zh",
                params: {
                  episodes: params.episodeCount ?? 1,
                  minutesPerEpisode:
                    (params.episodeDurationSeconds?.minimum ?? 60) / 60,
                  genre: params.genre ?? "",
                  adaptMode:
                    params.adaptation?.strategy === "core"
                      ? "抽核"
                      : params.adaptation?.strategy === "reimagined"
                        ? "借壳"
                        : "忠实",
                },
                adaptation: {
                  core: "",
                  keep: [],
                  cut: [],
                  merge: [],
                  risks: [],
                },
                characters: [],
                scenes: [],
                props: [],
                beats: [],
                episodes: [],
              },
            },
          })
          .then((saved) => {
            if (saved) setOpen(false);
          });
      }}
    >
      <label className="drama-field">
        一句话故事
        <textarea
          aria-label="一句话故事"
          rows={2}
          value={logline}
          disabled={snapshot.pending}
          onChange={(event) => setLogline(event.target.value)}
        />
      </label>
      <label className="drama-field">
        故事梗概
        <textarea
          aria-label="故事梗概"
          rows={5}
          value={synopsis}
          disabled={snapshot.pending}
          onChange={(event) => setSynopsis(event.target.value)}
        />
      </label>
      <div className="detail-actions">
        <button
          className="button"
          type="submit"
          disabled={blocked || snapshot.pending || !synopsis.trim()}
        >
          保存大纲
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={snapshot.pending}
          onClick={() => setOpen(false)}
        >
          取消
        </button>
      </div>
    </form>
  );
}

export function OutlineAddItem({
  edits,
  details,
  section,
  count,
  blocked,
}: {
  edits: ProjectOutlineEditController;
  details: ProjectDetails;
  section: "episodes" | "characters" | "scenes" | "props";
  count: number;
  blocked: boolean;
}) {
  const [identity] = useState(() => crypto.randomUUID());
  const item: ProjectOutlineItem =
    section === "episodes"
      ? {
          episodeId: identity,
          ep: count + 1,
          title: `第 ${count + 1} 集`,
          summary: "",
          hook: "",
          suspense: "",
          sceneIds: [],
          characterIds: [],
          propIds: [],
        }
      : section === "characters"
        ? { id: identity, name: "", role: "", tier: "support", from: [] }
        : section === "scenes"
          ? { id: identity, name: "", primary: false, reusePlan: "" }
          : { id: identity, name: "", function: "" };
  return (
    <OutlineItemEditor
      edits={edits}
      details={details}
      item={item}
      section={section}
      label={
        {
          episodes: "添加一集",
          characters: "添加角色",
          scenes: "添加场景",
          props: "添加道具",
        }[section]
      }
      blocked={blocked}
    />
  );
}
