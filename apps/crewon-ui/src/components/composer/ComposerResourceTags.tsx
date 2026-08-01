import {
  BookOpen,
  FileText,
  Folder,
  Image,
  Plug,
  Sparkles,
  X,
} from "lucide-react";

export type ComposerResourceKind =
  | "file"
  | "folder"
  | "image"
  | "knowledge"
  | "mcp"
  | "skill";

export type ComposerResourceTag = {
  id: string;
  kind: ComposerResourceKind;
  label: string;
  name: string;
};

const resourceIcons = {
  file: FileText,
  folder: Folder,
  image: Image,
  knowledge: BookOpen,
  mcp: Plug,
  skill: Sparkles,
} satisfies Record<ComposerResourceKind, typeof FileText>;

export function ComposerResourceTags({
  resources,
  onRemove,
}: {
  resources: ComposerResourceTag[];
  onRemove?: (resource: ComposerResourceTag) => void;
}) {
  if (resources.length === 0) {
    return null;
  }

  return (
    <div className="composer-resource-tags" aria-label="已添加资源">
      {resources.map((resource) => {
        const Icon = resourceIcons[resource.kind];
        return (
          <span
            className="composer-resource-tag"
            data-resource-kind={resource.kind}
            key={resource.id}
            title={resource.name}
          >
            <Icon aria-hidden="true" />
            <small>{resource.label}</small>
            <strong>{resource.name}</strong>
            {onRemove ? (
              <button
                aria-label={`移除${resource.label} ${resource.name}`}
                type="button"
                onClick={() => onRemove(resource)}
              >
                <X aria-hidden="true" />
              </button>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
