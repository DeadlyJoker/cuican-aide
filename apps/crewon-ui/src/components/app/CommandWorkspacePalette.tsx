import { BookOpen, Cloud, FolderOpen, ListChecks, Paperclip, Plug, Sparkles, Target } from "lucide-react";
import type { PaletteItemWithCommand } from "./CommandWorkspaceChrome";

export function Palette({
  id,
  inputId,
  items,
  kind,
  open,
  placeholder,
  query,
  onClose,
  onQueryChange,
  onSelect,
}: {
  id: string;
  inputId: string;
  items: PaletteItemWithCommand[];
  kind: "add" | "context" | "slash";
  open: boolean;
  placeholder: string;
  query: string;
  onClose: () => void;
  onQueryChange: (query: string) => void;
  onSelect: (item: PaletteItemWithCommand) => void;
}) {
  const addGroups =
    kind === "add"
      ? [
          {
            id: "add",
            label: null,
            items: items.filter(
              (item) =>
                item.kind === "intent" ||
                item.kind === "file" ||
                item.kind === "folder",
            ),
          },
          {
            id: "knowledge",
            label: "知识库",
            items: items.filter((item) => item.kind === "knowledge"),
          },
          {
            id: "plugins",
            label: "插件",
            items: items.filter(
              (item) => item.kind === "skill" || item.kind === "mcp",
            ),
          },
        ].filter((group) => group.items.length > 0)
      : [];

  function addItemIcon(item: PaletteItemWithCommand) {
    if (item.action === "toggle-goal") {
      return <Target aria-hidden="true" />;
    }
    if (item.action === "toggle-plan") {
      return <ListChecks aria-hidden="true" />;
    }
    if (item.action === "attach-files") {
      return <Paperclip aria-hidden="true" />;
    }
    if (item.action === "attach-folder") {
      return <FolderOpen aria-hidden="true" />;
    }
    if (item.action === "provider-resources") {
      return <Cloud aria-hidden="true" />;
    }
    if (item.kind === "knowledge") {
      return <BookOpen aria-hidden="true" />;
    }
    if (item.kind === "mcp") {
      return <Plug aria-hidden="true" />;
    }
    return <Sparkles aria-hidden="true" />;
  }

  function renderItem(item: PaletteItemWithCommand) {
    if (kind === "add") {
      const isIntent =
        item.action === "toggle-goal" || item.action === "toggle-plan";
      return (
        <button
          aria-pressed={isIntent ? item.selected : undefined}
          className="add-palette-item"
          data-kind={item.kind}
          data-label={item.title}
          data-selected={item.selected ? "true" : undefined}
          key={`${item.kind}-${item.title}-${item.token ?? ""}`}
          type="button"
          onClick={() => onSelect(item)}
        >
          <span className="add-palette-item-icon">{addItemIcon(item)}</span>
          <span className="add-palette-item-copy">
            <strong>{item.title}</strong>
            <em>{item.detail}</em>
          </span>
        </button>
      );
    }
    return (
      <button
        data-context-item={kind === "context" ? "" : undefined}
        data-kind={item.kind}
        data-label={item.title}
        data-slash-item={kind === "slash" ? "" : undefined}
        key={`${item.kind}-${item.title}-${item.token ?? ""}`}
        type="button"
        onClick={() => onSelect(item)}
      >
        <span>{item.label}</span>
        <strong>{item.title}</strong>
        <em>{item.detail}</em>
      </button>
    );
  }

  return (
    <div
      className={
        kind === "slash"
          ? "slash-palette"
          : kind === "add"
            ? "context-palette add-palette"
            : "context-palette"
      }
      data-context-palette={kind === "context" ? "" : undefined}
      data-od-id={id}
      data-composer-palette=""
      data-slash-palette={kind === "slash" ? "" : undefined}
      hidden={!open}
      id={id}
    >
      <label className="visually-hidden" htmlFor={inputId}>
        {placeholder}
      </label>
      <input
        id={inputId}
        placeholder={placeholder}
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          const action = paletteSearchKeyAction(event.key, Boolean(items[0]));
          if (action === "close") {
            event.preventDefault();
            onClose();
          } else if (action === "selectFirst") {
            event.preventDefault();
            onSelect(items[0]!);
          } else if (action === "blockSubmit") {
            event.preventDefault();
          }
        }}
      />
      <div className={kind === "slash" ? "slash-list" : "context-list"}>
        {kind === "add"
          ? addGroups.map((group) => (
              <section className="add-palette-group" key={group.id}>
                {group.label ? (
                  <div className="add-palette-group-label">{group.label}</div>
                ) : null}
                {group.items.map(renderItem)}
              </section>
            ))
          : items.map(renderItem)}
        {items.length === 0 ? (
          <button disabled type="button">
            <span>空</span>
            <strong>没有匹配结果</strong>
            <em>换一个关键词继续搜索</em>
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function paletteSearchKeyAction(
  key: string,
  hasFirstItem: boolean,
): "close" | "selectFirst" | "blockSubmit" | null {
  if (key === "Escape") return "close";
  if (key === "Enter") return hasFirstItem ? "selectFirst" : "blockSubmit";
  return null;
}
