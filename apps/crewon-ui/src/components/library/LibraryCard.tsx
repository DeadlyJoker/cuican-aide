import type { LibraryItem } from "../../lib/crewonDomain";

export function LibraryCard({
  item,
  onItemAction,
}: {
  item: LibraryItem;
  onItemAction: (item: LibraryItem) => void;
}) {
  const content = (
    <>
      {item.glyph ? (
        <span
          className="library-card-glyph"
          data-accent={item.accent ?? "slate"}
          aria-hidden="true"
        >
          {item.glyph}
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
        <span className="library-card-chevron" aria-hidden="true">
          ›
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
