import type React from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  readAgentPlatformSnapshot,
  type AgentPlatformSnapshot,
} from "../../lib/agent-platform/agentPlatformClient";
import type { ConnectionState } from "../../lib/shared/connectionState";
import type { WorkMode } from "../../lib/workMode";
import { originalCommandWindowHtml } from "./originalCommandWindowHtml";
import { originalSidebarHtml } from "./originalSidebarHtml";

type CommandWorkspaceProps = {
  composerValue: string;
  connectionState: ConnectionState;
  cwd: string;
  isSending: boolean;
  workMode: WorkMode;
  onAttachContext: () => void;
  onChangeComposerValue: (value: string) => void;
  onModeChange: (mode: WorkMode) => void;
  onRetryConnection: () => void;
  onSend: (text: string) => void;
};

type SlotItem = {
  label: string;
  title: string;
  detail: string;
  value: string;
};

type CommandHomeSlots = {
  agent: SlotItem;
  workflow: SlotItem;
  knowledge: SlotItem;
  skills: [SlotItem, SlotItem];
  mcps: [SlotItem, SlotItem];
  model: string;
};

const emptySnapshot: AgentPlatformSnapshot = {
  agents: [],
  knowledgeBases: [],
  skills: [],
  mcpServers: [],
  mcpTools: [],
  workflows: [],
};

const shellViewIds = [
  "command",
  "assist",
  "projects",
  "agents",
  "schedule",
  "team",
] as const;

type ShellViewId = (typeof shellViewIds)[number];

function isShellViewId(value: string): value is ShellViewId {
  return shellViewIds.includes(value as ShellViewId);
}

