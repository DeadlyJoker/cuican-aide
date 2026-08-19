import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Thread } from "@crewon-ui-model/v2/Thread";

import { Sidebar } from "./Sidebar";

function thread(overrides: Partial<Thread>): Thread {
  return {
    id: "thread-1",
    name: "Frontend refactor",
    preview: "Split the UI architecture",
    cwd: "/repo/frontend",
    updatedAt: 1_800_000_000,
    turns: [],
    status: { type: "ready" },
    ...overrides,
  } as unknown as Thread;
}

describe("Sidebar", () => {
  it("renders navigation, search, grouped threads, and footer actions", () => {
    const markup = renderToStaticMarkup(
      <Sidebar
        activeLibraryKind="agents"
        activeThreadsLabel="Active"
        archiveThreadLabel="Archive"
        archivedThreadsLabel="Archived"
        clearSearchLabel="Clear search"
        deleteThreadLabel="Delete"
        isLoading={false}
        loadingThreadsLabel="Loading threads"
        locale="en"
        newThreadLabel="New thread"
        newThreadShortcutLabel="⌘N"
        noThreadsFoundLabel="No threads"
        renameThreadLabel="Rename"
        searchPlaceholder="Search threads"
        searchShortcutLabel="⌘K"
        searchValue="front"
        selectedThreadId="thread-1"
        settingsLabel="Settings"
        showArchived={false}
        threads={[
          thread({ id: "thread-1", cwd: "/repo/frontend" }),
          thread({
            id: "thread-2",
            cwd: undefined,
            name: "",
            preview: "Scratch chat",
            updatedAt: 1_800_000_100,
          }),
        ]}
        threadsSectionLabel="Threads"
        untitledThreadLabel="Untitled"
        workspaceLabel="Workspace"
        onAgents={vi.fn()}
        onArchiveThread={vi.fn()}
        onAutomation={vi.fn()}
        onDeleteThread={vi.fn()}
        onKnowledge={vi.fn()}
        onNewThread={vi.fn()}
        onRenameThread={vi.fn()}
        onSearchChange={vi.fn()}
        onSelectThread={vi.fn()}
        onSettings={vi.fn()}
        onToggleArchived={vi.fn()}
        onTools={vi.fn()}
      />,
    );

    expect(markup).toContain("New thread");
    expect(markup).toContain("Search threads");
    expect(markup).toContain("Frontend refactor");
    expect(markup).toContain("Scratch chat");
    expect(markup).toContain("Settings");
    expect(markup).toMatchInlineSnapshot(
      `"<aside class="sidebar"><nav class="sidebar-primary-nav" aria-label="Workspace"><button type="button" title="New thread (⌘N)"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg><span>New thread</span></button><button type="button"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-search"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg><span>Search threads</span></button><button type="button" data-active="false"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-wrench"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg><span>Tools</span></button><button type="button" data-active="true"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-bot"><path d="M12 8V4H8"></path><rect width="16" height="12" x="4" y="8" rx="2"></rect><path d="M2 14h2"></path><path d="M20 14h2"></path><path d="M15 13v2"></path><path d="M9 13v2"></path></svg><span>Agents</span></button><button type="button" data-active="false"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-clock3"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16.5 12"></polyline></svg><span>Automations</span></button><button type="button" data-active="false"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-book-open"><path d="M12 7v14"></path><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"></path></svg><span>Knowledge</span></button></nav><label class="search-box"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-search"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg><input aria-label="Search threads" placeholder="Search threads" value="front"/><button class="search-clear-button" type="button" aria-label="Clear search" title="Clear search"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></label><div class="thread-section-label"><span>Projects</span><button class="thread-section-action" type="button">Archived</button></div><nav class="thread-list" aria-label="Threads"><section class="project-session-group" aria-label="frontend Sessions"><div class="project-row" title="/repo/frontend"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-folder-closed"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path><path d="M2 10h20"></path></svg><strong>frontend</strong></div><div class="project-session-list"><div class="thread-row selected" aria-current="page"><button class="thread-row-main" type="button"><span class="thread-row-top"><span class="thread-title">Frontend refactor</span><span class="thread-time" title="Jan 15, 2027, 4:00 PM">now</span></span></button><span class="thread-row-actions"><button class="thread-row-action" type="button" aria-label="Rename" title="Rename"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pencil"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"></path><path d="m15 5 4 4"></path></svg></button><button class="thread-row-action" type="button" aria-label="Archive" title="Archive"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-archive"><rect width="20" height="5" x="2" y="3" rx="1"></rect><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"></path><path d="M10 12h4"></path></svg></button></span></div></div></section><div class="thread-section-label is-subtle"><span>Chats</span></div><div class="project-session-list standalone-session-list"><div class="thread-row"><button class="thread-row-main" type="button"><span class="thread-row-top"><span class="thread-title">Scratch chat</span><span class="thread-time" title="Jan 15, 2027, 4:01 PM">now</span></span></button><span class="thread-row-actions"><button class="thread-row-action" type="button" aria-label="Rename" title="Rename"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pencil"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"></path><path d="m15 5 4 4"></path></svg></button><button class="thread-row-action" type="button" aria-label="Archive" title="Archive"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-archive"><rect width="20" height="5" x="2" y="3" rx="1"></rect><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"></path><path d="M10 12h4"></path></svg></button></span></div></div></nav><div class="sidebar-footer"><button class="sidebar-command" type="button" aria-label="Settings" title="Settings"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-settings2"><path d="M20 7h-9"></path><path d="M14 17H5"></path><circle cx="17" cy="17" r="3"></circle><circle cx="7" cy="7" r="3"></circle></svg><span>Settings</span></button></div></aside>"`,
    );
  });
});
