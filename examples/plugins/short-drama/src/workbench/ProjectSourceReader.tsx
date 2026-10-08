import { useEffect, useState, useSyncExternalStore } from "react";
import type { PublicProjectSourceChapter } from "@crewon/plugin-sdk/project-foundation-ui";
import type { ProjectFoundationController } from "./ProjectFoundationController";
/** Canonical text comes from actual bounded source pages; chapter positions never stand for produced episodes. */
export function ProjectSourceReader({
  controller,
}: {
  controller: ProjectFoundationController;
}) {
  const s = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [chapter, setChapter] = useState<PublicProjectSourceChapter | null>(
    null,
  );
  useEffect(() => {
    setChapter(null);
    void controller.loadChapters();
    void controller.readSource();
  }, [controller, s.source?.revision]);
  if (!s.source) return <p className="detail-note">此项目尚无小说原文。</p>;
  const page = s.sourcePage;
  return (
    <section className="drama-source-reader" aria-label="小说原文阅读">
      <div className="section-row">
        <h3>{s.source.fileName}</h3>
        <span className="detail-note">
          {s.source.characterLength.toLocaleString("zh-CN")} 字 · 原文材料
        </span>
      </div>
      <div className="drama-source-columns">
        <nav aria-label="原文章节" className="drama-chapter-list">
          <button
            className={`stage-item ${chapter ? "" : "active"}`}
            type="button"
            disabled={s.readingSource}
            onClick={() => {
              setChapter(null);
              void controller.readSource();
            }}
          >
            从开头阅读
          </button>
          {s.chapters.map((item) => (
            <button
              className={`stage-item ${chapter?.chapterId === item.chapterId ? "active" : ""}`}
              type="button"
              key={item.chapterId}
              disabled={s.readingSource}
              onClick={() => {
                setChapter(item);
                void controller.readSource(item.startOffset, item.endOffset);
              }}
            >
              {item.title}
            </button>
          ))}
          {s.nextChapterOffset !== null && (
            <button
              className="text-button"
              type="button"
              disabled={s.readingSource}
              onClick={() => void controller.loadChapters(true)}
            >
              下一页章节
            </button>
          )}
          <button
            className="text-button"
            type="button"
            disabled={s.readingSource}
            onClick={() => void controller.loadChapters()}
          >
            返回章节开头
          </button>
        </nav>
        <article className="drama-source-body">
          {chapter && <h3>{chapter.title}</h3>}
          {s.readingSource && (
            <p className="detail-note" role="status">
              正在读取原文…
            </p>
          )}
          {page && <p className="drama-readable-text">{page.content}</p>}
          <div className="detail-actions">
            <button
              className="button secondary"
              type="button"
              disabled={s.readingSource}
              onClick={() =>
                void controller.readSource(
                  chapter?.startOffset ?? 0,
                  chapter?.endOffset,
                )
              }
            >
              从本节开头阅读
            </button>
            {page?.nextOffset !== null &&
              page?.nextOffset !== undefined &&
              (!chapter || page.nextOffset < chapter.endOffset) && (
                <button
                  className="button secondary"
                  type="button"
                  disabled={s.readingSource}
                  onClick={() =>
                    void controller.readSource(
                      page.nextOffset!,
                      chapter?.endOffset,
                    )
                  }
                >
                  下一页原文
                </button>
              )}
          </div>
        </article>
      </div>
    </section>
  );
}
