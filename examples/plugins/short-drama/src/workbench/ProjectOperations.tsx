import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Archive, History, MoreHorizontal, X } from "lucide-react";
import { usePluginDialog } from "./usePluginDialog";

/** Secondary project actions stay outside the creative output. */
export function ProjectOperations({
  archived,
  disabled,
  onArchive,
  children,
}: {
  archived: boolean;
  disabled: boolean;
  onArchive(): void;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  usePluginDialog(dialog, recordsOpen);
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        root.current?.querySelector<HTMLButtonElement>("button")?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);
  return (
    <div className="drama-project-operations" ref={root}>
      <button
        type="button"
        className="button icon"
        aria-label="项目操作"
        title="项目操作"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen(!menuOpen)}
      >
        <MoreHorizontal size={18} />
      </button>
      {menuOpen && (
        <div className="drama-project-menu" aria-label="项目操作菜单">
          <button
            type="button"
            onClick={() => {
              root.current?.querySelector<HTMLButtonElement>("button")?.focus();
              setMenuOpen(false);
              setRecordsOpen(true);
            }}
          >
            <History size={16} /> 操作记录
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setMenuOpen(false);
              onArchive();
            }}
          >
            <Archive size={16} /> {archived ? "恢复项目" : "归档项目"}
          </button>
        </div>
      )}
      <div className="drama-dialog-layer" hidden={!recordsOpen}>
        <dialog
          ref={dialog}
          className="modal drama-records-dialog"
          aria-labelledby={titleId}
          onCancel={(event) => {
            event.preventDefault();
            setRecordsOpen(false);
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) setRecordsOpen(false);
          }}
        >
          <div className="modal-header">
            <h2 id={titleId}>操作记录</h2>
            <button
              type="button"
              className="button icon"
              aria-label="关闭操作记录"
              onClick={() => setRecordsOpen(false)}
            >
              <X size={18} />
            </button>
          </div>
          {recordsOpen && <div className="drama-records-body">{children}</div>}
        </dialog>
      </div>
    </div>
  );
}
