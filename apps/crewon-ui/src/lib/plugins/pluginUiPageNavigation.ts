import {
  PLUGIN_UI_NAVIGATION_ACTIONS as actions,
  type PluginUiNavigationRequest,
  type PluginUiLease,
  type PluginUiJsonValue,
} from "@crewon/contracts/plugins";
import type {
  ControlPluginUiCatalog,
  ControlPluginUiModule,
} from "./controlPluginUiCatalog";
import { PluginUiLoaderError } from "./pluginUiValidation";

export type PluginUiPage = Readonly<{
  pageId: string;
  routeId: string;
  sourceKey: string;
  moduleKey: string;
  key: string;
  title: string;
  context: PluginUiJsonValue;
  home: boolean;
}>;
export type PluginUiPageRequest = Readonly<{
  id: string;
  requestKey: string;
  panelOpen: boolean;
  hideOnlyGroup?: string;
  activateOnlyIfSelectedId?: string;
}>;
export type PluginUiPageSnapshot = Readonly<{
  pages: readonly PluginUiPage[];
  request: PluginUiPageRequest | null;
}>;
export const EMPTY_PLUGIN_UI_PAGE_SNAPSHOT: PluginUiPageSnapshot =
  Object.freeze({
    pages: Object.freeze([]),
    request: null,
  });
export function pluginUiPageSourceKey(module: ControlPluginUiModule): string {
  return JSON.stringify([
    module.plugin.descriptor.pluginId,
    module.plugin.descriptor.publisherId,
    module.plugin.packageDigest,
    module.plugin.selectionRevision,
  ]);
}

