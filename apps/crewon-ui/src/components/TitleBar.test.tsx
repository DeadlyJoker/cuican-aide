import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TitleBar } from "./TitleBar";

describe("TitleBar", () => {
  it("renders window controls, navigation, and action buttons", () => {
    const markup = renderToStaticMarkup(
      <TitleBar
        capabilityDockOpen={true}
        capabilityLabel="Capabilities"
        hideSidebarLabel="Hide sidebar"
        inspectorLabel="Inspector"
        inspectorOpen={false}
        languageLabel="Language"
        locale="en"
        platform="windows"
        showSidebarLabel="Show sidebar"
        sidebarOpen={true}
        theme="light"
        themeLabel="Toggle theme"
        title="Crewon"
        onLocaleChange={vi.fn()}
        onToggleCapabilityDock={vi.fn()}
        onToggleInspector={vi.fn()}
        onToggleSidebar={vi.fn()}
        onToggleTheme={vi.fn()}
      />,
    );

    expect(markup).toContain("Crewon");
    expect(markup).toContain("Hide sidebar");
    expect(markup).toContain("Capabilities");
    expect(markup).toMatchInlineSnapshot(`"<header class="titlebar" data-platform="windows"><div class="window-controls" aria-hidden="true"><button class="window-button" type="button" tabindex="-1"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-minus"><path d="M5 12h14"></path></svg></button><button class="window-button" type="button" tabindex="-1"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-square"><rect width="18" height="18" x="3" y="3" rx="2"></rect></svg></button><button class="window-button close-button" type="button" tabindex="-1"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div><button class="icon-button" type="button" aria-expanded="true" aria-label="Hide sidebar" title="Hide sidebar"><svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-panel-left"><rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M9 3v18"></path></svg></button><div class="titlebar-history" aria-hidden="true"><button class="icon-button" type="button" tabindex="-1"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-left"><path d="m15 18-6-6 6-6"></path></svg></button><button class="icon-button" type="button" tabindex="-1"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-right"><path d="m9 18 6-6-6-6"></path></svg></button></div><div class="titlebar-title"><strong>Crewon</strong></div><div class="titlebar-actions"><button class="icon-button titlebar-model-button" type="button" aria-label="Model"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-code-xml"><path d="m18 16 4-4-4-4"></path><path d="m6 8-4 4 4 4"></path><path d="m14.5 4-5 16"></path></svg><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down"><path d="m6 9 6 6 6-6"></path></svg></button><div class="language-menu"><button class="icon-button language-menu-trigger" type="button" aria-expanded="false" aria-label="Language" title="Language"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-languages"><path d="m5 8 6 6"></path><path d="m4 14 6-6 2-3"></path><path d="M2 5h12"></path><path d="M7 2h1"></path><path d="m22 22-5-10-5 10"></path><path d="M14 18h6"></path></svg></button></div><button class="icon-button" type="button" aria-label="Toggle theme" title="Toggle theme"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-moon"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path></svg></button><button class="icon-button titlebar-env-toggle" type="button" aria-expanded="false" aria-label="Inspector" title="Inspector"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sliders-horizontal"><line x1="21" x2="14" y1="4" y2="4"></line><line x1="10" x2="3" y1="4" y2="4"></line><line x1="21" x2="12" y1="12" y2="12"></line><line x1="8" x2="3" y1="12" y2="12"></line><line x1="21" x2="16" y1="20" y2="20"></line><line x1="12" x2="3" y1="20" y2="20"></line><line x1="14" x2="14" y1="2" y2="6"></line><line x1="8" x2="8" y1="10" y2="14"></line><line x1="16" x2="16" y1="18" y2="22"></line></svg></button><button class="icon-button capability-dock-trigger" type="button" aria-expanded="true" aria-label="Capabilities" title="Capabilities"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-panel-right"><rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M15 3v18"></path></svg></button></div></header>"`);
  });
});
