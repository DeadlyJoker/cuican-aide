import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Languages,
  Minus,
  Moon,
  PanelLeft,
  PanelRight,
  SlidersHorizontal,
  Square,
  Sun,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Locale } from "../lib/i18n";
import type { PlatformKind } from "../lib/platform";
import type { Theme } from "../lib/theme";

type TitleBarProps = {
  locale: Locale;
  platform: PlatformKind;
  capabilityDockOpen: boolean;
  inspectorOpen: boolean;
  sidebarOpen: boolean;
  theme: Theme;
  title: string;
  hideSidebarLabel: string;
  inspectorLabel: string;
  languageLabel: string;
  showSidebarLabel: string;
  themeLabel: string;
  capabilityLabel: string;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onToggleCapabilityDock: () => void;
  onLocaleChange: (locale: Locale) => void;
  onToggleTheme: () => void;
};

export function TitleBar({
  capabilityDockOpen,
  inspectorOpen,
  locale,
  platform,
  sidebarOpen,
  theme,
  title,
  hideSidebarLabel,
  inspectorLabel,
  languageLabel,
  showSidebarLabel,
  themeLabel,
  capabilityLabel,
  onToggleSidebar,
  onToggleInspector,
  onToggleCapabilityDock,
  onLocaleChange,
  onToggleTheme,
}: TitleBarProps) {
  const sidebarLabel = sidebarOpen ? hideSidebarLabel : showSidebarLabel;
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const languageMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!languageMenuOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (
        target instanceof Element &&
        languageMenuRef.current?.contains(target)
      ) {
        return;
      }

      setLanguageMenuOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setLanguageMenuOpen(false);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [languageMenuOpen]);

  function selectLocale(nextLocale: Locale) {
    onLocaleChange(nextLocale);
    setLanguageMenuOpen(false);
  }

  return (
    <header className="titlebar" data-platform={platform}>
      <div className="window-controls" aria-hidden="true">
        {platform === "mac" ? (
          <>
            <span className="traffic-light close" />
            <span className="traffic-light minimize" />
            <span className="traffic-light zoom" />
          </>
        ) : platform === "windows" ? (
          <>
            <button className="window-button" type="button" tabIndex={-1}>
              <Minus size={14} />
            </button>
            <button className="window-button" type="button" tabIndex={-1}>
              <Square size={12} />
            </button>
            <button
              className="window-button close-button"
              type="button"
              tabIndex={-1}
            >
              <X size={14} />
            </button>
          </>
        ) : (
          <span className="web-window-spacer" />
        )}
      </div>
      <button
        className="icon-button"
        type="button"
        aria-expanded={sidebarOpen}
        aria-label={sidebarLabel}
        title={sidebarLabel}
        onClick={onToggleSidebar}
      >
        <PanelLeft size={17} />
      </button>
      <div className="titlebar-history" aria-hidden="true">
        <button className="icon-button" type="button" tabIndex={-1}>
          <ChevronLeft size={15} />
        </button>
        <button className="icon-button" type="button" tabIndex={-1}>
          <ChevronRight size={15} />
        </button>
      </div>
      <div className="titlebar-title">
        <strong>{title}</strong>
      </div>
      <div className="titlebar-actions">
        <button
          className="icon-button titlebar-model-button"
          type="button"
          aria-label="Model"
        >
          <Code2 size={14} />
          <ChevronDown size={12} />
        </button>
        <div className="language-menu" ref={languageMenuRef}>
          <button
            className="icon-button language-menu-trigger"
            type="button"
            aria-expanded={languageMenuOpen}
            aria-label={languageLabel}
            title={languageLabel}
            onClick={() => setLanguageMenuOpen((open) => !open)}
          >
            <Languages size={15} />
          </button>
          {languageMenuOpen ? (
            <div
              className="language-menu-popover"
              role="menu"
              aria-label={languageLabel}
            >
              <button
                type="button"
                role="menuitemradio"
                aria-checked={locale === "zh"}
                data-active={locale === "zh"}
                onClick={() => selectLocale("zh")}
              >
                中文
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={locale === "en"}
                data-active={locale === "en"}
                onClick={() => selectLocale("en")}
              >
                English
              </button>
            </div>
          ) : null}
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label={themeLabel}
          title={themeLabel}
          onClick={onToggleTheme}
        >
          {theme === "light" ? <Moon size={15} /> : <Sun size={15} />}
        </button>
        <button
          className="icon-button titlebar-env-toggle"
          type="button"
          aria-expanded={inspectorOpen}
          aria-label={inspectorLabel}
          title={inspectorLabel}
          onClick={onToggleInspector}
        >
          <SlidersHorizontal size={15} />
        </button>
        <button
          className="icon-button capability-dock-trigger"
          type="button"
          aria-expanded={capabilityDockOpen}
          aria-label={capabilityLabel}
          title={capabilityLabel}
          onClick={onToggleCapabilityDock}
        >
          <PanelRight size={16} />
        </button>
      </div>
    </header>
  );
}
