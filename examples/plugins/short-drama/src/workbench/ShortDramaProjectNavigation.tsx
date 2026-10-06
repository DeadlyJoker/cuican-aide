import { useId } from "react";
import {
  Clapperboard,
  FileText,
  Palette,
  Image,
  Layers3,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
} from "lucide-react";

export type ShortDramaProjectPage =
  | "overview"
  | "outline"
  | "script"
  | "characters"
  | "art"
  | "references";
export const projectPages = [
  {
    id: "overview",
    title: "项目与概念图",
    description: "需求 · Agent · 画面探索",
    icon: Layers3,
  },
  {
    id: "outline",
    title: "故事大纲",
    description: "主线 · 人物关系 · 分集",
    icon: FileText,
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
    title: "参考与分镜探索",
    description: "画面描述 · 参考素材",
    icon: Image,
  },
  {
    id: "delivery",
    title: "视频与成片",
    description: "后续开放",
    icon: Clapperboard,
  },
] as const;

/** Navigation changes only the plugin content; it never overlays the host canvas. */
export function ShortDramaProjectNavigation({
  page,
  assetsAvailable,
  referencesAvailable,
  locked,
  expanded,
  onExpandedChange,
  onSelect,
}: {
  page: ShortDramaProjectPage;
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
        {projectPages.map(({ id, title, description, icon: Icon }) => {
          const available =
            id !== "delivery" &&
            (id !== "references" || referencesAvailable) &&
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
              <Icon size={18} />
              <span className="drama-navigation-label">
                {title}
                <small>{description}</small>
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
