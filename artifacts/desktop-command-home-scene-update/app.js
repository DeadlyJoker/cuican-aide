(function () {
  const SELECTOR_TEXT = "[data-zh][data-en]";
  const STORE_LOCALE = "crewon:locale";

  function currentLocale() {
    return localStorage.getItem(STORE_LOCALE) || "zh";
  }

  function applyLocale(locale) {
    document.documentElement.lang = locale === "en" ? "en" : "zh-CN";
    document.querySelectorAll(SELECTOR_TEXT).forEach((node) => {
      const value = node.dataset[locale] || node.dataset.zh || "";
      if (node.dataset.keepHtml === "true") {
        node.innerHTML = value;
      } else {
        node.textContent = value;
      }
    });
    document.querySelectorAll("[data-placeholder-zh]").forEach((node) => {
      node.setAttribute("placeholder", node.dataset[`placeholder${locale === "en" ? "En" : "Zh"}`] || node.dataset.placeholderZh || "");
    });
    document.querySelectorAll(".locale-toggle").forEach((button) => {
      button.textContent = locale === "en" ? "中文" : "EN";
      button.setAttribute("aria-label", locale === "en" ? "Switch to Chinese" : "切换到英文");
    });
    document.dispatchEvent(new CustomEvent("localechange", { detail: { locale } }));
  }

  function setupLocale() {
    applyLocale(currentLocale());
    document.querySelectorAll(".locale-toggle").forEach((button) => {
      button.addEventListener("click", () => {
        const next = currentLocale() === "en" ? "zh" : "en";
        localStorage.setItem(STORE_LOCALE, next);
        applyLocale(next);
        toast(next === "en" ? "Language switched to English" : "已切换为中文");
      });
    });
  }

  function toast(message) {
    let el = document.querySelector(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(window.__crewonToast);
    window.__crewonToast = setTimeout(() => el.classList.remove("show"), 2100);
  }

  function setupModeSwitch() {
    const buttons = document.querySelectorAll(".mode-button[data-mode]");
    const hint = document.querySelector("[data-mode-hint]");
    const composer = document.querySelector("[data-composer]");
    if (!buttons.length) return;
    const hints = {
      ask: {
        zh: "Ask 适合确认事实、查上下文、解释任务依赖。",
        en: "Ask is for facts, context lookup, and dependency explanation.",
        placeholderZh: "问 Crewon：今天有哪些任务阻塞？需要谁确认？",
        placeholderEn: "Ask Crewon: What is blocked today and who needs to confirm?"
      },
      plan: {
        zh: "Plan 会先拆 Workflow、暴露风险，再等待你批准 Gate。",
        en: "Plan decomposes Workflow, exposes risks, and waits for Gate approval.",
        placeholderZh: "让 Crewon 拆解：把产品需求整理成 Workflow 节点、角色分工和 Gate。",
        placeholderEn: "Plan with Crewon: turn requirements into Workflow nodes, role split, and gates."
      },
      agent: {
        zh: "智能体模式会使用已配置的角色、能力和权限边界。",
        en: "Agent mode uses configured roles, tools, and access boundaries.",
        placeholderZh: "调用合适的智能体，按当前 Skill/MCP 权限推进交付。",
        placeholderEn: "Use the right Agent with current Skill/MCP access."
      }
    };
    buttons.forEach((button) => {
      button.setAttribute("aria-pressed", button.classList.contains("active") ? "true" : "false");
      button.addEventListener("click", () => {
        buttons.forEach((item) => {
          const active = item === button;
          item.classList.toggle("active", active);
          item.setAttribute("aria-pressed", active ? "true" : "false");
        });
        const copy = hints[button.dataset.mode];
        if (hint && copy) {
          hint.dataset.zh = copy.zh;
          hint.dataset.en = copy.en;
          hint.textContent = currentLocale() === "en" ? copy.en : copy.zh;
        }
        if (composer && copy) {
          composer.dataset.placeholderZh = copy.placeholderZh;
          composer.dataset.placeholderEn = copy.placeholderEn;
          composer.setAttribute("placeholder", currentLocale() === "en" ? copy.placeholderEn : copy.placeholderZh);
        }
      });
    });
  }

  function setupTaskChecks() {
    const rows = document.querySelectorAll(".task-row");
    const progress = document.querySelector("[data-progress-value]");
    const label = document.querySelector("[data-progress-label]");
    if (!rows.length) return;
    function paint() {
      const total = rows.length;
      const done = Array.from(rows).filter((row) => row.classList.contains("done")).length;
      const percent = Math.round((done / total) * 100);
      if (progress) progress.style.setProperty("--value", `${percent}%`);
      if (label) {
        label.dataset.zh = `${done}/${total} 已完成`;
        label.dataset.en = `${done}/${total} done`;
        label.textContent = currentLocale() === "en" ? label.dataset.en : label.dataset.zh;
      }
    }
    rows.forEach((row) => {
      const input = row.querySelector('input[type="checkbox"]');
      if (!input) return;
      input.addEventListener("change", () => {
        row.classList.toggle("done", input.checked);
        paint();
      });
    });
    paint();
  }

  function setupRunActions() {
    const appendAssistMessage = (target, role, text, label) => {
      const line = document.createElement("div");
      line.className = `assistant-chat-line is-${role}`;
      line.setAttribute("role", "article");
      line.setAttribute("aria-label", label || (role === "user" ? "你" : "助理"));
      const content = document.createElement("div");
      content.className = "assistant-chat-content";
      const body = document.createElement("p");
      body.textContent = text;
      if (role === "assistant") {
        const head = document.createElement("div");
        head.className = "assistant-chat-head";
        const name = document.createElement("strong");
        name.textContent = label || "Crewon";
        const state = document.createElement("span");
        state.textContent = currentLocale() === "en" ? "Completed" : "已完成";
        head.append(name, state);
        content.append(head, body);
      } else {
        content.append(body);
      }
      line.append(content);
      target.append(line);
      target.scrollTop = target.scrollHeight;
    };

    document.querySelectorAll("[data-run]").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.getAttribute("aria-busy") === "true") return;
        button.setAttribute("aria-busy", "true");
        button.classList.add("is-loading");
        if (button instanceof HTMLButtonElement) button.disabled = true;
        const target = document.querySelector(button.dataset.run || "");
        const statusScope = target?.closest("[data-shell-view]") || button.closest(".command-input") || button.closest("[data-shell-view]") || document;
        const statuses = Array.from(statusScope.querySelectorAll("[data-composer-status]"));
        const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const locale = currentLocale();
        const title = button.dataset[`runTitle${locale === "en" ? "En" : "Zh"}`] || button.dataset.runTitle || "Crewon";
        const copy = button.dataset[`runCopy${locale === "en" ? "En" : "Zh"}`] || button.dataset.runCopy || "已创建一条新的执行记录。";
        if (statuses.length) {
          statuses.forEach((status) => {
          status.dataset.zh = "生成中 · 正在整理上下文";
          status.dataset.en = "Generating · organizing context";
          status.textContent = locale === "en" ? status.dataset.en : status.dataset.zh;
          });
        }
        if (target) {
          if (target.id === "assist-log") {
            const assistInput = document.getElementById("assist-input");
            const userCopy = assistInput instanceof HTMLTextAreaElement ? assistInput.value.trim() : "";
            if (button.classList.contains("send-button") && userCopy) {
              appendAssistMessage(target, "user", userCopy, locale === "en" ? "You" : "你");
              assistInput.value = "";
            }
            appendAssistMessage(target, "assistant", copy, title);
          } else {
            const line = document.createElement("div");
            line.className = "log-line";
            line.innerHTML = `<div class="log-top"><strong>${title}</strong><span class="mono">${now}</span></div><p>${copy}</p>`;
            target.prepend(line);
          }
        }
        if (statuses.length) {
          window.setTimeout(() => {
            const doneLocale = currentLocale();
            statuses.forEach((status) => {
              status.dataset.zh = "已就绪 · 可继续编辑或发送";
              status.dataset.en = "Ready · edit or send";
              status.textContent = doneLocale === "en" ? status.dataset.en : status.dataset.zh;
            });
            button.removeAttribute("aria-busy");
            button.classList.remove("is-loading");
            if (button instanceof HTMLButtonElement) button.disabled = false;
          }, 520);
        } else {
          window.setTimeout(() => {
            button.removeAttribute("aria-busy");
            button.classList.remove("is-loading");
            if (button instanceof HTMLButtonElement) button.disabled = false;
          }, 520);
        }
        toast(button.dataset[`toast${locale === "en" ? "En" : "Zh"}`] || button.dataset.toast || (locale === "en" ? "Run log updated" : "已更新执行记录"));
      });
    });
  }

  function setComposerStatus(zh, en, scope) {
    const statusScope = scope?.closest?.(".command-input") || scope?.closest?.("[data-shell-view]") || scope || document;
    const scopedStatuses = statusScope.querySelectorAll?.("[data-composer-status]") || [];
    const statuses = scopedStatuses.length ? scopedStatuses : document.querySelectorAll("[data-composer-status]");
    if (!statuses.length) return;
    statuses.forEach((status) => {
      status.dataset.zh = zh;
      status.dataset.en = en;
      status.textContent = currentLocale() === "en" ? en : zh;
    });
  }

  function renderSharedSidebar() {
    const navItems = [
      {
        key: "command",
        href: "desktop-command.html",
        zh: "新建任务",
        en: "New task",
        icon: '<svg viewBox="0 0 24 24"><path d="M6.5 5.5h11v13h-11Z"></path><path d="M12 9v6"></path><path d="M9 12h6"></path></svg>'
      },
      {
        key: "assist",
        href: "desktop-command.html#view-assist",
        zh: "助理",
        en: "Assistant",
        icon: '<svg viewBox="0 0 24 24"><path d="m12 4.75 1.45 4.1 4.1 1.45-4.1 1.45L12 15.85l-1.45-4.1-4.1-1.45 4.1-1.45Z"></path><path d="m17.25 15.5.7 1.95 1.95.7-1.95.7-.7 1.95-.7-1.95-1.95-.7 1.95-.7Z"></path></svg>'
      },
      {
        key: "projects",
        href: "desktop-command.html#view-projects",
        zh: "项目",
        en: "Projects",
        icon: '<svg viewBox="0 0 24 24"><path d="M4.75 7.5h5.5l1.45 2h7.55v7.8a1.7 1.7 0 0 1-1.7 1.7H6.45a1.7 1.7 0 0 1-1.7-1.7Z"></path><path d="M4.75 9.5h14.5"></path></svg>'
      },
      {
        key: "agents",
        href: "desktop-command.html#view-agents",
        zh: "智能体",
        en: "Agents",
        metaZh: "技能·连接器",
        metaEn: "Skills · connectors",
        icon: '<svg viewBox="0 0 24 24"><path d="M12 6.1a2.35 2.35 0 1 0 0 4.7 2.35 2.35 0 0 0 0-4.7Z"></path><path d="M6.6 14.2a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 0 0 0-4.2Z"></path><path d="M17.4 14.2a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 0 0 0-4.2Z"></path><path d="M10.1 10.1 7.7 14.4"></path><path d="m13.9 10.1 2.4 4.3"></path></svg>'
      },
      {
        key: "schedule",
        href: "desktop-command.html#view-schedule",
        zh: "日程安排",
        en: "Schedule",
        metaZh: "计划·提醒",
        metaEn: "Plans · reminders",
        icon: '<svg viewBox="0 0 24 24"><path d="M6.25 6.75h11.5a1.5 1.5 0 0 1 1.5 1.5v9.5a1.5 1.5 0 0 1-1.5 1.5H6.25a1.5 1.5 0 0 1-1.5-1.5v-9.5a1.5 1.5 0 0 1 1.5-1.5Z"></path><path d="M8.2 4.75v3.4"></path><path d="M15.8 4.75v3.4"></path><path d="M4.75 10.3h14.5"></path><path d="M8.1 13.7h3.2"></path><path d="M8.1 16.2h6.1"></path></svg>'
      },
      {
        key: "team",
        href: "desktop-command.html#view-team",
        zh: "团队",
        en: "Team",
        icon: '<svg viewBox="0 0 24 24"><path d="M9.8 11.4a3.15 3.15 0 1 0 0-6.3 3.15 3.15 0 0 0 0 6.3Z"></path><path d="M4.75 18.75c.65-3 2.35-4.55 5.05-4.55s4.4 1.55 5.05 4.55"></path><path d="M15.2 11.05a2.45 2.45 0 1 0 0-4.9"></path><path d="M15.6 14.35c1.95.35 3.1 1.8 3.65 4.4"></path></svg>'
      }
    ];

    const knowledgeIcon = '<svg viewBox="0 0 24 24"><path d="M5.75 5.75h8.8a3.7 3.7 0 0 1 3.7 3.7v8.8H9.45a3.7 3.7 0 0 0-3.7-3.7Z"></path><path d="M5.75 5.75v12.5"></path><path d="M9.3 9.25h5.25"></path><path d="M9.3 12.25h4.1"></path></svg>';

    function navMarkup(current, logTarget) {
      const singleShell = !!document.querySelector("[data-shell-view]");
      const links = navItems.map((item) => {
        const meta = item.metaZh
          ? `<em data-zh="${item.metaZh}" data-en="${item.metaEn}">${item.metaZh}</em>`
          : "";
        const href = singleShell ? `#view-${item.key}` : item.href;
        const viewAttrs = singleShell ? ` data-shell-view-target="${item.key}" data-nav-key="${item.key}"` : "";
        const currentAttr = item.key === current ? ' aria-current="page"' : "";
        return `<a${item.key === current ? ' class="active"' : ""}${currentAttr} href="${href}"${viewAttrs}><span class="nav-glyph" aria-hidden="true">${item.icon}</span><strong data-zh="${item.zh}" data-en="${item.en}">${item.zh}</strong>${meta}</a>`;
      }).join("");
      return `${links}
          <button type="button" data-run="#${logTarget}" data-run-title-zh="知识库" data-run-title-en="Knowledge base" data-run-copy="知识库入口包含团队文档、项目材料、长期记忆和可引用资料。" data-run-copy-en="Knowledge base includes team docs, project materials, long-term memories, and referenceable resources." data-toast="知识库已聚焦" data-toast-en="Knowledge base focused"><span class="nav-glyph" aria-hidden="true">${knowledgeIcon}</span><strong data-zh="知识库" data-en="Knowledge base">知识库</strong></button>`;
    }

    function runAttrs(logTarget, titleZh, titleEn, copyZh, copyEn, toastZh, toastEn) {
      return `data-run="#${logTarget}" data-run-title-zh="${titleZh}" data-run-title-en="${titleEn}" data-run-copy="${copyZh}" data-run-copy-en="${copyEn}" data-toast="${toastZh}" data-toast-en="${toastEn}"`;
    }

    document.querySelectorAll("[data-sidebar-shell]").forEach((sidebar) => {
      const current = sidebar.dataset.sidebarCurrent || "command";
      const logTarget = sidebar.dataset.sidebarLog || "command-log";
      const idPrefix = sidebar.dataset.sidebarPrefix || current;
      sidebar.innerHTML = `
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
    });
  }

  function setupSidebarTools() {
    const shell = document.querySelector(".command-window");
    const collapseButton = document.querySelector("[data-sidebar-collapse]");
    const searchButton = document.querySelector("[data-sidebar-search-open]");
    const searchPanel = document.querySelector("[data-sidebar-search]");
    const searchInput = document.querySelector("[data-sidebar-search-input]");
    const searchResults = Array.from(document.querySelectorAll("[data-search-result]"));
    const emptyState = document.querySelector("[data-search-empty]");
    const STORE_SIDEBAR = "crewon:sidebar-collapsed";

    function setCollapseLabel(collapsed) {
      if (!collapseButton) return;
      const locale = currentLocale();
      collapseButton.setAttribute(
        "aria-label",
        locale === "en"
          ? (collapsed ? "Expand sidebar" : "Collapse sidebar")
          : (collapsed ? "展开侧栏" : "收起侧栏")
      );
    }

    function setCollapsed(collapsed, announce) {
      if (!shell || !collapseButton) return;
      shell.classList.toggle("sidebar-collapsed", collapsed);
      collapseButton.setAttribute("aria-pressed", collapsed ? "true" : "false");
      setCollapseLabel(collapsed);
      if (collapsed) setSearchOpen(false, false);
      try { localStorage.setItem(STORE_SIDEBAR, collapsed ? "true" : "false"); } catch (_) {}
      if (announce) {
        const zh = collapsed ? "侧栏已完全收起 · 左上角按钮可展开" : "侧栏已展开 · 空间与会话已恢复";
        const en = collapsed ? "Sidebar fully collapsed · top-left button expands it" : "Sidebar expanded · spaces and conversations restored";
        setComposerStatus(zh, en);
        toast(currentLocale() === "en" ? en : zh);
      }
    }

    function filterSearch() {
      if (!searchInput) return;
      const query = searchInput.value.trim().toLowerCase();
      let visibleCount = 0;
      searchResults.forEach((button) => {
        const source = `${button.textContent || ""} ${button.dataset.searchKeywords || ""}`.toLowerCase();
        const visible = !query || source.includes(query);
        button.hidden = !visible;
        if (visible) visibleCount += 1;
      });
      if (emptyState) emptyState.hidden = visibleCount > 0;
    }

    function setSearchOpen(open, restoreFocus) {
      if (!searchPanel || !searchButton) return;
      if (open && shell?.classList.contains("sidebar-collapsed")) {
        setCollapsed(false, false);
      }
      searchPanel.hidden = !open;
      searchButton.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) {
        filterSearch();
        setComposerStatus("搜索已打开 · 可查找空间、会话、能力和智能体", "Search open · find spaces, conversations, capabilities, and agents");
        window.setTimeout(() => searchInput?.focus(), 0);
      } else if (restoreFocus) {
        searchButton.focus();
      }
    }

    try {
      if (localStorage.getItem(STORE_SIDEBAR) === "true") setCollapsed(true, false);
      else setCollapseLabel(false);
    } catch (_) {
      setCollapseLabel(false);
    }

    collapseButton?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setCollapsed(!shell?.classList.contains("sidebar-collapsed"), true);
    });

    searchButton?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setSearchOpen(!!searchPanel?.hidden, true);
    });

    searchInput?.addEventListener("input", filterSearch);
    searchResults.forEach((button) => {
      button.addEventListener("click", () => {
        const zh = button.dataset.searchStatusZh || "已定位到搜索结果";
        const en = button.dataset.searchStatusEn || "Search result located";
        setComposerStatus(zh, en);
        toast(currentLocale() === "en" ? en : zh);
        setSearchOpen(false, true);
      });
    });

    document.addEventListener("click", (event) => {
      if (!searchPanel || searchPanel.hidden) return;
      if (searchPanel.contains(event.target) || searchButton?.contains(event.target)) return;
      setSearchOpen(false, false);
    });
    document.addEventListener("keydown", (event) => {
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "k") {
        event.preventDefault();
        setSearchOpen(true, true);
      } else if (event.key === "Escape" && searchPanel && !searchPanel.hidden) {
        event.preventDefault();
        setSearchOpen(false, true);
      }
    });
    document.addEventListener("localechange", () => {
      setCollapseLabel(shell?.classList.contains("sidebar-collapsed"));
    });
  }

  function setupShellViews() {
    const views = Array.from(document.querySelectorAll("[data-shell-view]"));
    const navLinks = Array.from(document.querySelectorAll("[data-shell-view-target]"));
    if (!views.length || !navLinks.length) return;

    const STORE_VIEW = "crewon:desktop-shell-view";
    const keys = new Set(views.map((view) => view.dataset.shellView));

    function currentViewFromHash() {
      const match = window.location.hash.match(/^#view-([a-z-]+)$/);
      return match ? match[1] : "";
    }

    function viewTitle(view, locale) {
      return view?.dataset[`shellViewTitle${locale === "en" ? "En" : "Zh"}`] || view?.dataset.shellView || "";
    }

    function activateView(key, announce) {
      if (!keys.has(key)) return false;
      const locale = currentLocale();
      const activeView = views.find((view) => view.dataset.shellView === key);
      views.forEach((view) => {
        view.hidden = view !== activeView;
        view.classList.toggle("active", view === activeView);
      });
      navLinks.forEach((link) => {
        const active = link.dataset.shellViewTarget === key;
        link.classList.toggle("active", active);
        if (active) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      });
      document.querySelectorAll("[data-sidebar-shell]").forEach((sidebar) => {
        sidebar.dataset.sidebarCurrent = key;
      });
      try { localStorage.setItem(STORE_VIEW, key); } catch (_) {}
      if (window.location.hash !== `#view-${key}`) {
        try { window.history.replaceState(null, "", `#view-${key}`); } catch (_) {}
      }
      if (announce && activeView) {
        const zh = `已切换到${viewTitle(activeView, "zh")} · 侧栏保持不变`;
        const en = `Switched to ${viewTitle(activeView, "en")} · sidebar persisted`;
        setComposerStatus(zh, en);
        toast(locale === "en" ? en : zh);
      }
      return true;
    }

    navLinks.forEach((link) => {
      link.addEventListener("click", (event) => {
        const key = link.dataset.shellViewTarget || "";
        if (!keys.has(key)) return;
        event.preventDefault();
        activateView(key, true);
      });
    });

    let saved = "";
    try { saved = localStorage.getItem(STORE_VIEW) || ""; } catch (_) {}
    const initial = currentViewFromHash() || (keys.has(saved) ? saved : "") || "command";
    activateView(keys.has(initial) ? initial : "command", false);

    window.addEventListener("hashchange", () => {
      const key = currentViewFromHash();
      if (keys.has(key)) activateView(key, true);
    });
  }

  function selectedCopy(select) {
    const option = select?.selectedOptions?.[0];
    const text = option?.textContent?.trim() || "";
    return {
      zh: option?.dataset.zh || text,
      en: option?.dataset.en || text
    };
  }

  function setupComposerControls() {
    const modeSelect = document.querySelector("[data-task-mode]");
    const modelSelect = document.querySelector("[data-model-select]");
    const permissionSelect = document.querySelector("[data-permission-select]");
    const agentMenu = document.querySelector("[data-agent-menu]");
    const agentSelect = document.querySelector("[data-agent-select]");
    const workspaceSelect = document.querySelector("[data-workspace-select]");
    const composer = document.querySelector("[data-composer]");

    function setupEnhancedSelect(select) {
      const wrap = select.closest(".control-select, .workspace-picker");
      if (!wrap || wrap.dataset.enhancedSelect === "true") return;

      wrap.dataset.enhancedSelect = "true";
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "select-trigger";
      trigger.setAttribute("aria-haspopup", "listbox");
      trigger.setAttribute("aria-expanded", "false");
      trigger.setAttribute("aria-label", select.getAttribute("aria-label") || wrap.getAttribute("aria-label") || "选择");

      const menu = document.createElement("div");
      menu.className = "select-menu";
      menu.hidden = true;
      menu.setAttribute("role", "listbox");

      Array.from(select.options).forEach((option) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "select-option";
        item.dataset.value = option.value;
        if (option.dataset.zh) item.dataset.zh = option.dataset.zh;
        if (option.dataset.en) item.dataset.en = option.dataset.en;
        item.setAttribute("role", "option");
        menu.appendChild(item);
      });

      wrap.insertBefore(trigger, select);
      wrap.appendChild(menu);

      function copyForOption(option) {
        const text = option?.textContent?.trim() || "";
        return currentLocale() === "en" ? (option?.dataset.en || text) : (option?.dataset.zh || text);
      }

      function closeMenu() {
        menu.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
      }

      function openMenu() {
        document.querySelectorAll(".select-menu").forEach((node) => {
          if (node !== menu) {
            node.hidden = true;
            node.parentElement?.querySelector(".select-trigger")?.setAttribute("aria-expanded", "false");
          }
        });
        menu.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
        const selected = menu.querySelector('[aria-selected="true"]') || menu.querySelector(".select-option");
        window.setTimeout(() => selected?.focus(), 0);
      }

      function syncVisual() {
        const selectedOption = select.selectedOptions?.[0] || select.options[0];
        trigger.textContent = copyForOption(selectedOption);
        Array.from(menu.querySelectorAll(".select-option")).forEach((item) => {
          const option = Array.from(select.options).find((entry) => entry.value === item.dataset.value);
          item.textContent = copyForOption(option);
          item.setAttribute("aria-selected", item.dataset.value === select.value ? "true" : "false");
        });
      }

      trigger.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (menu.hidden) openMenu();
        else closeMenu();
      });
      trigger.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openMenu();
        }
      });
      menu.addEventListener("click", (event) => {
        const item = event.target.closest(".select-option");
        if (!item) return;
        select.value = item.dataset.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        syncVisual();
        closeMenu();
        trigger.focus();
      });
      menu.addEventListener("keydown", (event) => {
        const items = Array.from(menu.querySelectorAll(".select-option"));
        const index = items.indexOf(document.activeElement);
        if (event.key === "Escape") {
          event.preventDefault();
          closeMenu();
          trigger.focus();
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          (items[index + 1] || items[0])?.focus();
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          (items[index - 1] || items[items.length - 1])?.focus();
        }
      });
      document.addEventListener("click", (event) => {
        if (!wrap.contains(event.target)) closeMenu();
      });
      document.addEventListener("localechange", syncVisual);
      select.addEventListener("change", syncVisual);
      syncVisual();
    }

    const enhancedSelects = new Set([
      modeSelect,
      modelSelect,
      agentSelect,
      permissionSelect,
      workspaceSelect,
      ...document.querySelectorAll(".control-select select, .workspace-picker select")
    ]);
    enhancedSelects.forEach((select) => {
      if (select) setupEnhancedSelect(select);
    });

    if (modeSelect) {
      const modeCopy = {
        plan: {
          zh: "计划模式会先生成 Workflow、风险和 Gate。",
          en: "Plan mode drafts Workflow, risks, and gates first.",
          placeholderZh: "把这个需求拆成 Workflow 节点、角色分工和 Stage Gate。@ 引用上下文，/ 搜索 Skill 和 MCP。",
          placeholderEn: "Turn this into Workflow nodes, role split, and Stage Gates. @ context, / search Skills and MCP."
        },
        goal: {
          zh: "目标模式会先确认交付结果，再反推小队配置。",
          en: "Goal mode defines the outcome first, then derives team setup.",
          placeholderZh: "我的目标是... 请帮我反推 Agent 小队、权限边界和验收标准。@ 引用上下文，/ 搜索 Skill 和 MCP。",
          placeholderEn: "My goal is... Help derive Agent team, access boundary, and acceptance criteria. @ context, / search Skills and MCP."
        },
        agent: {
          zh: "智能体模式会使用角色配置、能力权限和审批卡点。",
          en: "Agent mode uses role config, tool access, and approval gates.",
          placeholderZh: "调用选中的智能体，并按当前 Gate 与 Skill/MCP 权限推进任务。@ 引用上下文。",
          placeholderEn: "Use the selected Agent with current Gate and Skill/MCP access. @ context."
        }
      };

      function syncMode(showToast) {
        const copy = modeCopy[modeSelect.value] || modeCopy.plan;
        if (agentMenu) agentMenu.hidden = modeSelect.value !== "agent";
        if (composer) {
          composer.dataset.placeholderZh = copy.placeholderZh;
          composer.dataset.placeholderEn = copy.placeholderEn;
          composer.setAttribute("placeholder", currentLocale() === "en" ? copy.placeholderEn : copy.placeholderZh);
        }
        setComposerStatus(copy.zh, copy.en, modeSelect.closest(".command-input"));
        if (showToast) toast(currentLocale() === "en" ? copy.en : copy.zh);
      }

      modeSelect.addEventListener("change", () => syncMode(true));
      syncMode(false);
    }

    if (agentSelect) {
      agentSelect.addEventListener("change", () => {
        const copy = selectedCopy(agentSelect);
        setComposerStatus(`已使用智能体配置：${copy.zh}`, `Using agent config: ${copy.en}`, agentSelect.closest(".command-input"));
        toast(currentLocale() === "en" ? `Agent selected: ${copy.en}` : `已选择${copy.zh}`);
      });
    }

    if (modelSelect) {
      modelSelect.addEventListener("change", () => {
        const copy = selectedCopy(modelSelect);
        setComposerStatus(`模型选择：${copy.zh}`, `Model selected: ${copy.en}`, modelSelect.closest(".command-input"));
        toast(currentLocale() === "en" ? `Model selected: ${copy.en}` : `已选择${copy.zh}`);
      });
    }

    if (permissionSelect) {
      const permissionWrap = permissionSelect.closest(".permission-dropdown");
      function syncPermissionWarning() {
        permissionWrap?.classList.toggle("is-warning", permissionSelect.value === "full-access");
      }
      permissionSelect.addEventListener("change", () => {
        const copy = selectedCopy(permissionSelect);
        syncPermissionWarning();
        setComposerStatus(`权限策略：${copy.zh}`, `Access policy: ${copy.en}`, permissionSelect.closest(".command-input"));
        toast(currentLocale() === "en" ? `Access set: ${copy.en}` : `权限已设为${copy.zh}`);
      });
      syncPermissionWarning();
    }

    if (workspaceSelect) {
      workspaceSelect.addEventListener("change", () => {
        const copy = selectedCopy(workspaceSelect);
        document.querySelectorAll(".space-node").forEach((node) => {
          const label = node.querySelector(".space-title strong")?.dataset.zh || "";
          const active = label === copy.zh;
          node.classList.toggle("current", active);
        });
        setComposerStatus(`新任务将创建到：${copy.zh}`, `New task will be created in: ${copy.en}`, workspaceSelect.closest(".command-input"));
        toast(currentLocale() === "en" ? `Workspace: ${copy.en}` : `工作空间：${copy.zh}`);
      });
    }

    document.querySelectorAll(".command-input").forEach((root) => {
      const scopedComposer = root.querySelector("[data-composer]");
      if (!scopedComposer || scopedComposer === composer) return;

      const scopedMode = root.querySelector("[data-task-mode]");
      const scopedModel = root.querySelector("[data-model-select]");
      const scopedPermission = root.querySelector("[data-permission-select]");
      const scopedAgentMenu = root.querySelector("[data-agent-menu]");
      const scopedAgent = root.querySelector("[data-agent-select]");
      const scopedModeCopy = {
        plan: {
          zh: "计划模式会先生成 Workflow、风险和 Gate。",
          en: "Plan mode drafts Workflow, risks, and gates first.",
          placeholderZh: "把这个需求拆成 Workflow 节点、角色分工和 Stage Gate。@ 引用上下文，/ 搜索 Skill 和 MCP。",
          placeholderEn: "Turn this into Workflow nodes, role split, and Stage Gates. @ context, / search Skills and MCP."
        },
        goal: {
          zh: "目标模式会先确认交付结果，再反推小队配置。",
          en: "Goal mode defines the outcome first, then derives team setup.",
          placeholderZh: "我的目标是... 请帮我反推 Agent 小队、权限边界和验收标准。@ 引用上下文，/ 搜索 Skill 和 MCP。",
          placeholderEn: "My goal is... Help derive Agent team, access boundary, and acceptance criteria. @ context."
        },
        agent: {
          zh: "智能体模式会使用角色配置、能力权限和审批卡点。",
          en: "Agent mode uses role config, tool access, and approval gates.",
          placeholderZh: "调用选中的智能体，并按当前 Gate 与 Skill/MCP 权限推进任务。@ 引用上下文。",
          placeholderEn: "Use the selected Agent with current Gate and Skill/MCP access. @ context."
        }
      };

      if (scopedMode && scopedMode.dataset.composerBound !== "true") {
        scopedMode.dataset.composerBound = "true";
        function syncScopedMode(showToast) {
          const copy = scopedModeCopy[scopedMode.value] || scopedModeCopy.plan;
          if (scopedAgentMenu) scopedAgentMenu.hidden = scopedMode.value !== "agent";
          scopedComposer.dataset.placeholderZh = copy.placeholderZh;
          scopedComposer.dataset.placeholderEn = copy.placeholderEn;
          scopedComposer.setAttribute("placeholder", currentLocale() === "en" ? copy.placeholderEn : copy.placeholderZh);
          setComposerStatus(copy.zh, copy.en, root);
          if (showToast) toast(currentLocale() === "en" ? copy.en : copy.zh);
        }
        scopedMode.addEventListener("change", () => syncScopedMode(true));
        syncScopedMode(false);
      }

      if (scopedAgent && scopedAgent.dataset.composerBound !== "true") {
        scopedAgent.dataset.composerBound = "true";
        scopedAgent.addEventListener("change", () => {
          const copy = selectedCopy(scopedAgent);
          setComposerStatus(`已使用智能体配置：${copy.zh}`, `Using agent config: ${copy.en}`, root);
          toast(currentLocale() === "en" ? `Agent selected: ${copy.en}` : `已选择${copy.zh}`);
        });
      }

      if (scopedModel && scopedModel.dataset.composerBound !== "true") {
        scopedModel.dataset.composerBound = "true";
        scopedModel.addEventListener("change", () => {
          const copy = selectedCopy(scopedModel);
          setComposerStatus(`模型选择：${copy.zh}`, `Model selected: ${copy.en}`, root);
          toast(currentLocale() === "en" ? `Model selected: ${copy.en}` : `已选择${copy.zh}`);
        });
      }

      if (scopedPermission && scopedPermission.dataset.composerBound !== "true") {
        scopedPermission.dataset.composerBound = "true";
        const scopedPermissionWrap = scopedPermission.closest(".permission-dropdown");
        function syncScopedPermissionWarning() {
          scopedPermissionWrap?.classList.toggle("is-warning", scopedPermission.value === "full-access");
        }
        scopedPermission.addEventListener("change", () => {
          const copy = selectedCopy(scopedPermission);
          syncScopedPermissionWarning();
          setComposerStatus(`权限策略：${copy.zh}`, `Access policy: ${copy.en}`, root);
          toast(currentLocale() === "en" ? `Access set: ${copy.en}` : `权限已设为${copy.zh}`);
        });
        syncScopedPermissionWarning();
      }
    });
  }

  function setupSlashPalette() {
    document.querySelectorAll(".command-input").forEach((root) => {
      const composer = root.querySelector("[data-composer]");
      const palette = root.querySelector("[data-slash-palette]");
      const openButton = root.querySelector("[data-slash-open]");
      if (!composer || !palette || palette.dataset.composerBound === "true") return;
      palette.dataset.composerBound = "true";

      const search = palette.querySelector("[data-slash-search]");
      const items = Array.from(palette.querySelectorAll("[data-slash-item]"));

      function filterItems() {
        const query = (search?.value || "").trim().toLowerCase();
        items.forEach((item) => {
          const haystack = `${item.textContent} ${item.dataset.kind || ""} ${item.dataset.label || ""}`.toLowerCase();
          item.hidden = query.length > 0 && !haystack.includes(query);
        });
      }

      function openPalette(initialQuery) {
        document.querySelectorAll("[data-slash-palette], [data-context-palette]").forEach((node) => {
          if (node !== palette) node.hidden = true;
        });
        palette.hidden = false;
        if (search) {
          search.value = initialQuery || "";
          filterItems();
          window.setTimeout(() => search.focus(), 0);
        }
      }

      function closePalette() {
        palette.hidden = true;
        if (search) search.value = "";
        items.forEach((item) => { item.hidden = false; });
      }

      function insertItem(item) {
        const label = item.dataset.label || item.textContent.trim();
        const prefix = composer.value.trim() ? " " : "";
        const insertText = `${prefix}/${label} `;
        const start = composer.selectionStart ?? composer.value.length;
        const end = composer.selectionEnd ?? composer.value.length;
        composer.value = `${composer.value.slice(0, start)}${insertText}${composer.value.slice(end)}`;
        composer.focus();
        const next = start + insertText.length;
        composer.setSelectionRange(next, next);
        closePalette();
        const kind = item.dataset.kind === "mcp" ? "MCP" : "Skill";
        setComposerStatus(`已插入 ${kind}：${label}`, `Inserted ${kind}: ${label}`, root);
        toast(currentLocale() === "en" ? `${kind} inserted` : `${kind} 已插入`);
      }

      openButton?.addEventListener("click", () => openPalette(""));
      composer.addEventListener("keydown", (event) => {
        if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          openPalette("");
        }
      });
      composer.addEventListener("beforeinput", (event) => {
        if (event.inputType === "insertText" && event.data === "/") {
          event.preventDefault();
          openPalette("");
        }
      });
      search?.addEventListener("input", filterItems);
      search?.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closePalette();
          composer.focus();
        }
        if (event.key === "Enter") {
          const first = items.find((item) => !item.hidden);
          if (first) {
            event.preventDefault();
            insertItem(first);
          }
        }
      });
      items.forEach((item) => item.addEventListener("click", () => insertItem(item)));
      document.addEventListener("click", (event) => {
        if (palette.hidden) return;
        const target = event.target;
        if (target instanceof Node && !palette.contains(target) && target !== openButton && target !== composer) {
          closePalette();
        }
      });
    });
  }

  function setupContextPalette() {
    document.querySelectorAll(".command-input").forEach((root) => {
      const composer = root.querySelector("[data-composer]");
      const palette = root.querySelector("[data-context-palette]");
      const openButton = root.querySelector("[data-context-open]");
      if (!composer || !palette || palette.dataset.composerBound === "true") return;
      palette.dataset.composerBound = "true";

      const search = palette.querySelector("[data-context-search]");
      const items = Array.from(palette.querySelectorAll("[data-context-item]"));

      function filterItems() {
        const query = (search?.value || "").trim().toLowerCase();
        items.forEach((item) => {
          const haystack = `${item.textContent} ${item.dataset.kind || ""} ${item.dataset.label || ""}`.toLowerCase();
          item.hidden = query.length > 0 && !haystack.includes(query);
        });
      }

      function openPalette(initialQuery) {
        document.querySelectorAll("[data-slash-palette], [data-context-palette]").forEach((node) => {
          if (node !== palette) node.hidden = true;
        });
        palette.hidden = false;
        if (search) {
          search.value = initialQuery || "";
          filterItems();
          window.setTimeout(() => search.focus(), 0);
        }
      }

      function closePalette() {
        palette.hidden = true;
        if (search) search.value = "";
        items.forEach((item) => { item.hidden = false; });
      }

      function insertItem(item) {
        const label = item.dataset.label || item.textContent.trim();
        const prefix = composer.value.trim() ? " " : "";
        const insertText = `${prefix}@${label} `;
        const start = composer.selectionStart ?? composer.value.length;
        const end = composer.selectionEnd ?? composer.value.length;
        composer.value = `${composer.value.slice(0, start)}${insertText}${composer.value.slice(end)}`;
        composer.focus();
        const next = start + insertText.length;
        composer.setSelectionRange(next, next);
        closePalette();
        setComposerStatus(`已引用上下文：${label}`, `Context referenced: ${label}`, root);
        toast(currentLocale() === "en" ? "Context added" : "已引用上下文");
      }

      openButton?.addEventListener("click", () => openPalette(""));
      composer.addEventListener("keydown", (event) => {
        if (event.key === "@" && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          openPalette("");
        }
      });
      composer.addEventListener("beforeinput", (event) => {
        if (event.inputType === "insertText" && event.data === "@") {
          event.preventDefault();
          openPalette("");
        }
      });
      search?.addEventListener("input", filterItems);
      search?.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closePalette();
          composer.focus();
        }
        if (event.key === "Enter") {
          const first = items.find((item) => !item.hidden);
          if (first) {
            event.preventDefault();
            insertItem(first);
          }
        }
      });
      items.forEach((item) => item.addEventListener("click", () => insertItem(item)));
      document.addEventListener("click", (event) => {
        if (palette.hidden) return;
        const target = event.target;
        if (target instanceof Node && !palette.contains(target) && target !== openButton && target !== composer) {
          closePalette();
        }
      });
    });
  }

  function applyCardVisibility(scope) {
    const activeFilters = Array.from(scope.querySelectorAll(".filter-chip[data-filter].active"))
      .map((chip) => chip.dataset.filter)
      .filter((filter) => filter && filter !== "all");
    const search = scope.querySelector(".catalog-search input");
    const query = (search?.value || "").trim().toLowerCase();
    const cards = scope.querySelectorAll("[data-card-filter]");
    let visibleCount = 0;
    cards.forEach((card) => {
      const values = (card.dataset.cardFilter || "").split(" ");
      const matchesFilter = activeFilters.every((filter) => values.includes(filter));
      const matchesSearch = !query || (card.innerText || card.textContent || "").toLowerCase().includes(query);
      const visible = matchesFilter && matchesSearch;
      card.classList.toggle("hidden", !visible);
      if (visible) visibleCount += 1;
    });
    if (!cards.length) return;
    let empty = scope.querySelector("[data-filter-empty]");
    if (!empty) {
      empty = document.createElement("div");
      empty.className = "filter-empty-state";
      empty.dataset.filterEmpty = "";
      empty.dataset.zh = "没有匹配项";
      empty.dataset.en = "No matches";
      empty.setAttribute("role", "status");
      empty.setAttribute("aria-live", "polite");
      const anchor = cards[cards.length - 1].parentElement;
      anchor?.after(empty);
    }
    empty.textContent = currentLocale() === "en" ? empty.dataset.en : empty.dataset.zh;
    empty.hidden = visibleCount > 0;
    empty.classList.toggle("visible", visibleCount === 0);
  }

  function setupFilters() {
    function syncFilterAria(scope) {
      scope.querySelectorAll?.(".filter-chip[data-filter]").forEach((chip) => {
        chip.setAttribute("aria-pressed", chip.classList.contains("active") ? "true" : "false");
      });
    }
    function syncTeamActions(scope) {
      const actions = scope.querySelectorAll?.("[data-team-action]");
      if (!actions || !actions.length) return;
      const activeTeamMode = scope.querySelector('.filter-chip.active[data-filter-group="team-mode"]')?.dataset.filter || "office";
      actions.forEach((button) => {
        button.hidden = button.dataset.teamAction !== activeTeamMode;
      });
    }
    document.querySelectorAll(".filter-chip[data-filter]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const scope = chip.closest("[data-filter-scope]") || chip.closest("[data-shell-view]") || chip.closest(".page-stack") || document;
        const group = chip.dataset.filterGroup || "default";
        const chips = scope.querySelectorAll(`.filter-chip[data-filter][data-filter-group="${group}"], .filter-chip[data-filter]:not([data-filter-group])`);
        chips.forEach((item) => item.classList.toggle("active", item === chip));
        syncFilterAria(scope);
        applyCardVisibility(scope);
        syncTeamActions(scope);
      });
    });
    document.querySelectorAll("[data-filter-scope]").forEach((scope) => {
      syncFilterAria(scope);
      applyCardVisibility(scope);
      syncTeamActions(scope);
    });
  }

  function setupCatalogSearch() {
    document.querySelectorAll(".catalog-search input").forEach((input) => {
      input.addEventListener("input", () => {
        const scope = input.closest("[data-filter-scope]") || input.closest("[data-shell-view]") || input.closest(".page-stack") || document;
        applyCardVisibility(scope);
      });
    });
  }

  function setupCalendarA11y() {
    document.querySelectorAll(".calendar-month").forEach((month) => {
      const title = month.querySelector(".calendar-month-head strong")?.textContent?.trim() || "";
      const scope = month.querySelector(".calendar-month-head span")?.textContent?.trim() || "";
      month.querySelectorAll(".calendar-grid button").forEach((button) => {
        const day = button.textContent.trim();
        const hasEvent = button.classList.contains("has-event");
        const selected = button.classList.contains("is-selected");
        button.setAttribute("aria-label", `${scope} ${title} ${day} 日${selected ? "，当前选择" : ""}${hasEvent ? "，有安排" : "，无安排"}`);
        if (selected) button.setAttribute("aria-current", "date");
        else button.removeAttribute("aria-current");
      });
    });
  }

  function setupModals() {
    let activeModal = null;
    let lastTrigger = null;
    const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusableElements = (modal) => Array.from(modal.querySelectorAll(focusableSelector))
      .filter((el) => !el.hidden && el.offsetParent !== null);

    function openModal(modal, trigger) {
      activeModal = modal;
      lastTrigger = trigger;
      modal.classList.add("open");
      modal.setAttribute("tabindex", "-1");
      document.body.classList.add("modal-open");
      window.setTimeout(() => {
        const preferred = modal.querySelector("input, textarea, select, .space-input, button:not([data-close-modal])");
        const first = preferred || focusableElements(modal)[0] || modal;
        first.focus?.({ preventScroll: true });
      }, 0);
    }

    function closeModal(modal = activeModal, restoreFocus = true) {
      if (!modal) return;
      modal.classList.remove("open");
      if (activeModal === modal) activeModal = null;
      if (!document.querySelector(".modal-backdrop.open")) document.body.classList.remove("modal-open");
      if (restoreFocus && lastTrigger) {
        window.setTimeout(() => lastTrigger.focus?.({ preventScroll: true }), 0);
      }
    }

    document.querySelectorAll("[data-open-modal]").forEach((button) => {
      button.addEventListener("click", () => {
        const modal = document.querySelector(button.dataset.openModal);
        if (modal) openModal(modal, button);
      });
    });
    document.querySelectorAll("[data-close-modal]").forEach((button) => {
      button.addEventListener("click", () => {
        closeModal(button.closest(".modal-backdrop"));
      });
    });
    document.querySelectorAll(".modal-backdrop").forEach((modal) => {
      modal.addEventListener("click", (event) => {
        if (event.target === modal) closeModal(modal);
      });
    });
    document.addEventListener("keydown", (event) => {
      if (!activeModal) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal(activeModal);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusableElements(activeModal);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    document.querySelectorAll("[data-submit-task]").forEach((button) => {
      button.addEventListener("click", () => {
        closeModal(button.closest(".modal-backdrop"));
        const locale = currentLocale();
        const message = locale === "en"
          ? (button.dataset.submitToastEn || "Task added to workspace")
          : (button.dataset.submitToastZh || "任务已加入工作空间");
        toast(message);
      });
    });
  }

  function setupOfficeRooms() {
    document.querySelectorAll("[data-office-shell]").forEach((shell) => {
      const list = shell.querySelector("[data-office-list]");
      const room = shell.querySelector("[data-office-room]");
      const view = shell.closest("[data-shell-view]");
      if (!list || !room) return;

      function closeDrawers() {
        room.querySelectorAll("[data-office-drawer]").forEach((drawer) => { drawer.hidden = true; });
        room.querySelectorAll("[data-office-drawer-open]").forEach((button) => {
          button.setAttribute("aria-expanded", "false");
        });
      }

      shell.querySelectorAll("[data-office-open]").forEach((button) => {
        button.addEventListener("click", () => {
          const locale = currentLocale();
          const titleZh = button.dataset.officeTitleZh || button.textContent.trim();
          const titleEn = button.dataset.officeTitleEn || titleZh;
          const subtitleZh = button.dataset.officeSubtitleZh || "";
          const subtitleEn = button.dataset.officeSubtitleEn || subtitleZh;
          const titleNode = room.querySelector("[data-office-title]");
          const subtitleNode = room.querySelector("[data-office-subtitle]");

          shell.querySelectorAll("[data-office-open]").forEach((item) => {
            item.classList.toggle("is-active", item === button);
          });
          if (titleNode) {
            titleNode.dataset.zh = titleZh;
            titleNode.dataset.en = titleEn;
            titleNode.textContent = locale === "en" ? titleEn : titleZh;
          }
          if (subtitleNode) {
            subtitleNode.dataset.zh = subtitleZh;
            subtitleNode.dataset.en = subtitleEn;
            subtitleNode.textContent = locale === "en" ? subtitleEn : subtitleZh;
          }

          list.hidden = true;
          room.hidden = false;
          shell.classList.add("is-room-open");
          view?.classList.add("office-room-active");
          closeDrawers();
          window.setTimeout(() => {
            room.querySelector("[data-office-focus]")?.focus({ preventScroll: true });
          }, 0);
        });
      });

      shell.querySelectorAll("[data-office-back]").forEach((button) => {
        button.addEventListener("click", () => {
          room.hidden = true;
          list.hidden = false;
          shell.classList.remove("is-room-open");
          view?.classList.remove("office-room-active");
          closeDrawers();
          window.setTimeout(() => {
            shell.querySelector("[data-office-open].is-active")?.focus({ preventScroll: true });
          }, 0);
        });
      });

      room.querySelectorAll("[data-office-drawer-open]").forEach((button) => {
        button.addEventListener("click", () => {
          const target = button.dataset.officeDrawerOpen || "";
          const drawer = room.querySelector(`[data-office-drawer="${target}"]`);
          if (!drawer) return;
          const nextOpen = drawer.hidden;
          closeDrawers();
          drawer.hidden = !nextOpen;
          button.setAttribute("aria-expanded", nextOpen ? "true" : "false");
        });
      });

      room.querySelectorAll("[data-office-drawer-close]").forEach((button) => {
        button.addEventListener("click", closeDrawers);
      });
    });
  }

  function setupWorkflowRooms() {
    document.querySelectorAll("[data-workflow-shell]").forEach((shell) => {
      const list = shell.querySelector("[data-workflow-list]");
      const room = shell.querySelector("[data-workflow-room]");
      const view = shell.closest("[data-shell-view]");
      if (!list || !room) return;

      function closeWorkflowDrawers() {
        room.querySelectorAll("[data-workflow-drawer]").forEach((drawer) => { drawer.hidden = true; });
        room.querySelectorAll("[data-workflow-drawer-open]").forEach((button) => {
          button.setAttribute("aria-expanded", "false");
        });
      }

      shell.querySelectorAll("[data-workflow-open]").forEach((button) => {
        button.addEventListener("click", () => {
          const locale = currentLocale();
          const titleZh = button.dataset.workflowTitleZh || button.textContent.trim();
          const titleEn = button.dataset.workflowTitleEn || titleZh;
          const stageZh = button.dataset.workflowStageZh || "";
          const stageEn = button.dataset.workflowStageEn || stageZh;
          const titleNode = room.querySelector("[data-workflow-title]");
          const stageNode = room.querySelector("[data-workflow-stage]");

          shell.querySelectorAll("[data-workflow-open]").forEach((item) => {
            item.classList.toggle("is-active", item === button);
          });
          if (titleNode) {
            titleNode.dataset.zh = titleZh;
            titleNode.dataset.en = titleEn;
            titleNode.textContent = locale === "en" ? titleEn : titleZh;
          }
          if (stageNode) {
            stageNode.dataset.zh = stageZh;
            stageNode.dataset.en = stageEn;
            stageNode.textContent = locale === "en" ? stageEn : stageZh;
          }

          list.hidden = true;
          room.hidden = false;
          shell.classList.add("is-room-open");
          view?.classList.add("workflow-room-active");
          closeWorkflowDrawers();
          window.setTimeout(() => {
            room.querySelector("[data-workflow-focus]")?.focus({ preventScroll: true });
          }, 0);
        });
      });

      shell.querySelectorAll("[data-workflow-back]").forEach((button) => {
        button.addEventListener("click", () => {
          room.hidden = true;
          list.hidden = false;
          shell.classList.remove("is-room-open");
          view?.classList.remove("workflow-room-active");
          closeWorkflowDrawers();
          window.setTimeout(() => {
            shell.querySelector("[data-workflow-open].is-active")?.focus({ preventScroll: true });
          }, 0);
        });
      });

      room.querySelectorAll("[data-workflow-drawer-open]").forEach((button) => {
        button.addEventListener("click", () => {
          const target = button.dataset.workflowDrawerOpen || "";
          const drawer = room.querySelector(`[data-workflow-drawer="${target}"]`);
          if (!drawer) return;
          const nextOpen = drawer.hidden;
          closeWorkflowDrawers();
          drawer.hidden = !nextOpen;
          button.setAttribute("aria-expanded", nextOpen ? "true" : "false");
        });
      });

      room.querySelectorAll("[data-workflow-drawer-close]").forEach((button) => {
        button.addEventListener("click", closeWorkflowDrawers);
      });
    });
  }

  function setupAutomation() {
    document.querySelectorAll(".switch").forEach((button) => {
      button.addEventListener("click", () => {
        const next = button.getAttribute("aria-pressed") !== "true";
        button.setAttribute("aria-pressed", String(next));
        const locale = currentLocale();
        toast(next ? (locale === "en" ? "Enabled" : "已开启") : (locale === "en" ? "Disabled" : "已关闭"));
      });
    });
  }

  function setupCopy() {
    document.querySelectorAll("[data-copy]").forEach((button) => {
      button.addEventListener("click", async () => {
        const target = document.querySelector(button.dataset.copy);
        const text = target ? target.innerText : button.dataset.copyText || "";
        try {
          await navigator.clipboard.writeText(text);
          toast(currentLocale() === "en" ? "Copied to clipboard" : "已复制到剪贴板");
        } catch (_) {
          toast(currentLocale() === "en" ? "Copy is not available here; content remains selectable" : "当前环境不支持复制，内容已保持可选中");
        }
      });
    });
  }

  function setupMobileTaskCreate() {
    document.querySelectorAll("[data-mobile-create]").forEach((button) => {
      button.addEventListener("click", () => {
        const list = document.querySelector("#mobile-activity");
        const locale = currentLocale();
        if (list) {
          const row = document.createElement("div");
          row.className = "activity-row";
          row.innerHTML = locale === "en"
            ? '<div class="task-top"><strong>Task draft created</strong><span class="status success">Ready to plan</span></div><p>Crewon has prepared a workspace draft with project, agent, and schedule suggestions.</p>'
            : '<div class="task-top"><strong>任务草稿已创建</strong><span class="status success">可继续规划</span></div><p>Crewon 已准备工作空间草稿，并补上项目、智能体和日程安排建议。</p>';
          list.prepend(row);
        }
        toast(locale === "en" ? "Mobile task draft created" : "移动端任务草稿已创建");
      });
    });
  }

  function setupMobileTabs() {
    document.querySelectorAll("[data-mobile-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        const target = button.dataset.target;
        if (target) {
          document.querySelectorAll("[data-mobile-panel]").forEach((panel) => {
            panel.classList.toggle("active", panel.dataset.mobilePanel === target);
          });
          document.querySelectorAll("[data-mobile-tab]").forEach((item) => {
            item.classList.toggle("active", item.dataset.target === target);
          });
        } else {
          document.querySelectorAll("[data-mobile-tab]").forEach((item) => item.classList.toggle("active", item === button));
        }
        const locale = currentLocale();
        const labelNode = button.dataset.zh ? button : button.querySelector("[data-zh][data-en]");
        const label = labelNode ? (locale === "en" ? labelNode.dataset.en : labelNode.dataset.zh) : "";
        toast(locale === "en" ? `${label} tab selected` : `已切换到${label}`);
      });
    });
  }

  function setupDismissibles() {
    document.querySelectorAll("[data-dismiss]").forEach((button) => {
      button.addEventListener("click", () => {
        const target = document.querySelector(button.dataset.dismiss || "");
        if (target) target.hidden = true;
      });
    });
  }

  function setupSceneTabs() {
    document.querySelectorAll(".scene-tabs").forEach((group) => {
      const scope = group.closest(".hero-center") || document;
      const scenarioButtons = Array.from(scope.querySelectorAll(".quick-row [data-scene]"));
      function syncScenarios(button) {
        const scene = button.dataset.sceneTarget;
        if (!scene || !scenarioButtons.length) return;
        scenarioButtons.forEach((item) => {
          item.classList.toggle("is-hidden", item.dataset.scene !== scene);
        });
      }
      group.querySelectorAll("button").forEach((button) => {
        button.setAttribute("aria-pressed", button.classList.contains("active") ? "true" : "false");
        if (button.classList.contains("active")) syncScenarios(button);
        button.addEventListener("click", () => {
          group.querySelectorAll("button").forEach((item) => {
            const active = item === button;
            item.classList.toggle("active", active);
            item.setAttribute("aria-pressed", active ? "true" : "false");
          });
          syncScenarios(button);
        });
      });
    });
  }

  function setupWorkspaceTree() {
    document.querySelectorAll(".space-title").forEach((button) => {
      button.addEventListener("click", () => {
        const node = button.closest(".space-node");
        const marker = button.querySelector("span");
        if (!node) return;
        node.classList.toggle("collapsed");
        if (marker) marker.textContent = node.classList.contains("collapsed") ? "›" : "⌄";
      });
    });

    document.querySelectorAll(".conversation-item").forEach((button) => {
      button.addEventListener("click", () => {
        const tree = button.closest(".space-tree");
        const node = button.closest(".space-node");
        const workspace = document.querySelector("[data-workspace-select], .workspace-select");
        if (tree) {
          tree.querySelectorAll(".conversation-item").forEach((item) => item.classList.toggle("active", item === button));
          tree.querySelectorAll(".space-node").forEach((item) => item.classList.toggle("current", item === node));
        }
        if (workspace && node) {
          const spaceLabel = node.querySelector(".space-title strong");
          const zhSpace = spaceLabel?.dataset.zh || spaceLabel?.textContent.trim() || "";
          const enSpace = spaceLabel?.dataset.en || zhSpace;
          const zhConversation = button.dataset.zh || button.textContent.trim();
          const enConversation = button.dataset.en || zhConversation;
          if (workspace.tagName === "SELECT") {
            const value = zhSpace.includes("办公室") ? "team" : (zhSpace.includes("Skill") || zhSpace.includes("MCP") ? "agents" : "product");
            workspace.value = value;
            workspace.dispatchEvent(new Event("change", { bubbles: true }));
            setComposerStatus(`当前会话：${zhSpace} / ${zhConversation}`, `Current conversation: ${enSpace} / ${enConversation}`);
          } else {
            workspace.dataset.zh = `${zhSpace} / ${zhConversation}`;
            workspace.dataset.en = `${enSpace} / ${enConversation}`;
            workspace.textContent = currentLocale() === "en" ? workspace.dataset.en : workspace.dataset.zh;
          }
        }
      });
    });
  }

  function setupPanelTabs() {
    document.querySelectorAll("[data-tab-target]").forEach((button) => {
      button.addEventListener("click", () => {
        const scope = button.closest("[data-tab-scope]") || document;
        const target = button.dataset.tabTarget;
        scope.querySelectorAll("[data-tab-target]").forEach((item) => {
          const active = item === button;
          item.classList.toggle("active", active);
          item.setAttribute("aria-pressed", active ? "true" : "false");
          item.setAttribute("aria-selected", active ? "true" : "false");
        });
        scope.querySelectorAll("[data-tab-panel]").forEach((panel) => {
          panel.hidden = `#${panel.id}` !== target;
        });
      });
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    renderSharedSidebar();
    setupLocale();
    setupModeSwitch();
    setupTaskChecks();
    setupSidebarTools();
    setupShellViews();
    setupRunActions();
    setupComposerControls();
    setupContextPalette();
    setupSlashPalette();
    setupFilters();
    setupCatalogSearch();
    setupCalendarA11y();
    document.addEventListener("localechange", setupCalendarA11y);
    setupModals();
    setupOfficeRooms();
    setupWorkflowRooms();
    setupAutomation();
    setupCopy();
    setupDismissibles();
    setupMobileTaskCreate();
    setupMobileTabs();
    setupSceneTabs();
    setupWorkspaceTree();
    setupPanelTabs();
  });
})();
