import type {
  KnowledgeSource,
  LibraryPanel,
  LibraryPanelAction,
} from "../../lib/crewonDomain";
import type { Locale } from "../../lib/i18n";

export function KnowledgeView({
  panel,
  locale,
  onBack,
  onPanelAction,
}: {
  panel: LibraryPanel;
  locale: Locale;
  onBack: () => void;
  onPanelAction: (action: LibraryPanelAction) => void;
}) {
  const data = panel.knowledge;
  if (!data) return null;
  const isZh = locale === "zh";
  const sourceStatus = (status: KnowledgeSource["status"]) =>
    isZh
      ? { "indexed": "已索引", "indexing": "索引中", "needs-auth": "待授权" }[
          status
        ]
      : {
          "indexed": "Indexed",
          "indexing": "Indexing",
          "needs-auth": "Needs auth",
        }[status];

  return (
    <main className="library-page knowledge-page" aria-label={panel.title}>
      <header className="library-heading">
        <button type="button" onClick={onBack}>
          {isZh ? "返回对话" : "Back to chat"}
        </button>
        <div>
          <h1>{panel.title}</h1>
          <p>{panel.subtitle}</p>
        </div>
      </header>
      {panel.error ? <p className="library-error">{panel.error}</p> : null}
      <div className="library-actions knowledge-actions">
        <button
          type="button"
          data-tone="primary"
          onClick={() =>
            onPanelAction({
              id: "create-knowledge-memory",
              label: isZh ? "写入记忆" : "Write memory",
              tone: "primary",
            })
          }
        >
          {isZh ? "写入记忆" : "Write memory"}
        </button>
        <button
          type="button"
          onClick={() =>
            onPanelAction({
              id: "refresh-knowledge",
              label: isZh ? "刷新知识库" : "Refresh knowledge",
            })
          }
        >
          {isZh ? "刷新知识库" : "Refresh knowledge"}
        </button>
        <button
          type="button"
          data-tone="danger"
          onClick={() =>
            onPanelAction({
              id: "reset-memory",
              label: isZh ? "重置全局记忆" : "Reset global memory",
              tone: "danger",
            })
          }
        >
          {isZh ? "重置全局记忆" : "Reset global memory"}
        </button>
      </div>

      <div className="knowledge-grid">
        <section className="knowledge-col knowledge-memory">
          <div className="activity-card-head">
            <h2>{isZh ? "智能体记忆" : "Agent memory"}</h2>
            <span>{data.memories.length}</span>
          </div>
          <div className="memory-list">
            {data.memories.map((mem) => (
              <button
                type="button"
                className="memory-card"
                data-pinned={mem.pinned ? "true" : "false"}
                key={mem.title}
                onClick={() =>
                  mem.threadId
                    ? onPanelAction({
                        id: "open-thread",
                        label: isZh ? "打开后端线程" : "Open backend thread",
                        threadId: mem.threadId,
                      })
                    : mem.path
                      ? onPanelAction({
                          id: "open-knowledge-file",
                          label: isZh ? "打开知识文件" : "Open knowledge file",
                          knowledgePath: mem.path,
                          knowledgeTitle: mem.title,
                          knowledgeKind: "file",
                        })
                      : undefined
                }
              >
                <span
                  className="memory-glyph"
                  data-accent={mem.accent}
                  aria-hidden="true"
                >
                  {mem.glyph}
                </span>
                <div className="memory-body">
                  <div className="memory-top">
                    <strong>{mem.title}</strong>
                    <span className="memory-kind">{mem.kind}</span>
                    {mem.pinned ? (
                      <span className="memory-pin">
                        {isZh ? "置顶" : "Pinned"}
                      </span>
                    ) : null}
                  </div>
                  <p className="memory-preview">{mem.preview}</p>
                  <span className="memory-meta">{mem.meta}</span>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="knowledge-col knowledge-sources">
          <div className="activity-card-head">
            <h2>{isZh ? "知识源" : "Knowledge sources"}</h2>
            <span>{data.sources.length}</span>
          </div>
          <div className="source-list">
            {data.sources.map((src) => (
              <button
                type="button"
                className="source-row"
                data-status={src.status}
                key={src.name}
                onClick={() =>
                  src.path
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
                      {sourceStatus(src.status)}
                    </span>
                  </div>
                  <p className="source-meta">{src.meta}</p>
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
