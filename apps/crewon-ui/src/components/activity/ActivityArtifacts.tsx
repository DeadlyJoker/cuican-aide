import type { ArtifactItem } from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";

type ActivityArtifactsProps = {
  artifacts: ArtifactItem[];
  locale: Locale;
  onArtifact: (artifact: ArtifactItem) => void;
};

export function ActivityArtifacts({
  artifacts,
  locale,
  onArtifact,
}: ActivityArtifactsProps) {
  const isZh = locale === "zh";

  return (
    <section className="activity-card activity-artifacts">
      <div className="activity-card-head">
        <h2>{isZh ? "产物" : "Artifacts"}</h2>
        <span>{artifacts.length}</span>
      </div>
      <div className="artifact-list">
        {artifacts.map((art) => (
          <button
            type="button"
            className="artifact-row"
            key={art.title}
            onClick={() => onArtifact(art)}
          >
            <span
              className="artifact-glyph"
              data-accent={art.accent}
              aria-hidden="true"
            >
              {art.glyph}
            </span>
            <div className="artifact-body">
              <div className="artifact-top">
                <strong>{art.title}</strong>
                <span className="artifact-kind">{art.kind}</span>
              </div>
              <p className="artifact-meta">{art.meta}</p>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
