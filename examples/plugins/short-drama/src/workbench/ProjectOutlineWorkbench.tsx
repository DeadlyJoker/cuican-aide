import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  ProjectOutlineItem,
  ProjectOutlineSection,
} from "../project-outlines-service";
import type { ProjectOutlineController } from "./ProjectOutlineController";

const sections = [
  ["episodes", "分集故事"],
  ["characters", "角色"],
  ["scenes", "场景"],
  ["props", "道具"],
  ["beats", "爽点"],
  ["adaptation", "改编依据"],
] as const;
function text(item: ProjectOutlineItem | undefined, field: string): string {
  const value = item?.[field];
  return typeof value === "string" ? value : "";
}
function strings(item: ProjectOutlineItem, field: string): readonly string[] {
  const value = item[field];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
function Paragraph({
  item,
  field,
  label,
}: {
  item: ProjectOutlineItem;
  field: string;
  label?: string;
}) {
  const value = text(item, field);
  return value ? (
    <p className="drama-readable-text">
      {label && <strong>{label}：</strong>}
      {value}
    </p>
  ) : null;
}
function OutputItem({
  item,
  section,
}: {
  item: ProjectOutlineItem;
  section: ProjectOutlineSection;
}) {
  if (section === "episodes")
    return (
      <section>
        <h4>
          第 {String(item.ep)} 集 · {text(item, "title")}
        </h4>
        <Paragraph item={item} field="summary" />
        <Paragraph item={item} field="hook" label="开场" />
        <Paragraph item={item} field="suspense" label="悬念" />
        {(strings(item, "warnings").length > 0 || text(item, "crowdPlan")) && (
          <details>
            <summary>制作注意</summary>
            <Paragraph item={item} field="crowdPlan" label="群演安排" />
            {strings(item, "warnings").map((warning, index) => (
              <p key={index} className="detail-note">
                {warning}
              </p>
            ))}
          </details>
        )}
      </section>
    );
  if (section === "characters")
    return (
      <section>
        <h4>{text(item, "name")}</h4>
        <Paragraph item={item} field="role" />
        <Paragraph item={item} field="arc" label="人物弧光" />
        {strings(item, "from").length > 0 && (
          <p className="detail-note">
            源自：{strings(item, "from").join("、")}
          </p>
        )}
      </section>
    );
  if (section === "scenes")
    return (
      <section>
        <h4>
          {text(item, "name")}
          {item.primary === true ? " · 主场景" : ""}
        </h4>
        <Paragraph item={item} field="reusePlan" label="复用安排" />
      </section>
    );
  if (section === "props")
    return (
      <section>
        <h4>{text(item, "name")}</h4>
        <Paragraph item={item} field="function" />
      </section>
    );
  if (section === "beats")
    return (
      <section>
        <h4>
          {text(item, "type")}
          {item.weight === "major" ? " · 主要爽点" : ""}
        </h4>
        <Paragraph item={item} field="setup" label="铺垫" />
        <Paragraph item={item} field="payoff" label="回收" />
      </section>
    );
  if (section === "risks")
    return (
      <section>
        <h4>{text(item, "what")}</h4>
        <Paragraph item={item} field="plan" />
      </section>
    );
  return (
    <section>
      <h4>{text(item, "what")}</h4>
      <Paragraph item={item} field="why" />
      <Paragraph item={item} field="evidence" label="原文依据" />
    </section>
  );
}
function SectionList({
  controller,
  section,
  label,
}: {
  controller: ProjectOutlineController;
  section: ProjectOutlineSection;
  label?: string;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const items = snapshot.sections.get(section),
    pending = snapshot.pending.has(section);
  useEffect(() => {
    void controller.loadSection(section);
  }, [controller, snapshot.revision?.contentDigest, section]);
  return (
    <>
      {label && <h4>{label}</h4>}
      {items?.map((item, index) => (
        <OutputItem
          key={
            typeof item.episodeId === "string"
              ? item.episodeId
              : typeof item.id === "string"
                ? item.id
                : index
          }
          item={item}
          section={section}
        />
      ))}
      {pending && (
        <p className="detail-note" role="status">
          正在读取…
        </p>
      )}
      {items?.length === 0 && (
        <p className="detail-note">
          此版本尚未填写
          {label ?? sections.find((item) => item[0] === section)?.[1]}。
        </p>
      )}
      {!items && !pending && (
        <button
          className="text-button"
          onClick={() => void controller.loadSection(section)}
        >
          重新读取
        </button>
      )}
      {snapshot.next.get(section) != null && (
        <button
          className="button secondary"
          disabled={pending}
          onClick={() => void controller.loadSection(section, true)}
        >
          继续查看
        </button>
      )}
    </>
  );
}

/** Persisted products first. Detailed adaptation and history stay inside this plugin and open on demand. */
export function ProjectOutlineWorkbench({
  controller,
  projectId,
  fallback,
}: {
  controller: ProjectOutlineController;
  projectId: string;
  fallback: ReactNode;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [section, setSection] =
    useState<(typeof sections)[number][0]>("episodes");
  useEffect(() => {
    controller.setProject(projectId);
    void controller.refresh();
    setSection("episodes");
  }, [controller, projectId]);
  if (snapshot.state === "unsupported") return <>{fallback}</>;
  if (!snapshot.revision || !snapshot.view)
    return (
      <section className="brief-panel story-script-workbench">
        <h2>故事大纲</h2>
        <p className="detail-note" role={snapshot.error ? "alert" : "status"}>
          {snapshot.error ?? "正在读取产物…"}
        </p>
        {snapshot.error && (
          <button
            className="button secondary"
            onClick={() => void controller.refresh()}
          >
            重新读取
          </button>
        )}
      </section>
    );
  const revision = snapshot.revision,
    selected =
      revision.contentRevision ===
      snapshot.view.artifact.selectedContentRevision;
  const overview = snapshot.sections.get("overview")?.[0];
  return (
    <section
      className="brief-panel story-script-workbench"
      aria-label="结构化故事大纲"
    >
      <div className="panel-heading">
        <h2>故事大纲</h2>
        <div className="detail-actions">
          <span className="version-chip">
            {selected ? "已采用" : "候选"} v{revision.contentRevision}
          </span>
          <button
            className="text-button"
            disabled={snapshot.state === "loading"}
            onClick={() => void controller.refresh()}
          >
            刷新产物
          </button>
        </div>
      </div>
      {snapshot.error && (
        <p className="detail-note" role="alert">
          {snapshot.error}
        </p>
      )}
      {selected && snapshot.view.staleReasons.length > 0 && (
        <p className="detail-note" role="status">
          创作来源已有更新，请复核当前产物。
        </p>
      )}
      <article className="drama-output-document" aria-label="产物正文">
        <div className="panel-heading">
          <h3>{revision.title}</h3>
          <span className="detail-note">{revision.counts.episodes} 集</span>
        </div>
        {overview && (
          <>
            <Paragraph item={overview} field="logline" />
            <Paragraph item={overview} field="synopsis" />
          </>
        )}
        <div className="detail-actions" role="tablist" aria-label="大纲产物">
          {sections.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={section === key ? "button" : "button secondary"}
              role="tab"
              aria-selected={section === key}
              tabIndex={section === key ? 0 : -1}
              onKeyDown={(event) => {
                const index = sections.findIndex(([value]) => value === key);
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % sections.length
                    : event.key === "ArrowLeft"
                      ? (index + sections.length - 1) % sections.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? sections.length - 1
                          : null;
                if (next === null) return;
                event.preventDefault();
                setSection(sections[next][0]);
                event.currentTarget.parentElement
                  ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  [next]?.focus();
              }}
              onClick={() => setSection(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          aria-label={sections.find((item) => item[0] === section)?.[1]}
        >
          {section === "adaptation" ? (
            <>
              <Paragraph
                item={snapshot.sections.get("adaptation")?.[0] ?? {}}
                field="core"
                label="改编核心"
              />
              <Adaptation controller={controller} />
            </>
          ) : (
            <SectionList controller={controller} section={section} />
          )}
        </div>
      </article>
      {revision.quality && !revision.quality.passed && (
        <details
          onToggle={(event) => {
            if (event.currentTarget.open)
              void controller.loadSection("problems");
          }}
        >
          <summary>有 {revision.quality.problemCount} 项需要完善</summary>
          {snapshot.sections.get("problems")?.map((item, index) => (
            <p className="detail-note" key={index}>
              {text(item, "message")}
            </p>
          ))}
          {snapshot.next.get("problems") != null && (
            <button
              className="text-button"
              disabled={snapshot.pending.has("problems")}
              onClick={() => void controller.loadSection("problems", true)}
            >
              查看更多问题
            </button>
          )}
        </details>
      )}
      <details
        onToggle={(event) => {
          if (event.currentTarget.open && snapshot.history.length === 0)
            void controller.loadHistory();
        }}
      >
        <summary>查看内容历史</summary>
        <div className="project-side-panels">
          {snapshot.history.map((item) => (
            <div className="version-card" key={item.contentRevision}>
              <strong>
                {item.title} · v{item.contentRevision}
                {item.contentRevision ===
                snapshot.view!.artifact.selectedContentRevision
                  ? " · 已采用"
                  : ""}
              </strong>
              {item.format === "structured-v2" && (
                <button
                  className="text-button"
                  disabled={item.contentRevision === revision.contentRevision}
                  onClick={() => void controller.openRevision(item)}
                >
                  打开内容 v{item.contentRevision}
                </button>
              )}
            </div>
          ))}
          {snapshot.historyLoading && (
            <p className="detail-note" role="status">
              正在读取历史…
            </p>
          )}
          {snapshot.historyNext !== null && (
            <button
              className="text-button"
              disabled={snapshot.historyLoading}
              onClick={() => void controller.loadHistory(true)}
            >
              更多历史
            </button>
          )}
        </div>
      </details>
    </section>
  );
}
function Adaptation({ controller }: { controller: ProjectOutlineController }) {
  useEffect(() => {
    void controller.loadSection("adaptation");
  }, [controller, controller.getSnapshot().revision?.contentDigest]);
  return (
    <>
      {(
        [
          ["keep", "保留"],
          ["cut", "删减"],
          ["merge", "合并"],
          ["risks", "改编风险"],
        ] as const
      ).map(([section, label]) => (
        <SectionList
          key={section}
          controller={controller}
          section={section}
          label={label}
        />
      ))}
    </>
  );
}
