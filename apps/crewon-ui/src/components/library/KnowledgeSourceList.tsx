import type {
  KnowledgeSource,
} from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";
import type { LibraryPanelActionCallback } from "./LibraryPrimitives";

type KnowledgeSourceStatus = KnowledgeSource["status"];

const knowledgeSourceStatusLabels: Record<
  Locale,
  Record<KnowledgeSourceStatus, string>
> = {
  zh: {
    indexed: "已索引",
    indexing: "索引中",
    "needs-auth": "待授权",
  },
  en: {
    indexed: "Indexed",
    indexing: "Indexing",
    "needs-auth": "Needs auth",
  },
};

function knowledgeSourceStatusLabel(
  locale: Locale,
  status: KnowledgeSourceStatus,
) {
  return knowledgeSourceStatusLabels[locale][status];
}

export function KnowledgeSourceList({
  isZh,
  locale,
  onPanelAction,
  sources,
}: {
  isZh: boolean;
  locale: Locale;
  onPanelAction: LibraryPanelActionCallback;
  sources: KnowledgeSource[];
}) {
  return (
    <section className="knowledge-col knowledge-sources">
      <div className="activity-card-head">
        <h2>{isZh ? "知识源" : "Knowledge sources"}</h2>
        <span>{sources.length}</span>
      </div>
      <div className="source-list">
        {sources.map((src) => (
          <button
            type="button"
            className="source-row"
            data-status={src.status}
            key={src.name}
            onClick={() =>
              src.knowledgeId
                ? onPanelAction({
                    id: "open-control-knowledge",
                    label: isZh ? "查看知识源详情" : "View source details",
                    knowledgePath: src.knowledgeId,
                    knowledgeTitle: src.name,
                    knowledgeKind: "file",
                  })
                : src.path
                  ? onPanelAction({
                      id: "open-knowledge-file",
                      label: isZh ? "打开知识源" : "Open knowledge source",
                      knowledgePath: src.path,
                      knowledgeTitle: src.name,
                      knowledgeKind: src.isDirectory ? "directory" : "file",
                    })
                  : undefined
            }
          >
            <span
              className="source-glyph"
              data-accent={src.accent}
              aria-hidden="true"
            >
              {src.glyph}
            </span>
            <div className="source-body">
              <div className="source-top">
                <strong>{src.name}</strong>
                <span className="source-status" data-status={src.status}>
                  {knowledgeSourceStatusLabel(locale, src.status)}
                </span>
              </div>
              <p className="source-meta">{src.meta}</p>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
