import { useId } from "react";
import {
  FileText,
  BookOpen,
  Palette,
  Image,
  Layers3,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
} from "lucide-react";

export type ShortDramaProjectPage =
  | "overview"
  | "source"
  | "outline"
  | "script"
  | "characters"
  | "art"
  | "references";
export const projectPages = [
  {
    id: "overview",
    title: "概览",
    description: "创作需求与画面",
    icon: Layers3,
  },
  {
    id: "outline",
    title: "故事大纲",
    description: "主线 · 人物关系 · 分集",
    icon: BookOpen,
  },
  {
    id: "script",
    title: "分集剧本",
    description: "场次 · 动作 · 对白",
    icon: FileText,
  },
  {
    id: "characters",
    title: "角色",
    description: "设定 · 形象 · 参考图",
    icon: Users,
  },
  {
    id: "art",
    title: "美术",
    description: "场景 · 道具 · 参考图",
    icon: Palette,
  },
  {
    id: "references",
    title: "画面探索",
    description: "画面描述 · 参考素材",
    icon: Image,
  },
] as const;

export function projectPagesFor(origin: "creative" | "novel" | null) {
  if (origin === null) return projectPages;
  const overview = {
    ...projectPages[0],
    title: origin === "novel" ? "改编概览" : "创作方案",
    description: origin === "novel" ? "改编目标 · 方案确认" : "想法 · 制作范围",
  };
  const remaining =
    origin === "novel"
      ? [
          {
            id: "source" as const,
            title: "小说原文",
            description: "章节 · 原文阅读",
            icon: BookOpen,
          },
          { ...projectPages[1], title: "改编大纲" },
          projectPages[3],
          projectPages[4],
          projectPages[2],
          projectPages[5],
        ]
      : projectPages.slice(2);
  return [overview, ...remaining];
}

/** Navigation changes only the plugin content; it never overlays the host canvas. */
export function ShortDramaProjectNavigation({
  page,
  origin = null,
  sourceAvailable = false,
  assetsAvailable,
  referencesAvailable,
  locked,
  expanded,
  onExpandedChange,
  onSelect,
}: {
  page: ShortDramaProjectPage;
  origin?: "creative" | "novel" | null;
  sourceAvailable?: boolean;
  assetsAvailable: boolean;
  referencesAvailable: boolean;
  locked: boolean;
  expanded: boolean;
  onExpandedChange(value: boolean): void;
  onSelect(value: ShortDramaProjectPage): void;
}) {
  const id = useId();
  return (
    <nav className="drama-project-navigation" aria-label="创作阶段">
      <div className="drama-navigation-heading">
        <span>项目制作</span>
        <button
          type="button"
          className="button icon"
          onClick={() => onExpandedChange(!expanded)}
          aria-label={expanded ? "收起项目目录" : "展开项目目录"}
          aria-expanded={expanded}
          aria-controls={id}
        >
          {expanded ? (
            <PanelLeftClose size={17} />
          ) : (
            <PanelLeftOpen size={17} />
          )}
        </button>
      </div>
      <div className="drama-navigation-items" id={id}>
        {projectPagesFor(origin).map(
          ({ id, title, description, icon: Icon }) => {
            const available =
              (id !== "references" || referencesAvailable) &&
              (id !== "source" || sourceAvailable) &&
              (!["characters", "art"].includes(id) || assetsAvailable);
            return (
              <button
                type="button"
                key={id}
                data-project-page={id}
                className={`stage-item ${page === id ? "active" : available ? "" : "later"}`}
                aria-label={title}
                title={title}
                aria-current={page === id ? "page" : undefined}
                disabled={locked || !available}
                onClick={() => {
                  if (available) onSelect(id as ShortDramaProjectPage);
                }}
              >
                <span className="drama-navigation-icon" aria-hidden="true">
                  <Icon size={18} />
                </span>
                <span className="drama-navigation-label">
                  {title}
                  <small>{description}</small>
                </span>
              </button>
            );
          },
        )}
      </div>
    </nav>
  );
}
