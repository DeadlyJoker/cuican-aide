import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Globe2,
  MoreVertical,
  RotateCw,
} from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";

import { isTauri } from "@tauri-apps/api/core";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type { Locale } from "../../lib/i18n";

type BrowserHistory = {
  entries: string[];
  index: number;
};

function localhostUrl(value: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(value);
}

export function normalizeWorkbenchBrowserUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (/^[a-z][a-z\d+.-]*:(?!\/\/)/i.test(trimmed) && !localhostUrl(trimmed)) {
    return null;
  }
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `${localhostUrl(trimmed) ? "http" : "https"}://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function browserTitle(url: string | null, locale: Locale): string {
  if (!url) {
    return locale === "zh" ? "新标签页" : "New tab";
  }
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function NativeBrowserViewport({
  active,
  instanceId,
  locale,
  reloadKey,
  url,
}: {
  active: boolean;
  instanceId: string;
  locale: Locale;
  reloadKey: number;
  url: string;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const native = isTauri();

  useEffect(() => {
    if (!active || !native || !viewportRef.current) {
      return;
    }

    let disposed = false;
    let childWebview: Webview | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const webviewLabel = `crewon-workbench-browser-${instanceId.replace(/[^a-zA-Z0-9-]/g, "-")}`;

    async function syncBounds() {
      if (!childWebview || !viewportRef.current || disposed) {
        return;
      }
      const rect = viewportRef.current.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) {
        await childWebview.hide();
        return;
      }
      await Promise.all([
        childWebview.setPosition(new LogicalPosition(rect.left, rect.top)),
        childWebview.setSize(new LogicalSize(rect.width, rect.height)),
      ]);
      await childWebview.show();
    }

    void (async () => {
      try {
        await (await Webview.getByLabel(webviewLabel))?.close();
        if (disposed || !viewportRef.current) {
          return;
        }
        const rect = viewportRef.current.getBoundingClientRect();
        childWebview = new Webview(getCurrentWindow(), webviewLabel, {
          focus: true,
          height: Math.max(1, rect.height),
          url,
          width: Math.max(1, rect.width),
          x: rect.left,
          y: rect.top,
        });
        void childWebview.once("tauri://created", () => {
          setNativeError(null);
          void syncBounds();
        });
        void childWebview.once<string>("tauri://error", (event) => {
          setNativeError(String(event.payload));
        });
        resizeObserver = new ResizeObserver(() => void syncBounds());
        resizeObserver.observe(viewportRef.current);
      } catch (error) {
        setNativeError(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      if (childWebview) {
        void childWebview.close();
      }
    };
  }, [active, instanceId, native, reloadKey, url]);

  return (
    <div className="command-browser-viewport" ref={viewportRef}>
      {native ? (
        nativeError ? (
          <div className="command-browser-error" role="alert">
            <Globe2 aria-hidden="true" />
            <strong>
              {locale === "zh" ? "页面打开失败" : "Unable to open page"}
            </strong>
            <span>{nativeError}</span>
          </div>
        ) : (
          <div className="command-browser-loading" aria-live="polite">
            {locale === "zh" ? "正在打开页面…" : "Opening page…"}
          </div>
        )
      ) : (
        <iframe
          key={`${url}:${reloadKey}`}
          referrerPolicy="strict-origin-when-cross-origin"
          src={url}
          title={browserTitle(url, locale)}
        />
      )}
    </div>
  );
}

export function CommandWorkbenchBrowser({
  active,
  instanceId,
  locale,
  onNewTab,
  onTitleChange,
}: {
  active: boolean;
  instanceId: string;
  locale: Locale;
  onNewTab: () => void;
  onTitleChange: (title: string) => void;
}) {
  const [history, setHistory] = useState<BrowserHistory>({
    entries: [],
    index: -1,
  });
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const onNewTabRef = useRef(onNewTab);
  const onTitleChangeRef = useRef(onTitleChange);
  onNewTabRef.current = onNewTab;
  onTitleChangeRef.current = onTitleChange;
  const currentUrl = history.entries[history.index] ?? null;

  useEffect(() => {
    onTitleChangeRef.current(browserTitle(currentUrl, locale));
  }, [currentUrl, locale]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    function dismissMenu(event: KeyboardEvent | PointerEvent) {
      if (event instanceof KeyboardEvent && event.key === "Escape") {
        setMenuOpen(false);
        return;
      }
      if (
        event instanceof PointerEvent &&
        menuRef.current &&
        !menuRef.current.contains(event.target as Node)
      ) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("keydown", dismissMenu);
    document.addEventListener("pointerdown", dismissMenu);
    return () => {
      document.removeEventListener("keydown", dismissMenu);
      document.removeEventListener("pointerdown", dismissMenu);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!active) {
      return;
    }
    function handleShortcut(event: KeyboardEvent) {
      const commandKey = event.metaKey || event.ctrlKey;
      if (commandKey && event.key.toLocaleLowerCase() === "l") {
        event.preventDefault();
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
      } else if (commandKey && event.key.toLocaleLowerCase() === "r") {
        event.preventDefault();
        if (currentUrl) {
          setReloadKey((current) => current + 1);
        }
      } else if (commandKey && event.key.toLocaleLowerCase() === "t") {
        event.preventDefault();
        onNewTabRef.current();
      } else if (
        event.altKey &&
        event.key === "ArrowLeft" &&
        history.index > 0
      ) {
        event.preventDefault();
        moveHistory(history.index - 1);
      } else if (
        event.altKey &&
        event.key === "ArrowRight" &&
        history.index >= 0 &&
        history.index < history.entries.length - 1
      ) {
        event.preventDefault();
        moveHistory(history.index + 1);
      }
    }
    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  }, [active, currentUrl, history]);

  function navigate(value: string) {
    const url = normalizeWorkbenchBrowserUrl(value);
    if (!url) {
      setAddressError(
        locale === "zh"
          ? "请输入有效的 http(s) URL"
          : "Enter a valid http(s) URL",
      );
      return;
    }
    setAddressError(null);
    setAddress(url);
    setHistory((current) => ({
      entries: [...current.entries.slice(0, current.index + 1), url],
      index: current.index + 1,
    }));
  }

  function moveHistory(index: number) {
    const url = history.entries[index];
    if (!url) {
      return;
    }
    setAddressError(null);
    setAddress(url);
    setHistory((current) => ({ ...current, index }));
  }

  function submitAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate(address);
  }

  function openBlankTab() {
    setMenuOpen(false);
    onNewTabRef.current();
  }

  return (
    <div
      className="command-browser"
      data-has-page={currentUrl ? "true" : "false"}
    >
      <div className="command-browser-toolbar">
        <div className="command-browser-nav">
          <button
            aria-label={locale === "zh" ? "后退" : "Back"}
            disabled={history.index <= 0}
            type="button"
            onClick={() => moveHistory(history.index - 1)}
          >
            <ArrowLeft aria-hidden="true" />
          </button>
          <button
            aria-label={locale === "zh" ? "前进" : "Forward"}
            disabled={
              history.index < 0 || history.index >= history.entries.length - 1
            }
            type="button"
            onClick={() => moveHistory(history.index + 1)}
          >
            <ArrowRight aria-hidden="true" />
          </button>
          <button
            aria-label={locale === "zh" ? "重新加载" : "Reload"}
            disabled={!currentUrl}
            type="button"
            onClick={() => setReloadKey((current) => current + 1)}
          >
            <RotateCw aria-hidden="true" />
          </button>
        </div>
        <form className="command-browser-address" onSubmit={submitAddress}>
          <input
            ref={addressInputRef}
            aria-invalid={addressError ? "true" : undefined}
            aria-label={locale === "zh" ? "浏览器地址" : "Browser address"}
            placeholder={locale === "zh" ? "输入 URL" : "Enter URL"}
            spellCheck={false}
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setAddressError(null);
            }}
          />
          <button
            aria-label={locale === "zh" ? "打开页面" : "Open page"}
            type="submit"
          >
            <ArrowUpRight aria-hidden="true" />
          </button>
          {addressError ? <span role="alert">{addressError}</span> : null}
        </form>
        <div className="command-browser-menu-anchor" ref={menuRef}>
          <button
            aria-expanded={menuOpen}
            aria-label={locale === "zh" ? "浏览器菜单" : "Browser menu"}
            className="command-browser-more"
            type="button"
            onClick={() => setMenuOpen((current) => !current)}
          >
            <MoreVertical aria-hidden="true" />
          </button>
          {menuOpen ? (
            <div className="command-browser-menu" role="menu">
              <button role="menuitem" type="button" onClick={openBlankTab}>
                {locale === "zh" ? "新标签页" : "New tab"}
              </button>
              <button
                disabled={!currentUrl}
                role="menuitem"
                type="button"
                onClick={() => {
                  if (currentUrl) {
                    window.open(currentUrl, "_blank", "noopener,noreferrer");
                  }
                  setMenuOpen(false);
                }}
              >
                {locale === "zh" ? "在独立窗口打开" : "Open in separate window"}
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {currentUrl ? (
        <NativeBrowserViewport
          active={active}
          instanceId={instanceId}
          locale={locale}
          reloadKey={reloadKey}
          url={currentUrl}
        />
      ) : (
        <div className="command-browser-empty">
          <Globe2 aria-hidden="true" />
          <strong>{locale === "zh" ? "开始浏览" : "Start browsing"}</strong>
          <span>
            {locale === "zh"
              ? "输入 URL 以打开页面"
              : "Enter a URL to open a page"}
          </span>
        </div>
      )}
    </div>
  );
}
