export function ControlRuntimeUnavailable() {
  return (
    <main className="crewon-auth-shell">
      <section className="crewon-auth-story" aria-label="CrewON 产品介绍">
        <span className="crewon-auth-brand">
          <span className="crewon-auth-brand-mark">C</span>
          <span>
            <strong>CrewON</strong>
            <small>Agent 协作工作台</small>
          </span>
        </span>
        <div className="crewon-auth-story-copy">
          <h1>CrewON 智能协作工作台</h1>
          <p>统一组织 Agent、Skill、MCP 与企业知识，协同推进任务交付。</p>
        </div>
      </section>
      <section className="crewon-auth-panel" aria-label="Control 运行时不可用">
        <div className="crewon-auth-card" role="alert">
          <header>
            <span className="crewon-auth-mobile-brand">CrewON</span>
            <h2>Control 运行时不可用</h2>
            <p>
              无法建立安全的 Control 会话。CrewON 已停止启动，不会连接旧 App
              Server。请确认桌面运行时或 Web BFF 已启动，然后重新加载。
            </p>
          </header>
          <button
            className="crewon-auth-submit"
            type="button"
            onClick={() => globalThis.location.reload()}
          >
            重新加载
          </button>
        </div>
      </section>
    </main>
  );
}
