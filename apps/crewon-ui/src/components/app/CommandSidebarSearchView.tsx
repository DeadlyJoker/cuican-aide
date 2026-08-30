import { Search } from "lucide-react";
import type { CommandShellView } from "./commandWorkspaceState";

type Result = { action:"thread";detail:string;key:string;kind:string;threadId:string;title:string } | { action:"view";detail:string;key:string;kind:string;title:string;view:CommandShellView };
export function CommandSidebarSearchView({ isSearchOpen, noMatches, query, results, searchLabel, searchResultsLabel, onActivate, onClose, onQueryChange }: { isSearchOpen:boolean; noMatches:string; query:string; results:Result[]; searchLabel:string; searchResultsLabel:string; onActivate:(item:Result)=>void; onClose:()=>void; onQueryChange:(query:string)=>void }) { return (<>
      <section
        className="sidebar-search-panel"
        data-od-id="sidebar-search-panel"
        data-sidebar-search=""
        hidden={!isSearchOpen}
        id="sidebar-search-panel"
      >
        <div className="sidebar-search-field">
          <Search aria-hidden="true" />
          <input
            aria-label={searchLabel}
            data-sidebar-search-input=""
            placeholder={searchLabel}
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              } else if (event.key === "Enter" && results[0]) {
                event.preventDefault();
                onActivate(results[0]);
              }
            }}
          />
          <kbd>⌘K</kbd>
        </div>
        <div
          className="sidebar-search-results"
          role="listbox"
          aria-label={searchResultsLabel}
        >
          {results.map((item) => (
            <button
              className="sidebar-search-result"
              data-search-action={item.action}
              data-search-result=""
              data-thread-id={
                item.action === "thread" ? item.threadId : undefined
              }
              key={item.key}
              type="button"
              onClick={() => onActivate(item)}
            >
              <span>
                <strong>{item.title}</strong>
                <small>{item.detail}</small>
              </span>
              <em>{item.kind}</em>
            </button>
          ))}
          <p
            className="sidebar-search-empty"
            data-search-empty=""
            hidden={results.length > 0}
          >
            {noMatches}
          </p>
        </div>
      </section>

</>); }
