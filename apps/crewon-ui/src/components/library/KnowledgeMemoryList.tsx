import type {
  KnowledgeEntry,
} from "../../lib/domain/crewonDomain";
import type { LibraryPanelActionCallback } from "./LibraryPrimitives";

export function KnowledgeMemoryList({
  isZh,
  memories,
  onPanelAction,
}: {
  isZh: boolean;
  memories: KnowledgeEntry[];
  onPanelAction: LibraryPanelActionCallback;
}) {
  return (
    <section className="knowledge-col knowledge-memory">
      <div className="activity-card-head">
        <h2>{isZh ? "智能体记忆" : "Agent memory"}</h2>
        <span>{memories.length}</span>
      </div>
      <div className="memory-list">
        {memories.map((mem) => (
          <button
            type="button"
            className="memory-card"
            data-pinned={mem.pinned ? "true" : "false"}
            key={mem.title}
            onClick={() =>
              mem.knowledgeId
                ? onPanelAction({
                    id: "open-control-knowledge",
                    label: isZh ? "查看记忆详情" : "View memory details",
                    knowledgePath: mem.knowledgeId,
                    knowledgeTitle: mem.title,
                    knowledgeKind: "file",
                  })
                : mem.threadId
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
  );
}