function shellViewFromHash() {
  if (typeof window === "undefined") {
    return "command";
  }
  const view = window.location.hash.replace(/^#view-/, "") || "command";
  return isShellViewId(view) ? view : "command";
}

const sidebarNav = [
  {
    key: "command",
    zh: "????",
    en: "New task",
    icon: '<svg viewBox="0 0 24 24"><path d="M6.5 5.5h11v13h-11Z"></path><path d="M12 9v6"></path><path d="M9 12h6"></path></svg>',
  },
  {
    key: "assist",
    zh: "??",
    en: "Assistant",
    icon: '<svg viewBox="0 0 24 24"><path d="m12 4.75 1.45 4.1 4.1 1.45-4.1 1.45L12 15.85l-1.45-4.1-4.1-1.45 4.1-1.45Z"></path><path d="m17.25 15.5.7 1.95 1.95.7-1.95.7-.7 1.95-.7-1.95-1.95-.7 1.95-.7Z"></path></svg>',
  },
  {
    key: "projects",
    zh: "??",
    en: "Projects",
    icon: '<svg viewBox="0 0 24 24"><path d="M4.75 7.5h5.5l1.45 2h7.55v7.8a1.7 1.7 0 0 1-1.7 1.7H6.45a1.7 1.7 0 0 1-1.7-1.7Z"></path><path d="M4.75 9.5h14.5"></path></svg>',
  },
  {
    key: "agents",
    zh: "???",
    en: "Agents",
    metaZh: "??????",
    metaEn: "Skills ? connectors",
    icon: '<svg viewBox="0 0 24 24"><path d="M12 6.1a2.35 2.35 0 1 0 0 4.7 2.35 2.35 0 0 0 0-4.7Z"></path><path d="M6.6 14.2a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 0 0 0-4.2Z"></path><path d="M17.4 14.2a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 0 0 0-4.2Z"></path><path d="M10.1 10.1 7.7 14.4"></path><path d="m13.9 10.1 2.4 4.3"></path></svg>',
  },
  {
    key: "schedule",
    zh: "????",
    en: "Schedule",
    metaZh: "?????",
    metaEn: "Plans ? reminders",
    icon: '<svg viewBox="0 0 24 24"><path d="M6.25 6.75h11.5a1.5 1.5 0 0 1 1.5 1.5v9.5a1.5 1.5 0 0 1-1.5 1.5H6.25a1.5 1.5 0 0 1-1.5-1.5v-9.5a1.5 1.5 0 0 1 1.5-1.5Z"></path><path d="M8.2 4.75v3.4"></path><path d="M15.8 4.75v3.4"></path><path d="M4.75 10.3h14.5"></path><path d="M8.1 13.7h3.2"></path><path d="M8.1 16.2h6.1"></path></svg>',
  },
  {
    key: "team",
    zh: "??",
    en: "Team",
    icon: '<svg viewBox="0 0 24 24"><path d="M9.8 11.4a3.15 3.15 0 1 0 0-6.3 3.15 3.15 0 0 0 0 6.3Z"></path><path d="M4.75 18.75c.65-3 2.35-4.55 5.05-4.55s4.4 1.55 5.05 4.55"></path><path d="M15.2 11.05a2.45 2.45 0 1 0 0-4.9"></path><path d="M15.6 14.35c1.95.35 3.1 1.8 3.65 4.4"></path></svg>',
  },
];

const knowledgeIcon = '<svg viewBox="0 0 24 24"><path d="M5.75 5.75h8.8a3.7 3.7 0 0 1 3.7 3.7v8.8H9.45a3.7 3.7 0 0 0-3.7-3.7Z"></path><path d="M5.75 5.75v12.5"></path><path d="M9.3 9.25h5.25"></path><path d="M9.3 12.25h4.1"></path></svg>';

function sidebarHtml(slots: CommandHomeSlots) {
  const nav = sidebarNav
    .map((item) => {
      const meta = item.metaZh
        ? `<em data-zh="${item.metaZh}" data-en="${item.metaEn}">${item.metaZh}</em>`
        : "";
      const active = item.key === "command" ? ' class="active" aria-current="page"' : "";
      return `<a${active} href="#view-${item.key}" data-shell-view-target="${item.key}" data-nav-key="${item.key}"><span class="nav-glyph" aria-hidden="true">${item.icon}</span><strong data-zh="${item.zh}" data-en="${item.en}">${item.zh}</strong>${meta}</a>`;
    })
    .join("");

  return `
    <div class="sidebar-topbar" data-od-id="desktop-sidebar-topbar">
      <div class="traffic" aria-hidden="true"><span class="dot close"></span><span class="dot min"></span><span class="dot max"></span></div>
      <div class="sidebar-tools" aria-label="????">
        <button class="sidebar-tool" type="button" aria-label="????" aria-pressed="false" data-sidebar-collapse data-od-id="sidebar-collapse-button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 5.5h13v13h-13Z"></path><path d="M10 5.5v13"></path><path d="m14.4 9.2-2.8 2.8 2.8 2.8"></path></svg>
        </button>
        <button class="sidebar-tool" type="button" aria-label="??" aria-expanded="false" aria-controls="sidebar-search-panel" data-sidebar-search-open data-od-id="sidebar-search-button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.8 16.1a5.3 5.3 0 1 0 0-10.6 5.3 5.3 0 0 0 0 10.6Z"></path><path d="m15 15 4 4"></path></svg>
        </button>
      </div>
    </div>

    <section class="sidebar-search-panel" id="sidebar-search-panel" data-sidebar-search data-od-id="sidebar-search-panel" hidden>
      <div class="sidebar-search-field">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.8 16.1a5.3 5.3 0 1 0 0-10.6 5.3 5.3 0 0 0 0 10.6Z"></path><path d="m15 15 4 4"></path></svg>
        <input type="search" aria-label="??????????????" data-sidebar-search-input data-placeholder-zh="??????????????" data-placeholder-en="Search spaces, conversations, capabilities, and agents" placeholder="??????????????" />
        <kbd>?K</kbd>
      </div>
      <div class="sidebar-search-results" role="listbox" aria-label="????">
        <button class="sidebar-search-result" type="button" data-search-result data-search-keywords="Agent ?????? workspace ???? agent team delivery" data-search-status-zh="???? Agent ??????" data-search-status-en="Located Agent team delivery space"><span><strong data-zh="Agent ??????" data-en="Agent team delivery">Agent ??????</strong><small data-zh="????" data-en="Current space">????</small></span><em>Space</em></button>
        <button class="sidebar-search-result" type="button" data-search-result data-search-keywords="?????? conversation team setup" data-search-status-zh="????????????" data-search-status-en="Located team setup draft conversation"><span><strong data-zh="??????" data-en="Team setup draft">??????</strong><small data-zh="Agent ??????" data-en="Agent team delivery">Agent ??????</small></span><em>Chat</em></button>
        <button class="sidebar-search-result" type="button" data-search-result data-search-keywords="Skill MCP ???? tool capability schema sandbox" data-search-status-zh="???? Skill/MCP ????" data-search-status-en="Located Skill/MCP capability space"><span><strong data-zh="Skill/MCP ????" data-en="Skill/MCP capability">Skill/MCP ????</strong><small>Schema ? Sandbox</small></span><em>Space</em></button>
        <button class="sidebar-search-result" type="button" data-search-result data-search-keywords="${escapeHtml(slots.agent.title)} agent visual review" data-search-status-zh="????${escapeHtml(slots.agent.title)}" data-search-status-en="Located ${escapeHtml(slots.agent.title)}"><span><strong>${escapeHtml(slots.agent.title)}</strong><small data-zh="?????????" data-en="Agent configuration">?????????</small></span><em>Agent</em></button>
        <p class="sidebar-search-empty" data-search-empty hidden data-zh="?????" data-en="No matches">?????</p>
      </div>
    </section>

    <a class="sidebar-brand" href="#view-command" data-od-id="desktop-brand"><span>Crewon</span><small>v0.2</small></a>
    <nav class="sidebar-nav" data-od-id="desktop-nav">
      ${nav}
      <button type="button" data-run="#command-log" data-run-title-zh="???" data-run-title-en="Knowledge base" data-run-copy="????????????????????????????" data-run-copy-en="Knowledge base includes team docs, project materials, long-term memories, and referenceable resources." data-toast="??????" data-toast-en="Knowledge base focused"><span class="nav-glyph" aria-hidden="true">${knowledgeIcon}</span><strong data-zh="???" data-en="Knowledge base">???</strong></button>
    </nav>
    <section class="space-tree" data-od-id="desktop-workspace-tree" aria-label="?????">
      <div class="tree-head"><button type="button" data-run="#command-log" data-run-title-zh="???" data-run-title-en="Spaces" data-run-copy="??????? Agent ?????? Skill/MCP ???" data-run-copy-en="Spaces organize Agent teams, access, and Skill/MCP capabilities." data-toast="??????" data-toast-en="Spaces focused">??</button><button class="tree-add" type="button" aria-label="????" data-run="#command-log" data-run-title-zh="????" data-run-title-en="New space" data-run-copy="??????????" data-run-copy-en="Prepared a new space draft." data-toast="??????" data-toast-en="Ready to create space">+</button></div>
      <div class="space-node current" data-od-id="workspace-node-product"><button class="space-title" type="button"><span aria-hidden="true">?</span><strong data-zh="Agent ??????" data-en="Agent team delivery">Agent ??????</strong></button><div class="conversation-list"><button class="conversation-item active" type="button" data-zh="??????" data-en="Team setup draft">??????</button><button class="conversation-item" type="button">Workflow Gate</button><button class="conversation-item" type="button" data-zh="??????" data-en="Delivery checklist">??????</button></div></div>
      <div class="space-node" data-od-id="workspace-node-team"><button class="space-title" type="button"><span aria-hidden="true">?</span><strong data-zh="???????" data-en="Office access">???????</strong></button><div class="conversation-list compact"><button class="conversation-item" type="button" data-zh="????" data-en="Four-layer access">????</button><button class="conversation-item" type="button">Channel ??</button></div></div>
      <div class="space-node" data-od-id="workspace-node-agents"><button class="space-title" type="button"><span aria-hidden="true">?</span><strong data-zh="Skill/MCP ????" data-en="Skill/MCP capability">Skill/MCP ????</strong></button><div class="conversation-list compact"><button class="conversation-item" type="button" data-zh="Schema ??" data-en="Schema validation">Schema ??</button><button class="conversation-item" type="button" data-zh="????" data-en="Sandbox audit">????</button></div></div>
    </section>
    <footer class="sidebar-account" data-od-id="desktop-account-entry"><span class="account-mark">R</span><strong>Turning_Around</strong><button class="locale-toggle" type="button" data-od-id="desktop-locale">EN</button></footer>
  `;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (char) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
    };
    return map[char] ?? char;
  });
}

