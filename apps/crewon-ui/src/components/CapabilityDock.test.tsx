import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CapabilityDock } from "./CapabilityDock";
import type { CapabilityPanel } from "../lib/capability/capabilityPanelTypes";

const panel: CapabilityPanel = {
  title: "Terminal",
  subtitle: "Workspace shell",
  commandInput: true,
  body: "Last command finished successfully.",
  fields: [
    {
      id: "profile",
      label: "Profile",
      value: "default",
      options: [
        { label: "Default", value: "default" },
        { label: "CI", value: "ci" },
      ],
    },
    {
      id: "token",
      label: "Token",
      value: "secret",
      secret: true,
    },
  ],
  actions: [
    {
      id: "refresh",
      label: "Refresh",
      tone: "primary",
    },
  ],
  items: [
    {
      label: "Open workspace",
      path: "/repo",
      kind: "directory",
    },
    {
      label: "Background job",
      action: {
        type: "background-terminal",
        threadId: "thread-1",
        processId: "proc-1",
      },
    },
  ],
};

describe("CapabilityDock", () => {
  it("renders tools and the active capability panel", () => {
    const markup = renderToStaticMarkup(
      <CapabilityDock
        locale="en"
        busyToolId="terminal"
        commandValue="pnpm test"
        panel={panel}
        onCommandChange={vi.fn()}
        onCommandSubmit={vi.fn()}
        onFiles={vi.fn()}
        onPanelAction={vi.fn()}
        onPanelFieldChange={vi.fn()}
        onPanelItem={vi.fn()}
        onReview={vi.fn()}
        onSideChat={vi.fn()}
        onTerminal={vi.fn()}
        onWeb={vi.fn()}
      />,
    );

    expect(markup).toContain("Starting");
    expect(markup).toContain("Terminal");
    expect(markup).toContain("Open workspace");
    expect(markup).toContain("Background job");
    expect(markup).toMatchInlineSnapshot(`"<div class="capability-dock"><div aria-label="Workspace tools" class="capability-tool-tabs" role="toolbar"><button aria-label="Review" aria-pressed="false" data-tool-id="review" type="button" title="Review · ^⇧G"><span class="capability-label"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-scan-search"><path d="M3 7V5a2 2 0 0 1 2-2h2"></path><path d="M17 3h2a2 2 0 0 1 2 2v2"></path><path d="M21 17v2a2 2 0 0 1-2 2h-2"></path><path d="M7 21H5a2 2 0 0 1-2-2v-2"></path><circle cx="12" cy="12" r="3"></circle><path d="m16 16-1.9-1.9"></path></svg>Review</span><kbd>^⇧G</kbd></button><button aria-label="Starting Terminal" aria-pressed="true" data-active="true" data-tool-id="terminal" type="button" disabled="" title="Terminal"><span class="capability-label"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-terminal"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" x2="20" y1="19" y2="19"></line></svg>Starting</span></button><button aria-label="Browser" aria-pressed="false" data-tool-id="web" type="button" title="Browser · ⌘T"><span class="capability-label"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-earth"><path d="M21.54 15H17a2 2 0 0 0-2 2v4.54"></path><path d="M7 3.34V5a3 3 0 0 0 3 3a2 2 0 0 1 2 2c0 1.1.9 2 2 2a2 2 0 0 0 2-2c0-1.1.9-2 2-2h3.17"></path><path d="M11 21.95V18a2 2 0 0 0-2-2a2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05"></path><circle cx="12" cy="12" r="10"></circle></svg>Browser</span><kbd>⌘T</kbd></button><button aria-label="Files" aria-pressed="false" data-tool-id="files" type="button" title="Files · ⌘P"><span class="capability-label"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-file-text"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path><path d="M10 9H8"></path><path d="M16 13H8"></path><path d="M16 17H8"></path></svg>Files</span><kbd>⌘P</kbd></button><button aria-label="Side chat" aria-pressed="false" data-tool-id="sidechat" type="button" title="Side chat · ⌥⌘S"><span class="capability-label"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-bot-message-square"><path d="M12 6V2H8"></path><path d="m8 18-4 4V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2Z"></path><path d="M2 12h2"></path><path d="M9 11v2"></path><path d="M15 11v2"></path><path d="M20 12h2"></path></svg>Side chat</span><kbd>⌥⌘S</kbd></button></div><div class="capability-dock-content"><section class="capability-result" data-panel-kind="terminal" aria-live="polite"><div class="capability-result-header"><strong>Terminal</strong><span>Workspace shell</span></div><form class="capability-command-form"><input aria-label="Terminal command" disabled="" spellCheck="false" value="pnpm test"/><button type="submit" disabled="">Running</button></form><pre class="capability-result-output">Last command finished successfully.</pre><div class="capability-field-list"><label><span>Profile</span><select><option value="default" selected="">Default</option><option value="ci">CI</option></select></label><label><span>Token</span><input type="password" value="secret"/></label></div><div class="capability-result-actions"><button type="button" data-tone="primary">Refresh</button></div><ul class="capability-result-list"><li><button type="button" class="capability-result-item" data-has-icon="true" title="/repo"><span class="capability-result-item-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-folder" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path></svg></span><span class="capability-result-item-label">Open workspace</span></button></li><li><button type="button" class="capability-result-item" data-has-icon="true" title="Background job"><span class="capability-result-item-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-square-terminal" aria-hidden="true"><path d="m7 11 2-2-2-2"></path><path d="M11 13h4"></path><rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect></svg></span><span class="capability-result-item-label">Background job</span></button></li></ul></section></div></div>"`);
  });
});
