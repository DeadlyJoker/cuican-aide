import { MessageSquare, Search, Shapes, X } from "lucide-react";
import { Dialog } from "radix-ui";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { Locale } from "../../lib/i18n";
import { commandNavigationNextIndex } from "./commandNavigationKeyboard";
import type { CommandSearchResult } from "./commandSearchResults";

type SearchContentProps = {
  footer?: ReactNode;
  loading?: boolean;
  failed?: boolean;
  canContinue?: boolean;
  locale: Locale;
  noMatches: string;
  query: string;
  results: CommandSearchResult[];
  searchLabel: string;
  searchResultsLabel: string;
  shortcutLabel: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onActivate: (item: CommandSearchResult) => void;
  onClose: () => void;
  onQueryChange: (query: string) => void;
};

export function CommandSidebarSearchView({
  isSearchOpen,
  ...props
}: SearchContentProps & { isSearchOpen: boolean }) {
  return (
    <Dialog.Root
      open={isSearchOpen}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="command-search-overlay" />
        <CommandSearchContent {...props} />
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function CommandSearchContent({
  footer,
  loading = false,
  failed = false,
  canContinue = false,
  locale,
  noMatches,
  query,
  results,
  searchLabel,
  searchResultsLabel,
  shortcutLabel,
  triggerRef,
  onActivate,
  onClose,
  onQueryChange,
}: SearchContentProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const listId = useId();
  const [selection, setSelection] = useState<{
    query: string;
    key: string | null;
  }>({ query: "", key: null });
  const selectedIndex =
    selection.query === query
      ? results.findIndex((item) => item.key === selection.key)
      : -1;
  const activeIndex = results.length ? Math.max(0, selectedIndex) : -1;
  const activeId =
    !loading && activeIndex >= 0
      ? `${listId}-${encodeURIComponent(results[activeIndex].key)}`
      : undefined;
  const zh = locale === "zh";

  useEffect(() => {
    if (activeId)
      document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  return (
    <Dialog.Content
      className="command-search-dialog"
      aria-modal="true"
      data-command-search-dialog=""
      data-od-id="sidebar-search-panel"
      data-sidebar-search=""
      id="sidebar-search-panel"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        previousFocusRef.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        inputRef.current?.focus();
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        // The directory may be folded or the selected result may unmount the composer.
        const candidates = [
          previousFocusRef.current,
          triggerRef.current,
          document.querySelector<HTMLElement>(
            '.command-rail-button[aria-current="page"]',
          ),
        ];
        candidates
          .find((node) => node?.isConnected && node.getClientRects().length)
          ?.focus();
      }}
      onEscapeKeyDown={(event) => {
        event.preventDefault();
        if (event.isComposing || event.keyCode === 229) return;
        event.stopPropagation();
        onClose();
      }}
    >
      <Dialog.Title className="sr-only">{searchLabel}</Dialog.Title>
      <div className="command-search-field">
        <Search aria-hidden="true" />
        <input
          aria-label={searchLabel}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-expanded="true"
          role="combobox"
          data-sidebar-search-input=""
          placeholder={searchLabel}
          type="search"
          maxLength={256}
          value={query}
          ref={inputRef}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const next = commandNavigationNextIndex(
                event.key,
                activeIndex,
                results.length,
              );
              if (next !== null)
                setSelection({ query, key: results[next].key });
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (!loading && activeIndex >= 0)
                onActivate(results[activeIndex]);
            }
          }}
        />
        <Dialog.Close
          className="command-search-close"
          aria-label={zh ? "关闭搜索" : "Close search"}
        >
          <X aria-hidden="true" />
        </Dialog.Close>
      </div>
      <div
        className="command-search-results"
        role="listbox"
        aria-label={searchResultsLabel}
        aria-busy={loading}
        id={listId}
      >
        {results.map((item, index) => {
          const Icon = item.action === "thread" ? MessageSquare : Shapes;
          return (
            <button
              className="command-search-result"
              data-search-action={item.action}
              data-search-result=""
              data-thread-id={
                item.action === "thread" ? item.threadId : undefined
              }
              key={item.key}
              type="button"
              disabled={loading}
              role="option"
              aria-selected={index === activeIndex}
              tabIndex={-1}
              id={`${listId}-${encodeURIComponent(item.key)}`}
              onPointerMove={(event) => {
                if (event.pointerType === "mouse")
                  setSelection({ query, key: item.key });
              }}
              onClick={() => onActivate(item)}
            >
              <Icon aria-hidden="true" />
              <span>
                <strong>{item.title}</strong>
                <small>{item.detail}</small>
              </span>
              <em>{item.kind}</em>
            </button>
          );
        })}
        {results.length === 0 && !loading && !failed && !canContinue && (
          <p
            className="command-search-empty"
            data-search-empty=""
            role="status"
          >
            {noMatches}
          </p>
        )}
      </div>
      {footer}
      <Dialog.Description className="command-search-footer">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> {zh ? "选择" : "Select"}
        </span>
        <span>
          <kbd>↵</kbd> {zh ? "打开" : "Open"}
        </span>
        <span>
          <kbd>Esc</kbd> {zh ? "关闭" : "Close"}
        </span>
        <kbd className="command-search-shortcut">{shortcutLabel}</kbd>
      </Dialog.Description>
    </Dialog.Content>
  );
}
