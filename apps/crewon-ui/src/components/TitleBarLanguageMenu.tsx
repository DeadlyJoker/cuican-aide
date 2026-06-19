import { Languages } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Locale } from "../lib/i18n";

export function TitleBarLanguageMenu({
  locale,
  languageLabel,
  onLocaleChange,
}: {
  locale: Locale;
  languageLabel: string;
  onLocaleChange: (locale: Locale) => void;
}) {
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
  );
}