function replaceFirstOption(html: string, selectorName: string, label: string) {
  const escaped = escapeHtml(label);
  const pattern = new RegExp(
    `(<select[^>]*${selectorName}[^>]*>[\\s\\S]*?<option[^>]*data-zh=")[^"]*("[^>]*data-en=")[^"]*("[^>]*>)[\\s\\S]*?(</option>)`,
  );
  return html.replace(pattern, `$1${escaped}$2${escaped}$3${escaped}$4`);
}

function replacePaletteItems(
  html: string,
  shellView: string,
  itemAttr: string,
  items: Array<{ label: string; title: string; detail: string; kind: string }>,
  startIndex = 0,
) {
  let seen = 0;
  let used = 0;
  const sectionPattern = new RegExp(
    `(<section[^>]*data-shell-view="${shellView}"[\\s\\S]*?</section>)`,
  );
  return html.replace(sectionPattern, (section) =>
    section.replace(
      new RegExp(`<button type="button" ${itemAttr}=""[^>]*>[\\s\\S]*?</button>`, "g"),
      (button) => {
        const item = items[used];
        const currentIndex = seen;
        seen += 1;
        if (currentIndex < startIndex || !item) {
          return button;
        }
        used += 1;
        const dataLabel = escapeHtml(item.title);
        return button
          .replace(/data-kind="[^"]*"/, `data-kind="${item.kind}"`)
          .replace(/data-label="[^"]*"/, `data-label="${dataLabel}"`)
          .replace(/>[\s\S]*?<\/button>$/, `><span>${escapeHtml(item.label)}</span><strong>${dataLabel}</strong><em>${escapeHtml(item.detail)}</em></button>`);
      },
    ),
  );
}

function applyInitialShellView(html: string, activeView: ShellViewId) {
  return html.replace(/<section class="([^"]*)"([^>]*data-shell-view="([^"]+)"[^>]*)>/g, (match, classes, rest, view) => {
    if (!isShellViewId(view)) {
      return match;
    }
    const classList = classes.split(/\s+/).filter((item: string) => item && item !== "active");
    let nextRest = rest.replace(/\s+hidden(="")?/g, "");
    if (view === activeView) {
      classList.push("active");
    } else {
      nextRest += ' hidden=""';
    }
    return `<section class="${classList.join(" ")}"${nextRest}>`;
  });
}

function injectDesignData(html: string, slots: CommandHomeSlots, initialView: ShellViewId) {
  const htmlWithSidebar = html.replace(
    /<aside class="command-sidebar"[\s\S]*?<\/aside>/,
    `<aside class="command-sidebar" data-sidebar-shell="" data-sidebar-current="${initialView}" data-sidebar-log="command-log" data-sidebar-prefix="desktop" data-od-id="desktop-sidebar">${originalSidebarHtml(initialView, "command-log", "desktop")}</aside>`,
  );
  return applyInitialShellView(htmlWithSidebar, initialView);
}

function getOptionText(option: HTMLOptionElement | undefined) {
  return option?.dataset.zh || option?.textContent?.trim() || "";
}

function syncEnhancedSelect(wrap: HTMLElement) {
  const select = wrap.querySelector<HTMLSelectElement>("select");
  const trigger = wrap.querySelector<HTMLButtonElement>(".select-trigger");
  const menu = wrap.querySelector<HTMLElement>(".select-menu");
  if (!select || !trigger || !menu) return;

  const selected = select.selectedOptions[0] ?? select.options[0];
  trigger.textContent = getOptionText(selected);
  menu.querySelectorAll<HTMLButtonElement>(".select-option").forEach((item) => {
    const option = Array.from(select.options).find((entry) => entry.value === item.dataset.value);
    item.textContent = getOptionText(option);
    item.setAttribute("aria-selected", item.dataset.value === select.value ? "true" : "false");
  });
}

