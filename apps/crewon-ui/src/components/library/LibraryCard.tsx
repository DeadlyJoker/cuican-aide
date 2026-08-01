import type { LibraryItem } from "../../lib/domain/crewonDomain";
import { CapabilityLogo } from "../catalog/CapabilityLogo";

export function LibraryCard({
  item,
  onItemAction,
}: {
  item: LibraryItem;
  onItemAction: (item: LibraryItem) => void;
}) {
  const content = (
    <>
      {item.logo || item.glyph ? (
        <span
          className="library-card-glyph"
          data-accent={item.accent ?? "slate"}
          aria-hidden="true"
        >
          {item.logo ? (
            <CapabilityLogo
              fallback={item.glyph ?? item.title.slice(0, 1)}
              logo={item.logo}
            />
          ) : (
            item.glyph
          )}
        </span>
      ) : null}
      <span className="library-card-main">
        <span className="library-card-title-row">
          <strong>{item.title}</strong>
          {item.badge ? (
            <span
              className="library-badge"
              data-tone={item.badge.tone ?? "idle"}
            >
              {item.badge.label}
            </span>
          ) : null}
        </span>
        <span className="library-card-meta">{item.meta}</span>
        {item.description ? <p>{item.description}</p> : null}
        {item.tags && item.tags.length > 0 ? (
          <span className="library-card-tags">
            {item.tags.map((tag) => (
              <span className="library-tag" key={tag}>
                {tag}
              </span>
            ))}
          </span>
        ) : null}
      </span>
      {item.action ? (
        <span
          className="library-card-chevron"
          data-add={item.action.type === "capability-preset"}
          aria-hidden="true"
        >
          {item.action.type === "capability-preset" ? "+" : "›"}
        </span>
      ) : null}
    </>
  );

  if (item.action) {
    return (
      <button
        className="library-item"
        data-accent={item.accent ?? "slate"}
        type="button"
        onClick={() => onItemAction(item)}
      >
        {content}
      </button>
    );
  }

  return (
    <article className="library-item" data-accent={item.accent ?? "slate"}>
      {content}
    </article>
  );
}
