import type { AgentConfig, LibraryPanel } from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";

export function AgentHistoryCard({
  config,
  panel,
  locale,
}: {
  config: AgentConfig;
  panel: LibraryPanel;
  locale: Locale;
}) {
  return (
    <section className="agent-config-card agent-config-history">
      <div className="agent-config-card-head">
        <strong>{locale === "zh" ? "后端记录" : "Backend records"}</strong>
        <span>
          {config.threadId
            ? locale === "zh"
              ? "来自 agent/list"
              : "Loaded from agent/list"
            : locale === "zh"
              ? "保存后创建"
              : "Created after save"}
        </span>
      </div>
      <div className="agent-history-list">
        {panel.items.length > 0 ? (
          panel.items.map((item) =>
            item.section ? (
              <div className="library-section" key={`${item.title}:${item.meta}`}>
                <strong>{item.title}</strong>
                <span>{item.meta}</span>
                {item.description ? <p>{item.description}</p> : null}
              </div>
            ) : (
              <article
                className="agent-history-item"
                data-accent={item.accent ?? "slate"}
                key={`${item.title}:${item.meta}`}
              >
                <span aria-hidden="true">{item.glyph ?? "✓"}</span>
                <div>
                  <strong>{item.title}</strong>
                  <em>{item.meta}</em>
                  {item.description ? <p>{item.description}</p> : null}
                </div>
              </article>
            ),
          )
        ) : (
          <article className="agent-history-item" data-accent="slate">
            <span aria-hidden="true">◷</span>
            <div>
              <strong>
                {locale === "zh" ? "暂无后端记录" : "No backend records"}
              </strong>
              <em>{locale === "zh" ? "等待首次保存" : "Waiting for save"}</em>
              <p>
                {locale === "zh"
                  ? "保存配置后会写入 app-server agent/create 或 agent/update。"
                  : "Saving writes this configuration through app-server agent/create or agent/update."}
              </p>
            </div>
          </article>
        )}
      </div>
    </section>
  );
}