function setupDesignEnhancedSelects(root: HTMLElement) {
  const wraps = Array.from(root.querySelectorAll(".control-select, .workspace-picker"));
  for (const element of wraps) {
    const wrap = element as HTMLElement;
    const select = wrap.querySelector("select");
    if (!select || select.tagName !== "SELECT" || wrap.dataset.enhancedSelect === "true") {
      continue;
    }
    const selectElement = select as HTMLSelectElement;

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "select-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-label", selectElement.getAttribute("aria-label") || wrap.getAttribute("aria-label") || "选择");

    const menu = document.createElement("div");
    menu.className = "select-menu";
    menu.hidden = true;
    menu.setAttribute("role", "listbox");

    for (const option of Array.from(selectElement.options)) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "select-option";
      item.dataset.value = option.value;
      item.setAttribute("role", "option");
      menu.appendChild(item);
    }

    wrap.dataset.enhancedSelect = "true";
    wrap.insertBefore(trigger, selectElement);
    wrap.appendChild(menu);
    syncEnhancedSelect(wrap);
  }
}

function closeDesignFloating(root: HTMLElement, except?: HTMLElement | null) {
  root.querySelectorAll<HTMLElement>(".select-menu").forEach((menu) => {
    if (menu !== except) {
      menu.hidden = true;
      menu.parentElement?.querySelector(".select-trigger")?.setAttribute("aria-expanded", "false");
    }
  });
  root.querySelectorAll<HTMLElement>("[data-slash-palette], [data-context-palette], [data-sidebar-search]").forEach((panel) => {
    if (panel !== except) {
      panel.hidden = true;
      if (panel.matches("[data-sidebar-search]")) {
        root.querySelector("[data-sidebar-search-open]")?.setAttribute("aria-expanded", "false");
      }
    }
  });
}

function closeDesignModals(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>(".modal-backdrop.open").forEach((modal) => {
    modal.classList.remove("open");
  });
  if (!document.querySelector(".modal-backdrop.open")) {
    document.body.classList.remove("modal-open");
  }
}

function activeFilters(scope: HTMLElement) {
  return Array.from(scope.querySelectorAll<HTMLElement>(".filter-chip[data-filter].active"))
    .map((chip) => chip.dataset.filter)
    .filter((filter): filter is string => Boolean(filter) && filter !== "all");
}

export function applyDesignCardVisibility(scope: HTMLElement) {
  const filters = activeFilters(scope);
  const search = scope.querySelector<HTMLInputElement>(".catalog-search input");
  const query = (search?.value ?? "").trim().toLowerCase();
  const cards = Array.from(scope.querySelectorAll<HTMLElement>("[data-card-filter]"));
  let visibleCount = 0;

  for (const card of cards) {
    const values = (card.dataset.cardFilter ?? "").split(/\s+/).filter(Boolean);
    const matchesFilter = filters.every((filter) => values.includes(filter));
    const matchesSearch =
      !query || (card.innerText || card.textContent || "").toLowerCase().includes(query);
    const visible = matchesFilter && matchesSearch;
    card.classList.toggle("hidden", !visible);
    card.hidden = !visible;
    if (visible) {
      visibleCount += 1;
    }
  }

  const empty = scope.querySelector<HTMLElement>("[data-filter-empty]");
  if (empty && cards.length > 0) {
    empty.hidden = visibleCount > 0;
    empty.classList.toggle("visible", visibleCount === 0);
  }
}

export function syncDesignFilterState(scope: HTMLElement) {
  scope.querySelectorAll<HTMLElement>(".filter-chip[data-filter]").forEach((chip) => {
    chip.setAttribute("aria-pressed", chip.classList.contains("active") ? "true" : "false");
  });
  scope.querySelectorAll<HTMLElement>("[data-team-action]").forEach((button) => {
    const mode =
      scope.querySelector<HTMLElement>('.filter-chip.active[data-filter-group="team-mode"]')
        ?.dataset.filter ?? "office";
    button.hidden = button.dataset.teamAction !== mode;
  });
  applyDesignCardVisibility(scope);
}

function filterScopeFor(target: Element) {
  return (
    target.closest<HTMLElement>("[data-filter-scope]") ??
    target.closest<HTMLElement>("[data-shell-view]") ??
    target.closest<HTMLElement>(".page-stack")
  );
}

export function setActiveFilter(scope: HTMLElement, group: string, filter: string) {
  const selector =
    group === "default"
      ? ".filter-chip[data-filter]:not([data-filter-group])"
      : `.filter-chip[data-filter][data-filter-group="${group}"]`;
  const chips = Array.from(scope.querySelectorAll<HTMLElement>(selector));
  for (const chip of chips) {
    chip.classList.toggle("active", chip.dataset.filter === filter);
  }
  syncDesignFilterState(scope);
}

export function setDefaultScheduleFilters(view: HTMLElement) {
  const scope = filterScopeFor(view) ?? view;
  setActiveFilter(scope, "schedule-mode", "calendar");
  setActiveFilter(scope, "schedule-source", "teamflow");
}

function setDefaultTeamOfficePreview(view: HTMLElement) {
  const scope = filterScopeFor(view) ?? view;
  setActiveFilter(scope, "team-mode", "office");
  const officeRoom = view.querySelector<HTMLElement>("[data-office-room]");
  if (officeRoom && officeRoom.hidden) {
    officeRoom.hidden = false;
  }
}

function openDesignPalette(root: HTMLElement, input: HTMLTextAreaElement, type: "slash" | "context") {
  const commandInput = input.closest<HTMLElement>(".command-input");
  const palette = commandInput?.querySelector<HTMLElement>(
    type === "slash" ? "[data-slash-palette]" : "[data-context-palette]",
  );
  if (!palette) return;

  closeDesignFloating(root, palette);
  palette.hidden = false;
  const search = palette.querySelector<HTMLInputElement>(
    type === "slash" ? "[data-slash-search]" : "[data-context-search]",
  );
  if (search) {
    search.value = "";
    window.setTimeout(() => search.focus(), 0);
  }
}