/** UI-only instances share the original Catalog and mount lifecycle. Nothing here issues a Thread, Run or workspace grant. */
export class PluginUiPageNavigation {
  readonly #catalog: () => ControlPluginUiCatalog | null;
  readonly #assertCurrent: () => void;
  readonly #nextId: () => string;
  readonly #listeners = new Set<() => void>();
  #snapshot: PluginUiPageSnapshot = EMPTY_PLUGIN_UI_PAGE_SNAPSHOT;
  #sequence = 0;
  readonly #namespace = crypto.randomUUID();
  #closed = false;
  constructor(
    input: Readonly<{
      catalog(): ControlPluginUiCatalog | null;
      assertCurrent(): void;
      nextId?(): string;
    }>,
  ) {
    this.#catalog = input.catalog;
    this.#assertCurrent = input.assertCurrent;
    this.#nextId = input.nextId ?? (() => `page-${crypto.randomUUID()}`);
  }
  snapshot = (): PluginUiPageSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  activate(): void {
    this.#closed = false;
  }
  close(): void {
    this.#closed = true;
    this.#snapshot = EMPTY_PLUGIN_UI_PAGE_SNAPSHOT;
    this.#listeners.clear();
  }
  synchronize(): void {
    if (this.#closed) return;
    const catalog = this.#catalog();
    if (!catalog) return;
    const keys = new Set(catalog.modules.map(pluginUiPageSourceKey));
    const pages = this.#snapshot.pages.filter((page) =>
      keys.has(page.sourceKey),
    );
    if (pages.length !== this.#snapshot.pages.length)
      this.#publish(pages, null);
  }
  openFromHost(moduleKey: string): void {
    const module = this.#modules().find((item) => item.key === moduleKey);
    if (!module) fail("plugin_ui_page_unavailable");
    const source = pluginUiPageSourceKey(module);
    let pages = this.#snapshot.pages;
    if (
      !pages.some(
        (page) => page.moduleKey === moduleKey && page.sourceKey === source,
      )
    ) {
      this.openHomeFromHost(moduleKey);
      return;
    }
    this.#capacity(source, 1, pages);
    const page = this.#page(
      module,
      {
        key: `new-${++this.#sequence}`,
        title: `${module.title} ${pages.filter((item) => item.moduleKey === moduleKey).length + 1}`,
        context: null,
        home: false,
      },
      pages,
    );
    this.#publish([...pages, page], this.#request(page.routeId, true));
  }
  openHomeFromHost(moduleKey: string): void {
    const module = this.#modules().find((item) => item.key === moduleKey);
    if (!module) fail("plugin_ui_page_unavailable");
    const sourceKey = pluginUiPageSourceKey(module);
    const existing = this.#snapshot.pages.find(
      (page) =>
        page.home &&
        page.moduleKey === moduleKey &&
        page.sourceKey === sourceKey,
    );
    if (existing) {
      this.activateFromHost(existing.pageId);
      return;
    }
    this.#capacity(sourceKey, 1);
    const home = this.#page(module, {
      key: "home",
      title: module.title,
      context: null,
      home: true,
    });
    this.#publish(
      [...this.#snapshot.pages, home],
      this.#request(home.routeId, true),
    );
  }
  activateFromHost(pageId: string): void {
    this.#modules();
    const page = this.#snapshot.pages.find((item) => item.pageId === pageId);
    if (!page) fail("plugin_ui_page_unavailable");
    this.#publish(this.#snapshot.pages, this.#request(page.routeId, true));
  }
  async invoke(
    lease: PluginUiLease,
    request: PluginUiNavigationRequest,
    signal: AbortSignal,
  ): Promise<PluginUiJsonValue> {
    signal.throwIfAborted();
    const modules = this.#leasedModules(lease),
      source = pluginUiPageSourceKey(modules[0]!);
    const version = "crewon.plugin-ui-navigation.v1";
    const own = () =>
      this.#snapshot.pages.filter((page) => page.sourceKey === source);
    switch (request.action) {
      case actions.openPage: {
        const target = modules.find(
          (module) => module.contributionId === request.input.contributionId,
        );
        if (!target) fail("plugin_ui_page_contribution_unavailable");
        const existing =
          request.input.mode === "reuse"
            ? own().find(
                (page) =>
                  page.moduleKey === target.key &&
                  page.key === request.input.key,
              )
            : undefined;
        if (existing) {
          this.#publish(
            this.#snapshot.pages.map((page) =>
              page.pageId === existing.pageId
                ? Object.freeze({
                    ...page,
                    title: request.input.title,
                    context: request.input.context,
                  })
                : page,
            ),
            this.#request(existing.routeId, true),
          );
          return { version, pageId: existing.pageId };
        }
        this.#capacity(source, 1);
        const page = this.#page(target, { ...request.input, home: false });
        this.#publish(
          [...this.#snapshot.pages, page],
          this.#request(page.routeId, true),
        );
        return { version, pageId: page.pageId };
      }
      case actions.activatePage: {
        const page = own().find((page) => page.pageId === request.input.pageId);
        if (!page) fail("plugin_ui_page_unavailable");
        this.#publish(this.#snapshot.pages, this.#request(page.routeId, true));
        return { version, pageId: page.pageId };
      }
      case actions.closePage: {
        const page = own().find((page) => page.pageId === request.input.pageId);
        if (!page) fail("plugin_ui_page_unavailable");
        this.closeFromHost(page.pageId);
        return { version, closed: true };
      }
      case actions.toggleWorkbench: {
        const page = own().at(-1);
        this.#publish(this.#snapshot.pages, {
          ...this.#request(
            page?.routeId ?? modules[0]!.key,
            request.input.state === "open",
          ),
          ...(request.input.state === "closed"
            ? { hideOnlyGroup: lease.descriptor.pluginId }
            : {}),
        });
        return { version, state: request.input.state };
      }
      case actions.listPages:
        return {
          version,
          pages: own().map((page) => ({
            pageId: page.pageId,
            title: page.title,
            contributionId: modules.find(
              (module) => module.key === page.moduleKey,
            )!.contributionId,
          })),
        };
    }
  }
  closeFromHost(pageId: string): void {
    this.#modules();
    const page = this.#snapshot.pages.find((item) => item.pageId === pageId);
    if (!page) fail("plugin_ui_page_unavailable");
    const pages = this.#snapshot.pages.filter((item) => item.pageId !== pageId),
      next =
        pages.filter((item) => item.sourceKey === page.sourceKey).at(-1) ??
        pages[
          Math.min(
            this.#snapshot.pages.findIndex((item) => item.pageId === pageId),
            pages.length - 1,
          )
        ];
    const module = this.#modules().find((item) => item.key === page.moduleKey);
    if (!module) fail("plugin_ui_page_unavailable");
    this.#publish(pages, {
      ...this.#request(next?.routeId ?? module.key, !!next),
      activateOnlyIfSelectedId: page.routeId,
      ...(!next ? { hideOnlyGroup: module.plugin.descriptor.pluginId } : {}),
    });
  }
  #modules(): readonly ControlPluginUiModule[] {
    if (this.#closed) fail("plugin_ui_session_changed");
    this.#assertCurrent();
    const catalog = this.#catalog();
    if (!catalog) fail("plugin_ui_catalog_unavailable");
    return catalog.modules;
  }
  #leasedModules(lease: PluginUiLease): readonly ControlPluginUiModule[] {
    const modules = this.#modules().filter(
      (module) =>
        module.plugin.descriptor.pluginId === lease.descriptor.pluginId &&
        module.plugin.descriptor.publisherId === lease.descriptor.publisherId &&
        module.plugin.packageDigest === lease.packageDigest &&
        module.plugin.selectionRevision === lease.selectionRevision,
    );
    if (
      !modules.some((module) => module.contributionId === lease.contributionId)
    )
      fail("plugin_ui_page_source_changed");
    return modules;
  }
  #capacity(
    source: string,
    additional: number,
    pages = this.#snapshot.pages,
  ): void {
    if (
      pages.length + additional > 32 ||
      pages.filter((page) => page.sourceKey === source).length + additional > 8
    )
      fail("plugin_ui_page_capacity_exceeded");
  }
  #page(
    module: ControlPluginUiModule,
    input: Readonly<{
      key: string;
      title: string;
      context: PluginUiJsonValue;
      home: boolean;
    }>,
    pages: readonly PluginUiPage[] = this.#snapshot.pages,
  ): PluginUiPage {
    const pageId = this.#nextId();
    if (pages.some((page) => page.pageId === pageId))
      fail("plugin_ui_page_identity_duplicate");
    return Object.freeze({
      pageId,
      routeId: input.home ? module.key : JSON.stringify([module.key, pageId]),
      sourceKey: pluginUiPageSourceKey(module),
      moduleKey: module.key,
      key: input.key,
      title: input.title,
      context: input.context,
      home: input.home,
    });
  }
  #request(id: string, panelOpen: boolean): PluginUiPageRequest {
    return Object.freeze({
      id,
      requestKey: `plugin-page-${this.#namespace}-${++this.#sequence}`,
      panelOpen,
    });
  }
  #publish(
    pages: readonly PluginUiPage[],
    request: PluginUiPageRequest | null,
  ): void {
    this.#snapshot = Object.freeze({
      pages: Object.freeze([...pages]),
      request: request === null ? null : Object.freeze(request),
    });
    for (const listener of this.#listeners) listener();
  }
}
function fail(code: string): never {
  throw new PluginUiLoaderError(code);
}
