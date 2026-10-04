// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstalledPluginSettingsLocalImport } from "../../components/settings/InstalledPluginSettingsLocalImport";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../agent-platform/agentPlatformClient";
import type {
  DesktopLocalPluginSourceConfirmation,
  DesktopLocalPluginSourceConfirmed,
  DesktopLocalPluginSourceImportAccess,
  DesktopLocalPluginSourceImportClient,
  DesktopLocalPluginSourceImportStatus,
  DesktopLocalPluginSourcePreview,
} from "../desktop/desktopLocalPluginSourceImportProtocol";
import type { SettingsSection } from "../settings/settingsCatalog";
import {
  clearLocalPluginSourceImportTicket,
  localPluginSourceImportTicket,
  registerLocalPluginSourceImportShell,
  retainLocalPluginSourceImportTicket,
  validateLocalPluginSourceImportResult,
  validateLocalPluginSourceImportStatus,
} from "./localPluginSourceImportRecovery";
import { useLocalPluginSourceImportSettingsRecovery } from "./useLocalPluginSourceImportSettingsRecovery";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const CHOOSE = "选择本机插件目录";
const CONFIRM = "确认信任并添加来源";
const NODE_TRUST =
  "我信任此包的 Node 代码。启用后，它可在宿主 Node 进程中执行。";
const READY = "来源已添加。请在可安装插件中安装，再选择是否启用。";
const RESTART = "来源已保存。请重启 CrewON 后安装，再选择是否启用。";
const PENDING = "正在处理本地插件…";
const UNCONFIRMED =
  "添加结果未确认，请刷新插件列表后检查；需要时重新选择目录。";
const FAILED = "添加来源失败，请检查插件列表后重新选择目录。";
const cleanups: (() => void | Promise<void>)[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle() {
  for (let index = 0; index < 6; index++) await Promise.resolve();
}

/** Named Renderer protocol fixture only; actual Main/filesystem authority is tested separately. */
class ReceiptFixture {
  readonly preview: DesktopLocalPluginSourcePreview = {
    previewId: "renderer-preview",
    expiresAt: Date.now() + 60_000,
    pluginId: "fixture.renderer-import",
    publisherId: "fixture.declared-publisher",
    version: "1.0.0",
    packageDigest: `sha256:${"1".repeat(64)}`,
    title: "具名 Renderer 导入夹具",
    description: "仅测试回执恢复；不代表实际本机包导入。",
    totalBytes: 512,
    fileCount: 3,
    nodeEntry: "node.mjs",
    uiEntry: null,
    publicAssetCandidates: [],
  };
  status: DesktopLocalPluginSourceImportStatus | null = null;
  readonly ownerListeners = new Set<() => void>();
  readonly statusListeners = new Set<() => void>();
  readonly onConfirm = vi.fn<
    (
      command: DesktopLocalPluginSourceConfirmation,
    ) => Promise<DesktopLocalPluginSourceConfirmed>
  >(async (command) => this.result(command));
  readonly read = vi.fn(
    async (_input: Readonly<{ previewId: string }>) => this.status,
  );
  readonly client: DesktopLocalPluginSourceImportClient = {
    version: 1,
    previewDirectory: vi.fn(async () => this.preview),
    confirmPreview: vi.fn((command) => this.onConfirm(command)),
    cancelPreview: vi.fn(async () => {}),
    subscribeOwnerChanged: (listener) => {
      this.ownerListeners.add(listener);
      return () => this.ownerListeners.delete(listener);
    },
    readStatus: this.read,
    subscribeStatusChanged: (listener) => {
      this.statusListeners.add(listener);
      return () => this.statusListeners.delete(listener);
    },
  };
  readonly binding: DesktopLocalPluginSourceImportAccess = {
    client: this.client,
    ownerKey: "account-1:document-1",
  };
  constructor() {
    cleanups.push(() => clearLocalPluginSourceImportTicket(this.binding));
  }
  command(): DesktopLocalPluginSourceConfirmation {
    return {
      previewId: this.preview.previewId,
      pluginId: this.preview.pluginId,
      publisherId: this.preview.publisherId,
      version: this.preview.version,
      packageDigest: this.preview.packageDigest,
      publicAssets: [],
      trustNodeExecution: true,
      trustUiModule: false,
    };
  }
  identity() {
    const { previewId, pluginId, publisherId, version, packageDigest } =
      this.command();
    return { previewId, pluginId, publisherId, version, packageDigest };
  }
  result(
    command = this.command(),
    runtimeStatus: DesktopLocalPluginSourceConfirmed["runtimeStatus"] = "ready",
  ): DesktopLocalPluginSourceConfirmed {
    return {
      sourceId: "native-approved:renderer-fixture",
      pluginId: command.pluginId,
      publisherId: command.publisherId,
      version: command.version,
      packageDigest: command.packageDigest,
      runtimeStatus,
      restartRequired: runtimeStatus === "restartRequired",
    };
  }
  pending(): DesktopLocalPluginSourceImportStatus {
    return { ...this.identity(), state: "pending" };
  }
  committed(
    runtimeStatus: DesktopLocalPluginSourceConfirmed["runtimeStatus"] = "ready",
  ): DesktopLocalPluginSourceImportStatus {
    return {
      ...this.identity(),
      state: "committed",
      result: this.result(undefined, runtimeStatus),
    };
  }
  failed(): DesktopLocalPluginSourceImportStatus {
    return {
      ...this.identity(),
      state: "failed",
      code: "desktop_plugin_source_import_failed",
    };
  }
  ownerChanged() {
    for (const listener of [...this.ownerListeners]) listener();
  }
  statusChanged(status: DesktopLocalPluginSourceImportStatus | null) {
    this.status = status;
    for (const listener of [...this.statusListeners]) listener();
  }
}

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | null = createRoot(container);
  const unmount = async () => {
    if (!root) return;
    const current = root;
    root = null;
    await act(async () => {
      current.unmount();
      await settle();
    });
  };
  cleanups.push(async () => {
    await unmount();
    container.remove();
  });
  return {
    container,
    unmount,
    async render(element: ReactNode) {
      if (!root) root = createRoot(container);
      await act(async () => {
        root!.render(element);
        await settle();
      });
    },
  };
}