function insertComposerToken(
  item: HTMLElement,
  prefixChar: "/" | "@",
  onChangeComposerValue: (value: string) => void,
) {
  const commandInput = item.closest<HTMLElement>(".command-input");
  const input = commandInput?.querySelector<HTMLTextAreaElement>("[data-composer]");
  if (!input) return;
  const label = item.dataset.label || item.textContent?.trim() || "";
  const prefix = input.value.trim() ? " " : "";
  const insertText = `${prefix}${prefixChar}${label} `;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = `${input.value.slice(0, start)}${insertText}${input.value.slice(end)}`;
  const next = start + insertText.length;
  input.setSelectionRange(next, next);
  input.focus();
  onChangeComposerValue(input.value);
  closeDesignFloating(input.closest<HTMLElement>(".screen-shell") ?? document.body);
}

export function CommandWorkspace({
  composerValue,
  connectionState,
  cwd,
  isSending,
  workMode,
  onAttachContext,
  onChangeComposerValue,
  onModeChange,
  onRetryConnection,
  onSend,
}: CommandWorkspaceProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const latestPropsRef = useRef({
    composerValue,
    isSending,
    onAttachContext,
    onChangeComposerValue,
    onModeChange,
    onRetryConnection,
    onSend,
  });
  const [snapshot, setSnapshot] = useState<AgentPlatformSnapshot>(emptySnapshot);

  useEffect(() => {
    latestPropsRef.current = {
      composerValue,
      isSending,
      onAttachContext,
      onChangeComposerValue,
      onModeChange,
      onRetryConnection,
      onSend,
    };
  }, [
    composerValue,
    isSending,
    onAttachContext,
    onChangeComposerValue,
    onModeChange,
    onRetryConnection,
    onSend,
  ]);

  useEffect(() => {
    readAgentPlatformSnapshot()
      .then(setSnapshot)
      .catch(() => setSnapshot(emptySnapshot));
  }, []);

  const slots = useMemo(() => selectCommandHomeSlots(snapshot), [snapshot]);
  const designHtml = useMemo(
    () =>
      injectDesignData(
        originalCommandWindowHtml,
        selectCommandHomeSlots(emptySnapshot),
        shellViewFromHash(),
      ),
    [],
  );

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.innerHTML = designHtml;
    root.dataset.commandShellMounted = "true";
  }, [designHtml]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const setup = () => {
      setupDesignEnhancedSelects(root);
    };
    setup();
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      setup();
      secondFrame = window.requestAnimationFrame(() => {
        setup();
      });
    });
    const timeout = window.setTimeout(setup, 250);
    const observer = new MutationObserver(() => {
      if (root.querySelector(".control-select:not([data-enhanced-select]), .workspace-picker:not([data-enhanced-select])")) {
        setup();
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
      window.clearTimeout(timeout);
      observer.disconnect();
    };
  }, [designHtml]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const activateShellView = (key: string) => {
      const views = Array.from(root.querySelectorAll<HTMLElement>("[data-shell-view]"));
      const activeView = views.find((view) => view.dataset.shellView === key);
      if (!activeView) {
        return false;
      }
      closeDesignFloating(root);
      closeDesignModals(root);
      views.forEach((view) => {
        const active = view === activeView;
        view.hidden = !active;
        view.classList.toggle("active", active);
      });
      root.querySelectorAll<HTMLElement>("[data-shell-view-target]").forEach((link) => {
        const active = link.dataset.shellViewTarget === key;
        link.classList.toggle("active", active);
        if (active) {
          link.setAttribute("aria-current", "page");
        } else {
          link.removeAttribute("aria-current");
        }
      });
      if (window.location.hash !== `#view-${key}`) {
        window.history.replaceState(null, "", `#view-${key}`);
      }
      if (key === "schedule") {
        setDefaultScheduleFilters(activeView);
      } else if (key === "team") {
        setDefaultTeamOfficePreview(activeView);
      }
      const scope = filterScopeFor(activeView);
      if (scope) {
        syncDesignFilterState(scope);
      }
      return true;
    };

    const handleInput = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLTextAreaElement && target.matches("[data-composer]")) {
        latestPropsRef.current.onChangeComposerValue(target.value);
        return;
      }
      if (target instanceof HTMLInputElement && target.matches(".catalog-search input")) {
        const scope = filterScopeFor(target);
        if (scope) {
          applyDesignCardVisibility(scope);
        }
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.key === "Escape") {
        closeDesignFloating(root);
        closeDesignModals(root);
        return;
      }
      if (
        target instanceof HTMLTextAreaElement &&
        target.matches("[data-composer]") &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        if (event.key === "/") {
          event.preventDefault();
          openDesignPalette(root, target, "slash");
        } else if (event.key === "@") {
          event.preventDefault();
          openDesignPalette(root, target, "context");
        }
      }
    };

    const handleBeforeInput = (event: InputEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement) || !target.matches("[data-composer]")) {
        return;
      }
      if (event.inputType === "insertText" && event.data === "/") {
        event.preventDefault();
        openDesignPalette(root, target, "slash");
      } else if (event.inputType === "insertText" && event.data === "@") {
        event.preventDefault();
        openDesignPalette(root, target, "context");
      }
    };

    const handleClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const shellTarget = target.closest<HTMLElement>("[data-shell-view-target]");
      if (shellTarget?.dataset.shellViewTarget) {
        if (activateShellView(shellTarget.dataset.shellViewTarget)) {
          event.preventDefault();
        }
        return;
      }

      const filterChip = target.closest<HTMLElement>(".filter-chip[data-filter]");
      if (filterChip) {
        const scope = filterScopeFor(filterChip);
        if (scope) {
          event.preventDefault();
          const group = filterChip.dataset.filterGroup ?? "default";
          setActiveFilter(scope, group, filterChip.dataset.filter ?? "all");
        }
        return;
      }

      const sidebarCollapse = target.closest<HTMLButtonElement>("[data-sidebar-collapse]");
      if (sidebarCollapse) {
        const shell = sidebarCollapse.closest<HTMLElement>(".command-window");
        if (shell) {
          event.preventDefault();
          const collapsed = !shell.classList.contains("sidebar-collapsed");
          shell.classList.toggle("sidebar-collapsed", collapsed);
          sidebarCollapse.setAttribute("aria-pressed", collapsed ? "true" : "false");
          if (collapsed) {
            closeDesignFloating(root);
          }
        }
        return;
      }

      const sidebarSearchOpen = target.closest<HTMLButtonElement>("[data-sidebar-search-open]");
      if (sidebarSearchOpen) {
        const panel = root.querySelector<HTMLElement>("[data-sidebar-search]");
        if (panel) {
          event.preventDefault();
          const shouldOpen = panel.hidden;
          closeDesignFloating(root, shouldOpen ? panel : null);
          panel.hidden = !shouldOpen;
          sidebarSearchOpen.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
          if (shouldOpen) {
            window.setTimeout(() => {
              panel.querySelector<HTMLInputElement>("[data-sidebar-search-input]")?.focus();
            }, 0);
          }
        }
        return;
      }

      const spaceTitle = target.closest<HTMLButtonElement>(".space-title");
      if (spaceTitle) {
        const node = spaceTitle.closest<HTMLElement>(".space-node");
        const marker = spaceTitle.querySelector("span");
        if (node) {
          event.preventDefault();
          node.classList.toggle("collapsed");
          if (marker) {
            marker.textContent = node.classList.contains("collapsed") ? "›" : "⌄";
          }
        }
        return;
      }

      const conversationItem = target.closest<HTMLButtonElement>(".conversation-item");
      if (conversationItem) {
        const tree = conversationItem.closest<HTMLElement>(".space-tree");
        const node = conversationItem.closest<HTMLElement>(".space-node");
        if (tree) {
          event.preventDefault();
          tree.querySelectorAll(".conversation-item").forEach((item) => {
            item.classList.toggle("active", item === conversationItem);
          });
          tree.querySelectorAll(".space-node").forEach((item) => {
            item.classList.toggle("current", item === node);
          });
        }
        closeDesignFloating(root);
        return;
      }

      const officeOpen = target.closest<HTMLButtonElement>("[data-office-open]");
      if (officeOpen) {
        const shell = officeOpen.closest<HTMLElement>("[data-office-shell]");
        const room = shell?.querySelector<HTMLElement>("[data-office-room]");
        if (shell && room) {
          event.preventDefault();
          shell.querySelectorAll("[data-office-open]").forEach((item) => {
            item.classList.toggle("is-active", item === officeOpen);
          });
          const title = room.querySelector<HTMLElement>("[data-office-title]");
          const subtitle = room.querySelector<HTMLElement>("[data-office-subtitle]");
          if (title) {
            title.dataset.zh = officeOpen.dataset.officeTitleZh ?? title.dataset.zh ?? "";
            title.dataset.en = officeOpen.dataset.officeTitleEn ?? title.dataset.en ?? "";
            title.textContent = title.dataset.zh ?? "";
          }
          if (subtitle) {
            subtitle.dataset.zh = officeOpen.dataset.officeSubtitleZh ?? subtitle.dataset.zh ?? "";
            subtitle.dataset.en = officeOpen.dataset.officeSubtitleEn ?? subtitle.dataset.en ?? "";
            subtitle.textContent = subtitle.dataset.zh ?? "";
          }
          room.hidden = false;
        }
        closeDesignFloating(root);
        return;
      }

      const officeBack = target.closest<HTMLButtonElement>("[data-office-back]");
      if (officeBack) {
        const room = officeBack.closest<HTMLElement>("[data-office-room]");
        if (room) {
          event.preventDefault();
          room.hidden = true;
        }
        return;
      }

      const modalTrigger = target.closest<HTMLElement>("[data-open-modal]");
      if (modalTrigger?.dataset.openModal) {
        const modal = root.querySelector<HTMLElement>(modalTrigger.dataset.openModal);
        if (modal) {
          event.preventDefault();
          closeDesignFloating(root);
          closeDesignModals(root);
          modal.classList.add("open");
          modal.setAttribute("tabindex", "-1");
          document.body.classList.add("modal-open");
          window.setTimeout(() => {
            const focusTarget = modal.querySelector<HTMLElement>(
              "input, textarea, select, .space-input, button:not([data-close-modal])",
            );
            focusTarget?.focus({ preventScroll: true });
          }, 0);
        }
        return;
      }

      const modalClose = target.closest<HTMLElement>("[data-close-modal]");
      if (modalClose) {
        event.preventDefault();
        const modal = modalClose.closest<HTMLElement>(".modal-backdrop");
        if (modal) {
          modal.classList.remove("open");
        }
        if (!root.querySelector(".modal-backdrop.open")) {
          document.body.classList.remove("modal-open");
        }
        return;
      }

      const modalBackdrop = target.classList.contains("modal-backdrop")
        ? (target as HTMLElement)
        : null;
      if (modalBackdrop) {
        modalBackdrop.classList.remove("open");
        if (!root.querySelector(".modal-backdrop.open")) {
          document.body.classList.remove("modal-open");
        }
        return;
      }

      const modalSubmit = target.closest<HTMLElement>("[data-submit-task]");
      if (modalSubmit) {
        event.preventDefault();
        const modal = modalSubmit.closest<HTMLElement>(".modal-backdrop");
        if (modal) {
          modal.classList.remove("open");
        }
        if (!root.querySelector(".modal-backdrop.open")) {
          document.body.classList.remove("modal-open");
        }
        return;
      }

      const selectTrigger = target.closest<HTMLButtonElement>(".select-trigger");
      if (selectTrigger) {
        const wrap = selectTrigger.closest<HTMLElement>(".control-select, .workspace-picker");
        const menu = wrap?.querySelector<HTMLElement>(".select-menu");
        if (menu) {
          event.preventDefault();
          event.stopPropagation();
          const shouldOpen = menu.hidden;
          closeDesignFloating(root, shouldOpen ? menu : null);
          menu.hidden = !shouldOpen;
          selectTrigger.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
        }
        return;
      }

      const selectOption = target.closest<HTMLButtonElement>(".select-option");
      if (selectOption) {
        const wrap = selectOption.closest<HTMLElement>(".control-select, .workspace-picker");
        const select = wrap?.querySelector<HTMLSelectElement>("select");
        if (wrap && select && selectOption.dataset.value) {
          select.value = selectOption.dataset.value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
          syncEnhancedSelect(wrap);
          closeDesignFloating(root);
        }
      }

      const slashItem = target.closest<HTMLElement>("[data-slash-item]");
      if (slashItem) {
        insertComposerToken(slashItem, "/", latestPropsRef.current.onChangeComposerValue);
      }

      const contextItem = target.closest<HTMLElement>("[data-context-item]");
      if (contextItem) {
        insertComposerToken(contextItem, "@", latestPropsRef.current.onChangeComposerValue);
      }

      if (target.closest(".workspace-pill")) {
        latestPropsRef.current.onRetryConnection();
        readAgentPlatformSnapshot().then(setSnapshot).catch(() => setSnapshot(emptySnapshot));
      }

      const modeSelect = target.closest(".select-option")?.parentElement?.previousElementSibling?.previousElementSibling;
      if (modeSelect instanceof HTMLSelectElement && modeSelect.matches("[data-task-mode]")) {
        const value = modeSelect.value;
        latestPropsRef.current.onModeChange(value === "agent" ? "office" : "code");
      }

      const sendButton = target.closest<HTMLButtonElement>(".send-button");
      if (sendButton) {
        const input = sendButton.closest(".command-input")?.querySelector<HTMLTextAreaElement>("[data-composer]");
        const text = input?.value.trim() || latestPropsRef.current.composerValue.trim();
        if (text && !latestPropsRef.current.isSending) {
          latestPropsRef.current.onSend(text);
        }
      }

      if (target.closest("[data-context-open]")) {
        latestPropsRef.current.onAttachContext();
      }

      if (
        !target.closest(
          ".select-menu, .select-trigger, [data-slash-palette], [data-context-palette], [data-composer], [data-sidebar-search], [data-sidebar-search-open]",
        )
      ) {
        closeDesignFloating(root);
      }
    };

    const handleDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || !root.contains(target)) return;
      if (
        target.closest(
          ".select-menu, .select-trigger, [data-slash-palette], [data-context-palette], [data-composer], [data-sidebar-search], [data-sidebar-search-open]",
        )
      ) {
        return;
      }
      closeDesignFloating(root);
    };

    root.addEventListener("input", handleInput);
    root.addEventListener("keydown", handleKeyDown);
    root.addEventListener("beforeinput", handleBeforeInput);
    root.addEventListener("click", handleClick);
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    const initial = window.location.hash.replace(/^#view-/, "") || "command";
    activateShellView(initial);
    const handleHashChange = () => {
      activateShellView(window.location.hash.replace(/^#view-/, "") || "command");
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => {
      root.removeEventListener("input", handleInput);
      root.removeEventListener("keydown", handleKeyDown);
      root.removeEventListener("beforeinput", handleBeforeInput);
      root.removeEventListener("click", handleClick);
      document.removeEventListener("pointerdown", handleDocumentPointerDown);
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const focused = document.activeElement;
    const composer = root.querySelector<HTMLTextAreaElement>('[data-shell-view="command"] [data-composer]');
    if (composer && focused !== composer && composer.value !== composerValue) {
      composer.value = composerValue;
    }
  }, [composerValue]);

  useEffect(() => {
    void connectionState;
    void cwd;
    void workMode;
  }, [connectionState, cwd, workMode]);

  useEffect(() => {
    void slots;
  }, [slots]);

  const staticMarkupProps =
    typeof window === "undefined"
      ? { dangerouslySetInnerHTML: { __html: designHtml } }
      : {};

  return (
    <main
      className="screen-shell command-screen"
      data-od-id="desktop-command-screen"
      ref={rootRef}
      suppressHydrationWarning
      {...staticMarkupProps}
    />
  );
}

export function selectCommandHomeSlots(
  snapshot: AgentPlatformSnapshot,
): CommandHomeSlots {
  const agent =
    snapshot.agents.find(
      (item) =>
        item.is_active !== false &&
        item.is_active !== 0 &&
        ((item.skill_ids?.length ?? 0) > 0 ||
          (item.mcp_servers?.length ?? 0) > 0 ||
          (item.knowledge_base_ids?.length ?? 0) > 0),
    ) ??
    snapshot.agents.find((item) => item.is_active !== false && item.is_active !== 0) ??
    snapshot.agents[0];
  const workflow =
    findByKeyword(snapshot.workflows, ["gate", "\u5ba1\u6279", "\u4ea4\u4ed8", "\u6d4b\u8bd5", "\u9a8c\u6536"]) ??
    snapshot.workflows[0];
  const knowledge = snapshot.knowledgeBases[0];
  const skillA =
    findByKeyword(snapshot.skills, ["schema", "\u6821\u9a8c", "\u5ba1\u9605", "\u4ea4\u4ed8", "\u68c0\u67e5"]) ??
    snapshot.skills[0];
  const skillB =
    snapshot.skills.find((item) => item.id !== skillA?.id) ?? snapshot.skills[1];
  const mcpA =
    findByKeyword(snapshot.mcpServers, [
      "filesystem",
      "\u6587\u4ef6",
      "\u5ba1\u8ba1",
      "sandbox",
      "\u6c99\u7bb1",
    ]) ?? snapshot.mcpServers[0];
  const mcpB =
    snapshot.mcpServers.find((item) => item.id !== mcpA?.id) ?? snapshot.mcpServers[1];

  return {
    agent: {
      label: "\u667a\u80fd\u4f53",
      title: cleanSlotTitle(agent?.name, "\u4ea7\u54c1\u5ba1\u9605\u667a\u80fd\u4f53"),
      detail: agent?.description || "\u5f15\u7528\u5de6\u4fa7\u667a\u80fd\u4f53\u914d\u7f6e",
      value: agent ? `agent-${agent.id}` : "agent-fallback",
    },
    workflow: {
      label: "\u4f1a\u8bdd",
      title: cleanSlotTitle(workflow?.name, "\u9879\u76ee\u4ea4\u4ed8\u6e05\u5355"),
      detail: workflow?.description || "\u9a8c\u6536\u70b9\u3001\u8d1f\u8d23\u4eba\u548c\u98ce\u9669\u8bb0\u5f55",
      value: workflow ? `workflow-${workflow.id}` : "workflow-fallback",
    },
    knowledge: {
      label: "\u7a7a\u95f4",
      title: cleanSlotTitle(knowledge?.name, "Agent \u5c0f\u961f\u4ea4\u4ed8\u7a7a\u95f4"),
      detail: knowledge
        ? `${knowledge.document_count ?? 0} \u4e2a\u6587\u6863 ? ${knowledge.embedding_model ?? "embedding"}`
        : "\u9ed8\u8ba4\u521b\u5efa\u65b0\u5c0f\u961f\u4efb\u52a1\u7684\u4f4d\u7f6e",
      value: knowledge ? `knowledge-${knowledge.id}` : "knowledge-fallback",
    },
    skills: [
      {
        label: "Skill",
        title: cleanSlotTitle(skillA?.name, "\u9875\u9762\u5ba1\u9605 Skill"),
        detail: skillA?.description || "\u68c0\u67e5\u5c42\u7ea7\u3001\u6587\u6848\u3001\u4ea4\u4e92\u548c\u9a8c\u6536\u70b9",
        value: skillA ? `skill-${skillA.id}` : "skill-review",
      },
      {
        label: "Skill",
        title: cleanSlotTitle(skillB?.name, "\u4ea4\u4ed8\u68c0\u67e5 Skill"),
        detail: skillB?.description || "\u751f\u6210\u6d4b\u8bd5\u70b9\u3001\u98ce\u9669\u548c\u4e0a\u7ebf\u6e05\u5355",
        value: skillB ? `skill-${skillB.id}` : "skill-delivery",
      },
    ],
    mcps: [
      {
        label: "MCP",
        title: cleanSlotTitle(mcpA?.alias || mcpA?.name, "Filesystem MCP"),
        detail: mcpA?.description || mcpA?.endpoint || "\u8bfb\u53d6\u548c\u5199\u5165\u5f53\u524d\u9879\u76ee\u6587\u4ef6",
        value: mcpA ? `mcp-${mcpA.id}` : "mcp-filesystem",
      },
      {
        label: "MCP",
        title: cleanSlotTitle(mcpB?.alias || mcpB?.name, "Screenshot MCP"),
        detail: mcpB?.description || mcpB?.endpoint || "\u6e32\u67d3\u9875\u9762\u5e76\u505a\u89c6\u89c9\u6838\u9a8c",
        value: mcpB ? `mcp-${mcpB.id}` : "mcp-screenshot",
      },
    ],
    model: agent?.model_info?.model_name || agent?.model_info?.name || "agent-platform local",
  };
}

export function cleanSlotTitle(
  value: string | null | undefined,
  fallback: string,
): string {
  const title = value?.trim();
  if (!title) {
    return fallback;
  }
  const normalized = title.replace(/\s+/g, "");
  const isNumeric = /^\d+$/.test(normalized);
  const lower = normalized.toLowerCase();
  const sampleWord = "\u6837\u4f8b";
  const exampleWord = "\u793a\u4f8b";
  const testWord = "\u6d4b\u8bd5";
  const isTestLike =
    ["test", "demo", sampleWord, exampleWord].includes(lower) ||
    normalized.startsWith(testWord) ||
    lower.startsWith("test");
  if (isNumeric || isTestLike) {
    return fallback;
  }
  const technicalTitleMap: Record<string, string> = {
    filesystem: "Filesystem MCP",
    "file-system": "Filesystem MCP",
    http: "HTTP Tools",
    "http-tools": "HTTP Tools",
  };
  return technicalTitleMap[normalized.toLowerCase()] ?? title;
}

function findByKeyword<T extends { name: string; description?: string | null }>(
  items: T[],
  keywords: string[],
): T | undefined {
  return items.find((item) => {
    const text = `${item.name} ${item.description ?? ""}`.toLowerCase();
    return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
  });
}
