import { Search, X } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";

/**
 * Sidebar thread filter field. Styled with utilities so it stays in lockstep
 * with the other sidebar rows (see `sidebarStyles.ts`).
 */
export function SidebarSearchBox({
  clearSearchLabel,
  searchInputRef,
  searchPlaceholder,
  searchShortcutLabel,
  searchTerm,
  onClearSearch,
  onSearchChange,
  onSearchKeyDown,
}: {
  clearSearchLabel: string;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchPlaceholder: string;
  searchShortcutLabel: string;
  searchTerm: string;
  onClearSearch: () => void;
  onSearchChange: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <label className="mx-0 mb-[5px] mt-px flex h-[30px] cursor-text items-center gap-2 rounded-[7px] bg-[var(--n-alpha-06)] px-[10px] text-[var(--n-alpha-60)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease)] focus-within:bg-[var(--n-alpha-10)]">
      <Search size={15} className="shrink-0 opacity-80" />
      <input
        ref={searchInputRef}
        aria-label={searchPlaceholder}
        className="w-full min-w-0 border-0 bg-transparent text-[calc(13px_+_var(--user-ui-font-delta))] text-[var(--text)] outline-none placeholder:text-[var(--n-alpha-30)]"
        placeholder={searchPlaceholder}
        value={searchTerm}
        onKeyDown={onSearchKeyDown}
        onChange={(event) => onSearchChange(event.target.value)}
      />
      {searchTerm ? (
        <button
          className="grid size-[22px] shrink-0 cursor-pointer place-items-center rounded-[var(--radius-sm)] border-0 bg-transparent p-0 text-[var(--n-alpha-45)] transition-colors hover:bg-[var(--n-alpha-10)] hover:text-[var(--n-1000)]"
          type="button"
          aria-label={clearSearchLabel}
          title={clearSearchLabel}
          onClick={onClearSearch}
        >
          <X size={13} />
        </button>
      ) : (
        <kbd
          aria-hidden="true"
          className="grid h-[18px] min-w-7 shrink-0 select-none place-items-center rounded-[var(--radius-sm)] border border-[var(--n-alpha-10)] bg-[var(--n-alpha-08)] px-1 font-sans text-[10px] font-medium text-[var(--n-alpha-30)]"
        >
          {searchShortcutLabel}
        </kbd>
      )}
    </label>
  );
}