async function renderImport(
  view: ReturnType<typeof mount>,
  fixture: ReceiptFixture,
  ownerKey = fixture.binding.ownerKey,
) {
  await view.render(
    <InstalledPluginSettingsLocalImport
      client={fixture.client}
      ownerKey={ownerKey}
      locale="zh"
    />,
  );
}
function button(container: HTMLElement, label: string) {
  const found = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (item) =>
      item.getAttribute("aria-label") === label || item.textContent === label,
  );
  if (!found) throw new Error(`missing_receipt_button:${label}`);
  return found;
}
async function click(container: HTMLElement, label: string) {
  expect(button(container, label).disabled).toBe(false);
  await act(async () => {
    button(container, label).click();
    await settle();
  });
}
async function confirm(view: ReturnType<typeof mount>) {
  await click(view.container, CHOOSE);
  const label = [...view.container.querySelectorAll("label")].find(
    (item) => item.textContent?.trim() === NODE_TRUST,
  );
  const checkbox = label?.querySelector<HTMLInputElement>("input");
  if (!checkbox) throw new Error("missing_receipt_node_trust");
  await act(async () => {
    checkbox.click();
    await settle();
  });
  await click(view.container, CONFIRM);
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("opaque Native import ticket recovery", () => {
  it("retains only exact identity, with no filesystem path, trust grant or execution capability", () => {
    const fixture = new ReceiptFixture();
    const command = fixture.command();
    const ticket = retainLocalPluginSourceImportTicket(
      fixture.binding,
      command,
    );
    expect(ticket).toEqual({ identity: fixture.identity() });
    expect(Object.isFrozen(ticket)).toBe(true);
    expect(Object.isFrozen(ticket?.identity)).toBe(true);
    (command as { pluginId: string }).pluginId = "renderer-mutated-plugin";
    expect(ticket).toEqual({ identity: fixture.identity() });
    expect(fixture.client.confirmPreview).not.toHaveBeenCalled();
    expect(fixture.client.previewDirectory).not.toHaveBeenCalled();
  });

  it.each(["readStatus", "subscribeStatusChanged"] as const)(
    "does not retain or restore with an older v1 client missing %s",
    (missing) => {
      const fixture = new ReceiptFixture();
      const client = { ...fixture.client, [missing]: undefined };
      const binding = { ...fixture.binding, client };
      expect(
        retainLocalPluginSourceImportTicket(binding, fixture.command()),
      ).toBeNull();
      expect(
        registerLocalPluginSourceImportShell(binding, Symbol("old-client")),
      ).toBe(false);
      expect(fixture.ownerListeners.size).toBe(0);
    },
  );

  it("clears an absent component's ticket on an account event and releases its owner subscription", () => {
    const fixture = new ReceiptFixture();
    retainLocalPluginSourceImportTicket(fixture.binding, fixture.command());
    expect(fixture.ownerListeners.size).toBe(1);
    window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT));
    expect(localPluginSourceImportTicket(fixture.binding)).toBeNull();
    expect(fixture.ownerListeners.size).toBe(0);
    expect(
      registerLocalPluginSourceImportShell(
        fixture.binding,
        Symbol("after-account"),
      ),
    ).toBe(false);
  });

  it("clears an absent component's ticket on external Native owner withdrawal", () => {
    const fixture = new ReceiptFixture();
    retainLocalPluginSourceImportTicket(fixture.binding, fixture.command());
    fixture.ownerChanged();
    expect(localPluginSourceImportTicket(fixture.binding)).toBeNull();
    expect(fixture.ownerListeners.size).toBe(0);
  });

  it("separates clients and rejects an old owner's ticket even when the preload client is unchanged", () => {
    const first = new ReceiptFixture();
    const second = new ReceiptFixture();
    const ticket = retainLocalPluginSourceImportTicket(
      first.binding,
      first.command(),
    );
    expect(localPluginSourceImportTicket(second.binding)).toBeNull();
    expect(localPluginSourceImportTicket(first.binding)).toBe(ticket);
    const newOwner = { ...first.binding, ownerKey: "account-2:document-1" };
    expect(localPluginSourceImportTicket(newOwner)).toBeNull();
    expect(localPluginSourceImportTicket(first.binding)).toBeNull();
    expect(first.ownerListeners.size).toBe(0);
  });

  it("a stale ticket's cleanup cannot erase a subsequent explicitly submitted ticket", () => {
    const fixture = new ReceiptFixture();
    const old = retainLocalPluginSourceImportTicket(
      fixture.binding,
      fixture.command(),
    );
    const newer = retainLocalPluginSourceImportTicket(fixture.binding, {
      ...fixture.command(),
      previewId: "subsequent-preview",
    });
    if (!old) throw new Error("missing_initial_ticket");
    clearLocalPluginSourceImportTicket(fixture.binding, old);
    expect(localPluginSourceImportTicket(fixture.binding)).toBe(newer);
    expect(fixture.ownerListeners.size).toBe(1);
    clearLocalPluginSourceImportTicket(fixture.binding);
    expect(fixture.ownerListeners.size).toBe(0);
  });

  it.each([
    "previewId",
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
  ] as const)("rejects a pending status for a different %s", (field) => {
    const fixture = new ReceiptFixture();
    const ticket = retainLocalPluginSourceImportTicket(
      fixture.binding,
      fixture.command(),
    );
    if (!ticket) throw new Error("missing_identity_ticket");
    const status = { ...fixture.pending(), [field]: "different-identity" };
    expect(() => validateLocalPluginSourceImportStatus(status, ticket)).toThrow(
      "invalid_import_status",
    );
  });

  it.each(["pluginId", "publisherId", "version", "packageDigest"] as const)(
    "rejects a committed result for a different %s even when the status identity matches",
    (field) => {
      const fixture = new ReceiptFixture();
      const ticket = retainLocalPluginSourceImportTicket(
        fixture.binding,
        fixture.command(),
      );
      if (!ticket) throw new Error("missing_result_ticket");
      expect(() =>
        validateLocalPluginSourceImportStatus(
          {
            ...fixture.identity(),
            state: "committed",
            result: { ...fixture.result(), [field]: "different-result" },
          },
          ticket,
        ),
      ).toThrow("invalid_confirmation");
    },
  );

  it("accepts only consistent terminal results and the one public failure code", () => {
    const fixture = new ReceiptFixture();
    const ticket = retainLocalPluginSourceImportTicket(
      fixture.binding,
      fixture.command(),
    );
    if (!ticket) throw new Error("missing_validation_ticket");
    expect(() =>
      validateLocalPluginSourceImportStatus(fixture.pending(), ticket),
    ).not.toThrow();
    expect(() =>
      validateLocalPluginSourceImportStatus(fixture.committed(), ticket),
    ).not.toThrow();
    expect(() =>
      validateLocalPluginSourceImportStatus(
        fixture.committed("restartRequired"),
        ticket,
      ),
    ).not.toThrow();
    expect(() =>
      validateLocalPluginSourceImportStatus(fixture.failed(), ticket),
    ).not.toThrow();
    expect(() =>
      validateLocalPluginSourceImportStatus(
        {
          ...fixture.identity(),
          state: "failed",
          code: "arbitrary_internal_error",
        } as unknown as DesktopLocalPluginSourceImportStatus,
        ticket,
      ),
    ).toThrow("invalid_import_status");
    expect(() =>
      validateLocalPluginSourceImportResult(
        {
          ...fixture.result(),
          restartRequired: true,
        },
        fixture.identity(),
      ),
    ).toThrow("invalid_confirmation");
    expect(() =>
      validateLocalPluginSourceImportResult(
        {
          ...fixture.result(),
          sourceId: "",
        },
        fixture.identity(),
      ),
    ).toThrow("invalid_confirmation");
  });
});

