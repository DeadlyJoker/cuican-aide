import { Search, X } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";

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
    <label className="search-box">
      <Search size={15} />
      <input
        ref={searchInputRef}
        aria-label={searchPlaceholder}
        placeholder={searchPlaceholder}
        value={searchTerm}
        onKeyDown={onSearchKeyDown}
        onChange={(event) => onSearchChange(event.target.value)}
      />
      {searchTerm ? (
        <button
          className="search-clear-button"
          type="button"
          aria-label={clearSearchLabel}
          title={clearSearchLabel}
          onClick={onClearSearch}
        >
          <X size={13} />
        </button>
      ) : (
        <span className="search-shortcut" aria-hidden="true">
          {searchShortcutLabel}
        </span>
      )}
    </label>
  );
}
