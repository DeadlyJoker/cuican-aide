import { BrowserWindow, WebContentsView, shell } from "electron";

import type { DesktopRectangle } from "../src/lib/desktop/desktopBridge.ts";

export class BrowserViewManager {
  readonly #views = new Map<string, WebContentsView>();

  constructor(private readonly window: BrowserWindow) {}

  async create(
    id: unknown,
    rawUrl: unknown,
    rawBounds: unknown,
  ): Promise<void> {
    const key = browserId(id);
    const url = browserUrl(rawUrl);
    const bounds = rectangle(rawBounds);
    this.destroy(key);
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    view.webContents.setWindowOpenHandler(({ url: target }) => {
      void openExternal(target);
      return { action: "deny" };
    });
    view.webContents.on("will-navigate", (event, target) => {
      try {
        browserUrl(target);
      } catch {
        event.preventDefault();
      }
    });
    this.window.contentView.addChildView(view);
    view.setBounds(bounds);
    this.#views.set(key, view);
    try {
      await view.webContents.loadURL(url);
    } catch (error) {
      this.destroy(key);
      throw error;
    }
  }

  updateBounds(id: unknown, value: unknown): void {
    const view = this.#views.get(browserId(id));
    if (view === undefined) return;
    view.setBounds(rectangle(value));
  }

  setVisible(id: unknown, visible: unknown): void {
    const view = this.#views.get(browserId(id));
    if (view === undefined) return;
    if (typeof visible !== "boolean")
      throw new Error("desktop_browser_visibility_invalid");
    view.setVisible(visible);
  }

  destroy(id: unknown): void {
    const key = browserId(id);
    const view = this.#views.get(key);
    if (view === undefined) return;
    this.#views.delete(key);
    this.window.contentView.removeChildView(view);
    view.webContents.close();
  }

  destroyAll(): void {
    for (const id of [...this.#views.keys()]) this.destroy(id);
  }
}

export async function openExternal(value: unknown): Promise<void> {
  const url = browserUrl(value);
  await shell.openExternal(url);
}

function browserId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)
  ) {
    throw new Error("desktop_browser_id_invalid");
  }
  return value;
}

function browserUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 8_192) {
    throw new Error("desktop_browser_url_invalid");
  }
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new Error("desktop_browser_url_invalid");
  }
  return url.toString();
}

function rectangle(value: unknown): DesktopRectangle {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("desktop_browser_bounds_invalid");
  }
  const input = value as Record<string, unknown>;
  const bounds = {
    x: integer(input.x),
    y: integer(input.y),
    width: integer(input.width, 1),
    height: integer(input.height, 1),
  };
  if (bounds.width > 16_384 || bounds.height > 16_384) {
    throw new Error("desktop_browser_bounds_invalid");
  }
  return bounds;
}

function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error("desktop_browser_bounds_invalid");
  }
  return Number(value);
}
