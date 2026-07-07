const navItems = [
      {
        key: "command",
        href: "desktop-command.html",
        zh: "\u65b0\u5efa\u4efb\u52a1",
        en: "New task",
        icon: '<svg viewBox="0 0 24 24"><path d="M6.5 5.5h11v13h-11Z"></path><path d="M12 9v6"></path><path d="M9 12h6"></path></svg>'
      },
      {
        key: "assist",
        href: "desktop-command.html#view-assist",
        zh: "\u52a9\u7406",
        en: "Assistant",
        icon: '<svg viewBox="0 0 24 24"><path d="m12 4.75 1.45 4.1 4.1 1.45-4.1 1.45L12 15.85l-1.45-4.1-4.1-1.45 4.1-1.45Z"></path><path d="m17.25 15.5.7 1.95 1.95.7-1.95.7-.7 1.95-.7-1.95-1.95-.7 1.95-.7Z"></path></svg>'
      },
      {
        key: "projects",
        href: "desktop-command.html#view-projects",
        zh: "\u9879\u76ee",
        en: "Projects",
        icon: '<svg viewBox="0 0 24 24"><path d="M4.75 7.5h5.5l1.45 2h7.55v7.8a1.7 1.7 0 0 1-1.7 1.7H6.45a1.7 1.7 0 0 1-1.7-1.7Z"></path><path d="M4.75 9.5h14.5"></path></svg>'
      },
      {
        key: "agents",
        href: "desktop-command.html#view-agents",
        zh: "\u667a\u80fd\u4f53",
        en: "Agents",
        metaZh: "\u6280\u80fd\u00b7\u8fde\u63a5\u5668",
        metaEn: "Skills \u00b7 connectors",
        icon: '<svg viewBox="0 0 24 24"><path d="M12 6.1a2.35 2.35 0 1 0 0 4.7 2.35 2.35 0 0 0 0-4.7Z"></path><path d="M6.6 14.2a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 0 0 0-4.2Z"></path><path d="M17.4 14.2a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 0 0 0-4.2Z"></path><path d="M10.1 10.1 7.7 14.4"></path><path d="m13.9 10.1 2.4 4.3"></path></svg>'
      },
      {
        key: "schedule",
        href: "desktop-command.html#view-schedule",
        zh: "\u65e5\u7a0b\u5b89\u6392",
        en: "Schedule",
        metaZh: "\u8ba1\u5212\u00b7\u63d0\u9192",
        metaEn: "Plans \u00b7 reminders",
        icon: '<svg viewBox="0 0 24 24"><path d="M6.25 6.75h11.5a1.5 1.5 0 0 1 1.5 1.5v9.5a1.5 1.5 0 0 1-1.5 1.5H6.25a1.5 1.5 0 0 1-1.5-1.5v-9.5a1.5 1.5 0 0 1 1.5-1.5Z"></path><path d="M8.2 4.75v3.4"></path><path d="M15.8 4.75v3.4"></path><path d="M4.75 10.3h14.5"></path><path d="M8.1 13.7h3.2"></path><path d="M8.1 16.2h6.1"></path></svg>'
      },
      {
        key: "team",
        href: "desktop-command.html#view-team",
        zh: "\u56e2\u961f",
        en: "Team",
        icon: '<svg viewBox="0 0 24 24"><path d="M9.8 11.4a3.15 3.15 0 1 0 0-6.3 3.15 3.15 0 0 0 0 6.3Z"></path><path d="M4.75 18.75c.65-3 2.35-4.55 5.05-4.55s4.4 1.55 5.05 4.55"></path><path d="M15.2 11.05a2.45 2.45 0 1 0 0-4.9"></path><path d="M15.6 14.35c1.95.35 3.1 1.8 3.65 4.4"></path></svg>'
      }
    ];