function Shell({
  access,
  open,
}: {
  access: DesktopLocalPluginSourceImportAccess | null;
  open: (section: SettingsSection) => void;
}) {
  useLocalPluginSourceImportSettingsRecovery(access, open);
  return <span>original app shell fixture</span>;
}

describe("Settings recovery belongs to a newly mounted App shell", () => {
  it("reopens Tools exactly once in a new shell and never reopens for ordinary callback changes", async () => {
    const fixture = new ReceiptFixture();
    const view = mount();
    const before = vi.fn<(section: SettingsSection) => void>();
    await view.render(<Shell access={fixture.binding} open={before} />);
    expect(before).not.toHaveBeenCalled();
    retainLocalPluginSourceImportTicket(fixture.binding, fixture.command());
    const ordinaryChange = vi.fn<(section: SettingsSection) => void>();
    await view.render(
      <Shell access={{ ...fixture.binding }} open={ordinaryChange} />,
    );
    expect(before).not.toHaveBeenCalled();
    expect(ordinaryChange).not.toHaveBeenCalled();
    await view.unmount();
    const restored = vi.fn<(section: SettingsSection) => void>();
    await view.render(<Shell access={fixture.binding} open={restored} />);
    expect(restored).toHaveBeenCalledExactlyOnceWith("mcp-servers");
    const after = vi.fn<(section: SettingsSection) => void>();
    await view.render(<Shell access={{ ...fixture.binding }} open={after} />);
    expect(after).not.toHaveBeenCalled();
    await view.unmount();
    await view.render(<Shell access={fixture.binding} open={after} />);
    expect(after).not.toHaveBeenCalled();
    expect(fixture.client.confirmPreview).not.toHaveBeenCalled();
  });

  it("never restores for a preview alone, no Native client or an older capability", async () => {
    const fixture = new ReceiptFixture();
    const view = mount();
    const open = vi.fn<(section: SettingsSection) => void>();
    await renderImport(view, fixture);
    await click(view.container, CHOOSE);
    expect(localPluginSourceImportTicket(fixture.binding)).toBeNull();
    await view.unmount();
    await view.render(<Shell access={fixture.binding} open={open} />);
    await view.unmount();
    await view.render(<Shell access={null} open={open} />);
    await view.unmount();
    const oldAccess = {
      ...fixture.binding,
      client: { ...fixture.client, readStatus: undefined },
    };
    expect(
      retainLocalPluginSourceImportTicket(oldAccess, fixture.command()),
    ).toBeNull();
    await view.render(<Shell access={oldAccess} open={open} />);
    expect(open).not.toHaveBeenCalled();
  });

  it("does not restore an absent shell's import after account or owner withdrawal", async () => {
    const fixture = new ReceiptFixture();
    const view = mount();
    const open = vi.fn<(section: SettingsSection) => void>();
    await view.render(<Shell access={fixture.binding} open={open} />);
    retainLocalPluginSourceImportTicket(fixture.binding, fixture.command());
    await view.unmount();
    window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT));
    await view.render(<Shell access={fixture.binding} open={open} />);
    expect(open).not.toHaveBeenCalled();
    retainLocalPluginSourceImportTicket(fixture.binding, fixture.command());
    await view.unmount();
    fixture.ownerChanged();
    await view.render(<Shell access={fixture.binding} open={open} />);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("original local-import component reads a Main receipt across its unmount", () => {
  it("remounts pending then displays committed status without replaying confirmation", async () => {
    const fixture = new ReceiptFixture();
    const pending = deferred<DesktopLocalPluginSourceConfirmed>();
    fixture.onConfirm.mockImplementation(() => pending.promise);
    const view = mount();
    await renderImport(view, fixture);
    await confirm(view);
    expect(fixture.client.confirmPreview).toHaveBeenCalledTimes(1);
    expect(fixture.client.confirmPreview).toHaveBeenCalledWith(
      fixture.command(),
    );
    await view.unmount();
    expect(fixture.statusListeners.size).toBe(0);
    expect(fixture.ownerListeners.size).toBe(1);
    fixture.status = fixture.pending();
    await renderImport(view, fixture);
    expect(fixture.read).toHaveBeenCalledWith({
      previewId: fixture.preview.previewId,
    });
    expect(view.container.textContent).toContain(PENDING);
    expect(button(view.container, CHOOSE).disabled).toBe(true);
    expect(view.container.querySelector("article")).toBeNull();
    await act(async () => {
      fixture.statusChanged(fixture.committed());
      pending.resolve(fixture.result());
      await settle();
    });
    expect(view.container.textContent).toContain(READY);
    expect(view.container.textContent).not.toContain(PENDING);
    expect(button(view.container, CHOOSE).disabled).toBe(false);
    expect(fixture.client.confirmPreview).toHaveBeenCalledTimes(1);
    expect(fixture.client.previewDirectory).toHaveBeenCalledTimes(1);
    await view.unmount();
    clearLocalPluginSourceImportTicket(fixture.binding);
    expect(fixture.ownerListeners.size).toBe(0);
    expect(fixture.statusListeners.size).toBe(0);
  });

  it.each(["ready", "restartRequired"] as const)(
    "reads a %s receipt that completed while the component was absent",
    async (runtimeStatus) => {
      const fixture = new ReceiptFixture();
      const pending = deferred<DesktopLocalPluginSourceConfirmed>();
      fixture.onConfirm.mockImplementation(() => pending.promise);
      const view = mount();
      await renderImport(view, fixture);
      await confirm(view);
      await view.unmount();
      fixture.status = fixture.committed(runtimeStatus);
      pending.resolve(fixture.result(undefined, runtimeStatus));
      await renderImport(view, fixture);
      expect(view.container.textContent).toContain(
        runtimeStatus === "ready" ? READY : RESTART,
      );
      expect(view.container.textContent).not.toContain(UNCONFIRMED);
      expect(fixture.client.confirmPreview).toHaveBeenCalledTimes(1);
      expect(fixture.read).toHaveBeenCalledTimes(1);
    },
  );

  it("reads the committed receipt after the confirmation IPC rejects and does not retry mutation", async () => {
    const fixture = new ReceiptFixture();
    fixture.onConfirm.mockImplementation(async () => {
      fixture.status = fixture.committed();
      throw new Error("named_renderer_transport_disconnected_after_commit");
    });
    const view = mount();
    await renderImport(view, fixture);
    await confirm(view);
    expect(view.container.textContent).toContain(READY);
    expect(view.container.textContent).not.toContain(UNCONFIRMED);
    expect(fixture.read).toHaveBeenCalledExactlyOnceWith({
      previewId: fixture.preview.previewId,
    });
    expect(fixture.client.confirmPreview).toHaveBeenCalledTimes(1);
  });

  it("keeps Main's pending import busy after a transport rejection until the terminal status arrives", async () => {
    const fixture = new ReceiptFixture();
    fixture.onConfirm.mockImplementation(async () => {
      fixture.status = fixture.pending();
      throw new Error(
        "named_renderer_transport_disconnected_while_main_pending",
      );
    });
    const view = mount();
    await renderImport(view, fixture);
    await confirm(view);
    expect(view.container.textContent).toContain(PENDING);
    expect(view.container.textContent).not.toContain(UNCONFIRMED);
    expect(button(view.container, CHOOSE).disabled).toBe(true);
    await act(async () => {
      fixture.statusChanged(fixture.committed());
      await settle();
    });
    expect(view.container.textContent).toContain(READY);
    expect(view.container.textContent).not.toContain(PENDING);
    expect(fixture.client.confirmPreview).toHaveBeenCalledTimes(1);
  });

  it("does not let a late pending read or subsequent empty status overwrite the committed receipt", async () => {
    const fixture = new ReceiptFixture();
    retainLocalPluginSourceImportTicket(fixture.binding, fixture.command());
    const initialRead = deferred<DesktopLocalPluginSourceImportStatus | null>();
    fixture.read.mockImplementationOnce(() => initialRead.promise);
    const view = mount();
    await renderImport(view, fixture);
    expect(view.container.textContent).toContain(PENDING);
    await act(async () => {
      fixture.statusChanged(fixture.committed());
      await settle();
    });
    expect(view.container.textContent).toContain(READY);
    await act(async () => {
      initialRead.resolve(fixture.pending());
      await settle();
      fixture.statusChanged(null);
      await settle();
    });
    expect(view.container.textContent).toContain(READY);
    expect(view.container.textContent).not.toContain(PENDING);
    expect(view.container.textContent).not.toContain(UNCONFIRMED);
    expect(fixture.client.confirmPreview).not.toHaveBeenCalled();
  });

  it("shows Main's terminal failure on remount without a second confirmation", async () => {
    const fixture = new ReceiptFixture();
    retainLocalPluginSourceImportTicket(fixture.binding, fixture.command());
    fixture.status = fixture.failed();
    const view = mount();
    await renderImport(view, fixture);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
      FAILED,
    );
    expect(button(view.container, CHOOSE).disabled).toBe(false);
    expect(fixture.client.confirmPreview).not.toHaveBeenCalled();
  });

  it("rejects a different status identity in the component rather than showing successful import", async () => {
    const fixture = new ReceiptFixture();
    retainLocalPluginSourceImportTicket(fixture.binding, fixture.command());
    fixture.status = {
      ...fixture.committed(),
      previewId: "another-document-preview",
    };
    const view = mount();
    await renderImport(view, fixture);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
      UNCONFIRMED,
    );
    expect(view.container.textContent).not.toContain(READY);
    expect(fixture.client.confirmPreview).not.toHaveBeenCalled();
  });

  it.each(["account", "owner"] as const)(
    "cannot recover an import withdrawn by %s while the component was absent",
    async (event) => {
      const fixture = new ReceiptFixture();
      const pending = deferred<DesktopLocalPluginSourceConfirmed>();
      fixture.onConfirm.mockImplementation(() => pending.promise);
      const view = mount();
      await renderImport(view, fixture);
      await confirm(view);
      await view.unmount();
      if (event === "account")
        window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT));
      else fixture.ownerChanged();
      fixture.status = fixture.committed();
      pending.resolve(fixture.result());
      await renderImport(view, fixture);
      expect(fixture.read).not.toHaveBeenCalled();
      expect(view.container.textContent).not.toContain(READY);
      expect(view.container.textContent).not.toContain(PENDING);
      expect(localPluginSourceImportTicket(fixture.binding)).toBeNull();
      expect(fixture.client.confirmPreview).toHaveBeenCalledTimes(1);
    },
  );

  it("does not display a former owner's readback after the account binding changes", async () => {
    const fixture = new ReceiptFixture();
    retainLocalPluginSourceImportTicket(fixture.binding, fixture.command());
    const oldRead = deferred<DesktopLocalPluginSourceImportStatus | null>();
    fixture.read.mockImplementationOnce(() => oldRead.promise);
    const view = mount();
    await renderImport(view, fixture);
    expect(view.container.textContent).toContain(PENDING);
    await renderImport(view, fixture, "account-2:document-1");
    await act(async () => {
      oldRead.resolve(fixture.committed());
      await settle();
    });
    expect(view.container.textContent).not.toContain(READY);
    expect(view.container.textContent).not.toContain(PENDING);
    expect(fixture.client.confirmPreview).not.toHaveBeenCalled();
  });

  it("new explicit preview clears the old recovery ticket and its surviving owner subscription", async () => {
    const fixture = new ReceiptFixture();
    retainLocalPluginSourceImportTicket(fixture.binding, fixture.command());
    fixture.status = fixture.committed();
    const view = mount();
    await renderImport(view, fixture);
    expect(fixture.ownerListeners.size).toBe(2);
    expect(fixture.statusListeners.size).toBe(1);
    await click(view.container, CHOOSE);
    expect(localPluginSourceImportTicket(fixture.binding)).toBeNull();
    expect(fixture.ownerListeners.size).toBe(1);
    expect(view.container.textContent).not.toContain(READY);
    await view.unmount();
    expect(fixture.ownerListeners.size).toBe(0);
    expect(fixture.statusListeners.size).toBe(0);
  });
});
