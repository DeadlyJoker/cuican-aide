import { BookOpen, Check, Cloud, FolderOpen, ListChecks, Paperclip, Plug, Sparkles, Target } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import type { PaletteItemWithCommand } from "./CommandWorkspaceChrome";

/**
 * The palettes open upward above the composer. In short windows (or with the
 * home composer's centered layout) a tall list would overflow past the top of
 * the viewport and become unreachable, so clamp the panel to the space that
 * is actually available above it.
 */
const PALETTE_TOP_GAP = 12;
const PALETTE_MIN_HEIGHT = 180;

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
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) {
      return;
    }
    const clampPanelHeight = () => {
      panel.style.removeProperty("max-height");
      const rect = panel.getBoundingClientRect();
      const overflow = PALETTE_TOP_GAP - rect.top;
      if (overflow > 0) {
        panel.style.maxHeight = `${Math.max(
          PALETTE_MIN_HEIGHT,
          rect.height - overflow,
        )}px`;
      }
    };
    clampPanelHeight();
    window.addEventListener("resize", clampPanelHeight);
    return () => window.removeEventListener("resize", clampPanelHeight);
  }, [open, items, query]);

  const addGroups =
    kind === "add"
      ? [
          {
            id: "intent",
            label: "执行方式",
            items: items.filter((item) => item.kind === "intent"),
          },
          {
            id: "files",
            label: "文件",
            items: items.filter(
              (item) => item.kind === "file" || item.kind === "folder",
            ),
          },
          {
            id: "knowledge",
            label: "知识库",
            items: items.filter((item) => item.kind === "knowledge"),
          },
          {
            id: "skills",
            label: "Skill",
            items: items.filter((item) => item.kind === "skill"),
          },
          {
            id: "mcp",
            label: "MCP",
            items: items.filter((item) => item.kind === "mcp"),
          },
        ].filter((group) => group.items.length > 0)
      : [];

  function addItemIcon(item: PaletteItemWithCommand) {
    if (item.action === "intent-goal") {
      return <Target aria-hidden="true" />;
    }
    if (item.action === "intent-plan") {
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
      return (
        <button
          className="add-palette-item"
          data-active={item.active ? "true" : undefined}
          data-kind={item.kind}
          data-label={item.title}
          key={`${item.kind}-${item.title}-${item.token ?? ""}`}
          type="button"
          onClick={() => onSelect(item)}
        >
          <span className="add-palette-item-icon">{addItemIcon(item)}</span>
          <span className="add-palette-item-copy">
            <strong>{item.title}</strong>
            <em>{item.detail}</em>
          </span>
          {item.active ? (
            <span className="add-palette-item-check">
              <Check aria-hidden="true" />
            </span>
          ) : null}
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
      ref={panelRef}
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
