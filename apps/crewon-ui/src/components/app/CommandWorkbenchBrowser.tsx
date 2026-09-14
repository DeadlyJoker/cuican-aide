import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Globe2,
  MoreVertical,
  RotateCw,
} from "lucide-react";
import {
  FormEvent,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import {
  allocateNativeBrowserViewId,
  startNativeBrowserViewGeneration,
  syncNativeBrowserViewForReveal,
} from "./nativeBrowserViewLifecycle";
import { getDesktopBridge } from "../../lib/desktop/desktopBridge";
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
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
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
  linkedPreview,
  active,
  instanceId,
  locale,
  obscured,
  reloadKey,
  url,
}: {
  linkedPreview: boolean;
  active: boolean;
  instanceId: string;
  locale: Locale;
  obscured: boolean;
  reloadKey: number;
  url: string;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const childViewRef = useRef<string | null>(null);
  const lastBoundsRef = useRef<{
    h: number;
    w: number;
    x: number;
    y: number;
  } | null>(null);
  const syncBoundsRef = useRef<(() => Promise<void>) | null>(null);
  const obscuredRef = useRef(obscured);
  obscuredRef.current = obscured;
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [nativeReady, setNativeReady] = useState(false);
  const bridge = getDesktopBridge();
  const native = bridge !== null;

  useEffect(() => {
    if (!active || bridge === null || !viewportRef.current) {
      return;
    }

    let generationActive = true;
    let resizeObserver: ResizeObserver | null = null;
    const webviewLabel = allocateNativeBrowserViewId(instanceId);
    const browser = bridge.browser;
    setNativeReady(false);

    async function syncBounds(forceVisibilitySync = false) {
      const childView = childViewRef.current;
      if (
        childView !== webviewLabel ||
        !viewportRef.current ||
        !generationActive
      ) {
        return;
      }
      const rect = viewportRef.current.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) {
        lastBoundsRef.current = null;
        await browser.setVisible(childView, false);
        return;
      }
      const next = {
        h: Math.round(rect.height),
        w: Math.round(rect.width),
        x: Math.round(rect.left),
        y: Math.round(rect.top),
      };
      const last = lastBoundsRef.current;
      if (
        last &&
        last.x === next.x &&
        last.y === next.y &&
        last.w === next.w &&
        last.h === next.h &&
        !forceVisibilitySync
      ) {
        return;
      }
      await syncNativeBrowserViewForReveal({
        bounds: {
          x: next.x,
          y: next.y,
          width: next.w,
          height: next.h,
        },
        browser,
        id: childView,
        isCurrent: () =>
          generationActive && childViewRef.current === webviewLabel,
        isObscured: () => obscuredRef.current,
      });
      if (generationActive && childViewRef.current === webviewLabel) {
        lastBoundsRef.current = next;
      }
    }
    const syncVisibility = () => syncBounds(true);
    syncBoundsRef.current = syncVisibility;

    const generation = startNativeBrowserViewGeneration({
      browser,
      getBounds: () => {
        if (!viewportRef.current) return null;
        const rect = viewportRef.current.getBoundingClientRect();
        return {
          x: Math.max(0, Math.round(rect.left)),
          y: Math.max(0, Math.round(rect.top)),
          width: Math.max(1, Math.round(rect.width)),
          height: Math.max(1, Math.round(rect.height)),
        };
      },
      id: webviewLabel,
      url,
    });

    void generation.completion
      .then(async (result) => {
        if (result !== "ready" || !generationActive) return;
        childViewRef.current = webviewLabel;
        await syncBounds();
        if (!generationActive || childViewRef.current !== webviewLabel) return;
        setNativeError(null);
        setNativeReady(true);
        resizeObserver = new ResizeObserver(() => void syncBounds());
        if (viewportRef.current) {
          resizeObserver.observe(viewportRef.current);
        }
      })
      .catch((error) => {
        if (!generationActive) return;
        setNativeError(error instanceof Error ? error.message : String(error));
      });

    // ResizeObserver only fires on size changes. Sidebar toggles, window
    // moves, and layout shifts move the viewport without resizing it, so poll
    // on an interval and let the bounds-equality guard make it a no-op.
    const boundsPoll = window.setInterval(() => void syncBounds(), 400);

    return () => {
      generationActive = false;
      window.clearInterval(boundsPoll);
      resizeObserver?.disconnect();
      lastBoundsRef.current = null;
      if (childViewRef.current === webviewLabel) {
        childViewRef.current = null;
      }
      if (syncBoundsRef.current === syncVisibility) {
        syncBoundsRef.current = null;
      }
      void generation.dispose();
    };
  }, [active, bridge, instanceId, native, reloadKey, url]);

  // The native webview floats above every HTML overlay, so hide it while the
  // toolbar menu (or any layer above the viewport) is open.
  useEffect(() => {
    const childView = childViewRef.current;
    if (!childView || bridge === null) {
      return;
    }
    if (obscured || !active) {
      void bridge.browser.setVisible(childView, false);
    } else {
      void syncBoundsRef.current?.();
    }
  }, [obscured, active, reloadKey, url]);

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
        ) : nativeReady ? null : (
          <div className="command-browser-loading" aria-live="polite">
            {locale === "zh" ? "正在打开页面…" : "Opening page…"}
          </div>
        )
      ) : (
        <iframe
          sandbox={
            linkedPreview
              ? "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
              : undefined
          }
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
  initialUrl,
  sourceLabel,
  active,
  instanceId,
  interactive = active,
  locale,
  obscured = false,
  onNewTab,
  onTitleChange,
}: {
  initialUrl?: string;
  sourceLabel?: string;
  active: boolean;
  instanceId: string;
  interactive?: boolean;
  locale: Locale;
  obscured?: boolean;
  onNewTab: () => void;
  onTitleChange: (title: string) => void;
}) {
  const [history, setHistory] = useState<BrowserHistory>({
    entries:
      initialUrl && normalizeWorkbenchBrowserUrl(initialUrl)
        ? [normalizeWorkbenchBrowserUrl(initialUrl)!]
        : [],
    index: initialUrl && normalizeWorkbenchBrowserUrl(initialUrl) ? 0 : -1,
  });
  const [address, setAddress] = useState(history.entries[0] ?? "");
  const [addressError, setAddressError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const onNewTabRef = useRef(onNewTab);
  const onTitleChangeRef = useRef(onTitleChange);
  onNewTabRef.current = onNewTab;
  onTitleChangeRef.current = onTitleChange;
  const currentUrl = history.entries[history.index] ?? null;
  const recording = getDesktopBridge()?.recording;

  useEffect(() => {
    onTitleChangeRef.current(browserTitle(currentUrl, locale));
  }, [currentUrl, locale]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    function dismissMenu(event: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", dismissMenu);
    return () => {
      document.removeEventListener("pointerdown", dismissMenu);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!interactive) {
      setMenuOpen(false);
    }
  }, [interactive]);

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!menuOpen || event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setMenuOpen(false);
    window.requestAnimationFrame(() => {
      menuButtonRef.current?.focus();
    });
  }

  useEffect(() => {
    if (!interactive) {
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
  }, [currentUrl, history, interactive]);

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
      data-linked-preview={sourceLabel ? "true" : undefined}
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
        <div
          className="command-browser-menu-anchor"
          ref={menuRef}
          onKeyDown={handleMenuKeyDown}
        >
          <button
            ref={menuButtonRef}
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
                disabled={!recording}
                role="menuitem"
                title={
                  !recording
                    ? locale === "zh"
                      ? "需要 CrewON 桌面应用"
                      : "Requires the CrewON desktop app"
                    : undefined
                }
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  void recording?.open().catch((error: unknown) => {
                    setAddressError(
                      error instanceof Error ? error.message : String(error),
                    );
                  });
                }}
              >
                {locale === "zh" ? "浏览器教学" : "Browser teaching"}
                {!recording
                  ? locale === "zh"
                    ? " · 仅桌面端"
                    : " · Desktop only"
                  : ""}
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
      {sourceLabel ? (
        <div className="command-browser-source">
          <p title={sourceLabel}>
            {locale === "zh"
              ? "来自当前任务的独立网页预览；不会重放 Agent 操作或共享其会话。"
              : "Independent task preview; no Agent action replay or shared session."}
          </p>
          <p>
            {locale === "zh"
              ? "如网站禁止嵌入，可在浏览器菜单中选择独立窗口打开。"
              : "If embedding is blocked, use the browser menu to open a separate window."}
          </p>
        </div>
      ) : null}
      {currentUrl ? (
        <NativeBrowserViewport
          linkedPreview={Boolean(sourceLabel)}
          active={active}
          instanceId={instanceId}
          locale={locale}
          obscured={menuOpen || obscured}
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