const knowledgeIcon = '<svg viewBox="0 0 24 24"><path d="M5.75 5.75h8.8a3.7 3.7 0 0 1 3.7 3.7v8.8H9.45a3.7 3.7 0 0 0-3.7-3.7Z"></path><path d="M5.75 5.75v12.5"></path><path d="M9.3 9.25h5.25"></path><path d="M9.3 12.25h4.1"></path></svg>';

function navMarkup(current: string, logTarget: string) {
  const links = navItems.map((item) => {
    const meta = item.metaZh ? `<em data-zh="${item.metaZh}" data-en="${item.metaEn}">${item.metaZh}</em>` : "";
    const active = item.key === current;
    return `<a${active ? ' class="active"' : ""}${active ? ' aria-current="page"' : ""} href="#view-${item.key}" data-shell-view-target="${item.key}" data-nav-key="${item.key}"><span class="nav-glyph" aria-hidden="true">${item.icon}</span><strong data-zh="${item.zh}" data-en="${item.en}">${item.zh}</strong>${meta}</a>`;
  }).join("");
  return `${links}
          <button type="button" data-run="#${logTarget}" data-run-title-zh="\u77e5\u8bc6\u5e93" data-run-title-en="Knowledge base" data-run-copy="\u77e5\u8bc6\u5e93\u5165\u53e3\u5305\u542b\u56e2\u961f\u6587\u6863\u3001\u9879\u76ee\u6750\u6599\u3001\u957f\u671f\u8bb0\u5fc6\u548c\u53ef\u5f15\u7528\u8d44\u6599\u3002" data-run-copy-en="Knowledge base includes team docs, project materials, long-term memories, and referenceable resources." data-toast="\u77e5\u8bc6\u5e93\u5df2\u805a\u7126" data-toast-en="Knowledge base focused"><span class="nav-glyph" aria-hidden="true">${knowledgeIcon}</span><strong data-zh="\u77e5\u8bc6\u5e93" data-en="Knowledge base">\u77e5\u8bc6\u5e93</strong></button>`;
}

function runAttrs(
  logTarget: string,
  titleZh: string,
  titleEn: string,
  copyZh: string,
  copyEn: string,
  toastZh: string,
  toastEn: string,
) {
  return `data-run="#${logTarget}" data-run-title-zh="${titleZh}" data-run-title-en="${titleEn}" data-run-copy="${copyZh}" data-run-copy-en="${copyEn}" data-toast="${toastZh}" data-toast-en="${toastEn}"`;
}

