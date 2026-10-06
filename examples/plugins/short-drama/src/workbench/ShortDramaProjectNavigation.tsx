import { useId } from "react";
import {
  Clapperboard,
  FileText,
  Image,
  Layers3,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
} from "lucide-react";

export type ShortDramaProjectStage = 0 | 1 | 2 | 3;
const sections = [
  {
    title: "项目与概念图",
    description: "需求 · Agent · 画面探索",
    icon: Layers3,
  },
  {
    title: "大纲与剧本",
    description: "故事 · 分集 · 候选版本",
    icon: FileText,
  },
  { title: "角色与场景", description: "角色 · 美术 · 道具", icon: Users },
  { title: "参考与分镜探索", description: "画面描述 · 参考素材", icon: Image },
  { title: "视频与成片", description: "后续开放", icon: Clapperboard },
] as const;

/** Navigation changes only the plugin content; it never overlays the host canvas. */
export function ShortDramaProjectNavigation({
  stage,
  availableCount,
  locked,
  expanded,
  onExpandedChange,
  onSelect,
}: {
  stage: ShortDramaProjectStage;
  availableCount: number;
  locked: boolean;
  expanded: boolean;
  onExpandedChange(value: boolean): void;
  onSelect(value: ShortDramaProjectStage): void;
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
        {sections.map(({ title, description, icon: Icon }, index) => (
          <button
            type="button"
            key={title}
            className={`stage-item ${stage === index ? "active" : index < availableCount ? "" : "later"}`}
            aria-label={title}
            title={title}
            aria-current={stage === index ? "page" : undefined}
            disabled={locked || index >= availableCount}
            onClick={() => {
              if (index < availableCount)
                onSelect(index as ShortDramaProjectStage);
            }}
          >
            <Icon size={18} />
            <span className="drama-navigation-label">
              {title}
              <small>{description}</small>
            </span>
          </button>
        ))}
      </div>
    </nav>
  );
}