export function originalSidebarHtml(current = "command", logTarget = "command-log", idPrefix = "desktop") {
  return `
        <div class="sidebar-topbar" data-od-id="${idPrefix}-sidebar-topbar">
          <div class="traffic" aria-hidden="true"><span class="dot close"></span><span class="dot min"></span><span class="dot max"></span></div>
          <div class="sidebar-tools" aria-label="侧栏操作">
            <button class="sidebar-tool" type="button" aria-label="收起侧栏" aria-pressed="false" data-sidebar-collapse data-od-id="sidebar-collapse-button">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 5.5h13v13h-13Z"></path><path d="M10 5.5v13"></path><path d="m14.4 9.2-2.8 2.8 2.8 2.8"></path></svg>
            </button>
            <button class="sidebar-tool" type="button" aria-label="搜索" aria-expanded="false" aria-controls="sidebar-search-panel" data-sidebar-search-open data-od-id="sidebar-search-button">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.8 16.1a5.3 5.3 0 1 0 0-10.6 5.3 5.3 0 0 0 0 10.6Z"></path><path d="m15 15 4 4"></path></svg>
            </button>
          </div>
        </div>

        <section class="sidebar-search-panel" id="sidebar-search-panel" data-sidebar-search data-od-id="sidebar-search-panel" hidden>
          <div class="sidebar-search-field">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.8 16.1a5.3 5.3 0 1 0 0-10.6 5.3 5.3 0 0 0 0 10.6Z"></path><path d="m15 15 4 4"></path></svg>
            <input type="search" aria-label="搜索空间、会话、能力和智能体" data-sidebar-search-input data-placeholder-zh="搜索空间、会话、能力和智能体" data-placeholder-en="Search spaces, conversations, capabilities, and agents" placeholder="搜索空间、会话、能力和智能体" />
            <kbd>⌘K</kbd>
          </div>
          <div class="sidebar-search-results" role="listbox" aria-label="搜索结果">
            <button class="sidebar-search-result" type="button" data-search-result data-search-keywords="Agent 小队交付空间 workspace 当前空间 agent team delivery" data-search-status-zh="已定位到 Agent 小队交付空间" data-search-status-en="Located Agent team delivery space">
              <span><strong data-zh="Agent 小队交付空间" data-en="Agent team delivery">Agent 小队交付空间</strong><small data-zh="当前空间" data-en="Current space">当前空间</small></span><em>Space</em>
            </button>
            <button class="sidebar-search-result" type="button" data-search-result data-search-keywords="小队创建草稿 conversation team setup" data-search-status-zh="已定位到小队创建草稿会话" data-search-status-en="Located team setup draft conversation">
              <span><strong data-zh="小队创建草稿" data-en="Team setup draft">小队创建草稿</strong><small data-zh="Agent 小队交付空间" data-en="Agent team delivery">Agent 小队交付空间</small></span><em>Chat</em>
            </button>
            <button class="sidebar-search-result" type="button" data-search-result data-search-keywords="Skill MCP 能力空间 tool capability schema sandbox" data-search-status-zh="已定位到 Skill/MCP 能力空间" data-search-status-en="Located Skill/MCP capability space">
              <span><strong data-zh="Skill/MCP 能力空间" data-en="Skill/MCP capability">Skill/MCP 能力空间</strong><small>Schema · Sandbox</small></span><em>Space</em>
            </button>
            <button class="sidebar-search-result" type="button" data-search-result data-search-keywords="产品审阅智能体 agent visual review" data-search-status-zh="已定位到产品审阅智能体" data-search-status-en="Located Product review agent">
              <span><strong data-zh="产品审阅智能体" data-en="Product review agent">产品审阅智能体</strong><small data-zh="引用左侧智能体配置" data-en="Agent configuration">引用左侧智能体配置</small></span><em>Agent</em>
            </button>
            <p class="sidebar-search-empty" data-search-empty hidden data-zh="没有匹配项" data-en="No matches">没有匹配项</p>
          </div>
        </section>

        <a class="sidebar-brand" href="index.html" data-od-id="${idPrefix}-brand">
          <span>Crewon</span>
          <small>v0.2</small>
        </a>

        <nav class="sidebar-nav" data-od-id="${idPrefix}-nav">
          ${navMarkup(current, logTarget)}
        </nav>

        <section class="space-tree" data-od-id="${idPrefix}-workspace-tree" aria-label="空间与会话">
          <div class="tree-head">
            <button type="button" ${runAttrs(logTarget, "空间", "Spaces", "当前有 3 个空间，每个空间下可承载多个会话。", "There are 3 spaces, each with multiple conversations.", "空间树已聚焦", "Space tree focused")} data-zh="空间" data-en="Spaces">空间</button>
            <button class="tree-add" type="button" aria-label="新建空间" ${runAttrs(logTarget, "新建空间", "New space", "已准备新建空间，可继续填写名称与成员。", "New space is ready for a name and members.", "准备新建空间", "New space ready")}>+</button>
          </div>
          <div class="space-node current" data-od-id="workspace-node-product">
            <button class="space-title" type="button" ${runAttrs(logTarget, "Agent 小队交付空间", "Agent team delivery space", "Agent 小队交付空间包含 3 个会话：小队创建草稿、Workflow Gate、交付验收清单。", "Agent team delivery space contains 3 conversations: team setup draft, Workflow Gate, delivery checklist.", "已切换到 Agent 小队交付空间", "Agent team delivery selected")}><span aria-hidden="true">⌄</span><strong data-zh="Agent 小队交付空间" data-en="Agent team delivery">Agent 小队交付空间</strong></button>
            <div class="conversation-list">
              <button class="conversation-item active" type="button" ${runAttrs(logTarget, "小队创建草稿", "Team setup draft", "已打开小队创建草稿会话。", "Opened Team setup draft conversation.", "已打开会话", "Conversation opened")} data-zh="小队创建草稿" data-en="Team setup draft">小队创建草稿</button>
              <button class="conversation-item" type="button" ${runAttrs(logTarget, "Workflow Gate", "Workflow Gate", "Workflow Gate 会话已准备继续编辑。", "Workflow Gate conversation is ready to continue.", "已打开会话", "Conversation opened")} data-zh="Workflow Gate" data-en="Workflow Gate">Workflow Gate</button>
              <button class="conversation-item" type="button" ${runAttrs(logTarget, "交付验收清单", "Delivery checklist", "交付验收清单会话已准备继续编辑。", "Delivery checklist conversation is ready to continue.", "已打开会话", "Conversation opened")} data-zh="交付验收清单" data-en="Delivery checklist">交付验收清单</button>
            </div>
          </div>
          <div class="space-node" data-od-id="workspace-node-team">
            <button class="space-title" type="button" ${runAttrs(logTarget, "办公室权限空间", "Office access space", "办公室权限空间包含四层权限和 Channel 桥接两个会话。", "Office access space contains layered access and Channel bridge conversations.", "已切换到办公室权限空间", "Office access space selected")}><span aria-hidden="true">⌄</span><strong data-zh="办公室权限空间" data-en="Office access">办公室权限空间</strong></button>
            <div class="conversation-list compact">
              <button class="conversation-item" type="button" ${runAttrs(logTarget, "四层权限", "Layered access", "四层权限会话已打开。", "Layered access conversation opened.", "已打开会话", "Conversation opened")} data-zh="四层权限" data-en="Layered access">四层权限</button>
              <button class="conversation-item" type="button" ${runAttrs(logTarget, "Channel 桥接", "Channel bridge", "Channel 桥接会话已打开。", "Channel bridge conversation opened.", "已打开会话", "Conversation opened")} data-zh="Channel 桥接" data-en="Channel bridge">Channel 桥接</button>
            </div>
          </div>
          <div class="space-node" data-od-id="workspace-node-tools">
            <button class="space-title" type="button" ${runAttrs(logTarget, "Skill/MCP 能力空间", "Skill/MCP capability space", "Skill/MCP 能力空间包含 Schema 校验和沙箱审计两个会话。", "Skill/MCP capability space contains schema validation and sandbox audit conversations.", "已切换到 Skill/MCP 能力空间", "Skill/MCP capability selected")}><span aria-hidden="true">⌄</span><strong data-zh="Skill/MCP 能力空间" data-en="Skill/MCP capability">Skill/MCP 能力空间</strong></button>
            <div class="conversation-list compact">
              <button class="conversation-item" type="button" ${runAttrs(logTarget, "Schema 校验", "Schema validation", "Schema 校验会话已打开。", "Schema validation conversation opened.", "已打开会话", "Conversation opened")} data-zh="Schema 校验" data-en="Schema validation">Schema 校验</button>
              <button class="conversation-item" type="button" ${runAttrs(logTarget, "沙箱审计", "Sandbox audit", "沙箱审计会话已打开。", "Sandbox audit conversation opened.", "已打开会话", "Conversation opened")} data-zh="沙箱审计" data-en="Sandbox audit">沙箱审计</button>
            </div>
          </div>
        </section>

        <footer class="sidebar-account" data-od-id="${idPrefix}-account-entry">
          <span class="account-mark">R</span>
          <strong>Turning_Around</strong>
          <button class="locale-toggle" type="button" data-od-id="${idPrefix}-locale">EN</button>
        </footer>`;
}
