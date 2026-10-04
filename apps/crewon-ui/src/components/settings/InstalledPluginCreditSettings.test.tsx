// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlApiClientError } from "@crewon/control-client";
import type {
  PluginCreditAccountView,
  PluginCreditAccountsResponse,
  PluginCreditEntriesResponse,
  PluginCreditEntryView,
} from "@crewon/contracts";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../../lib/agent-platform/agentPlatformClient";
import {
  usePluginCreditAccounts,
  type PluginCreditClient,
} from "../../lib/plugins/usePluginCreditAccounts";
import { InstalledPluginCreditSettings } from "./InstalledPluginCreditSettings";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanups: (() => void | Promise<void>)[] = [];
const POOL_A = "具名夹具/短剧积分";
const POOL_B = "具名夹具/企业专业积分";
const HUGE = "999999999999999999999999999999999999999999999900";
function account(
  poolId = POOL_A,
  revision = 3,
  availableCredits = "82",
): PluginCreditAccountView {
  return {
    poolId,
    revision,
    availableCredits,
    reservedCredits: "4",
    spentCredits: "14",
    grantedCredits: (BigInt(availableCredits) + 18n).toString(),
  };
}
function accounts(
  values: readonly PluginCreditAccountView[] = [account()],
  nextPoolId: string | null = null,
): PluginCreditAccountsResponse {
  return {
    schemaVersion: "crewon.plugin-credit-accounts.v1",
    state: "ready",
    accounts: values,
    nextPoolId,
  };
}
function entries(
  current = account(),
  history: readonly PluginCreditEntryView[] = [],
  nextRevision: number | null = null,
): PluginCreditEntriesResponse {
  return {
    schemaVersion: "crewon.plugin-credit-entries.v1",
    state: "ready",
    account: current,
    entries: history,
    nextRevision,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function settle() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}
function httpError(status: number) {
  return new ControlApiClientError({
    status,
    category: status === 403 ? "authorization" : "internal",
    code: "named_credit_fixture_error",
    requestId: "renderer-credit-fixture",
  });
}

/** Named read-only protocol fixture: these values do not claim production funds or identity. */
class CreditFixture {
  readonly list = vi.fn<PluginCreditClient["listAccounts"]>(async () =>
    accounts(),
  );
  readonly read = vi.fn<PluginCreditClient["getEntries"]>(async ({ poolId }) =>
    entries(account(poolId)),
  );
  readonly mutate = vi.fn();
  readonly client: PluginCreditClient = {
    listAccounts: this.list,
    getEntries: this.read,
  };
}
function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | null = createRoot(container);
  const initialStyle = document.documentElement.getAttribute("style");
  const initialClass = document.documentElement.getAttribute("class");
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
    expect(document.documentElement.getAttribute("style")).toBe(initialStyle);
    expect(document.documentElement.getAttribute("class")).toBe(initialClass);
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
async function render(
  view: ReturnType<typeof mount>,
  fixture: CreditFixture,
  { ownerKey = "named-account:1", locale = "zh" as "zh" | "en" } = {},
) {
  await view.render(
    <InstalledPluginCreditSettings
      client={fixture.client}
      ownerKey={ownerKey}
      locale={locale}
    />,
  );
}
async function select(view: ReturnType<typeof mount>, poolId = POOL_A) {
  const trigger =
    view.container.querySelector<HTMLButtonElement>('[role="combobox"]');
  if (!trigger) throw new Error("credit_pool_selector_missing");
  await act(async () => {
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await settle();
  });
  const option = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((item) => item.textContent === poolId);
  if (!option) throw new Error(`credit_pool_option_missing:${poolId}`);
  await act(async () => {
    option.click();
    await settle();
  });
}
async function listedPools(view: ReturnType<typeof mount>) {
  const trigger =
    view.container.querySelector<HTMLButtonElement>('[role="combobox"]');
  if (!trigger) throw new Error("credit_pool_selector_missing");
  await act(async () => {
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await settle();
  });
  const values = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].map((item) => item.textContent ?? "");
  await act(async () => {
    document
      .querySelector('[role="listbox"]')
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    await settle();
  });
  return values;
}
async function click(container: HTMLElement, label: string, region?: string) {
  const within = region
    ? container.querySelector<HTMLElement>(`[aria-label="${region}"]`)
    : container;
  const button = [
    ...(within?.querySelectorAll<HTMLButtonElement>("button") ?? []),
  ].find((item) => item.textContent === label);
  if (!button) throw new Error(`credit_button_missing:${label}:${region}`);
  expect(button.disabled).toBe(false);
  await act(async () => {
    button.click();
    await settle();
  });
}
function balance(view: ReturnType<typeof mount>) {
  return view.container.querySelector<HTMLElement>(
    '[aria-label="当前独立积分余额"], [aria-label="Current independent credit balance"]',
  );
}
const text = (view: ReturnType<typeof mount>) =>
  view.container.textContent ?? "";
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("personal plugin credit Settings reads the current account without mutation", () => {
  it("lists real server accounts before explicit pool selection and never creates a default account", async () => {
    const fixture = new CreditFixture();
    const view = mount();
    await render(view, fixture);
    expect(fixture.list).toHaveBeenCalledWith(
      { afterPoolId: null, limit: 16 },
      { signal: expect.any(AbortSignal) },
    );
    expect(fixture.read).not.toHaveBeenCalled();
    expect(balance(view)).toBeNull();
    expect(text(view)).toContain("选择账户后查看余额与流水。");
    await select(view);
    expect(fixture.read).toHaveBeenCalledWith(
      { poolId: POOL_A, afterRevision: 0, limit: 50 },
      { signal: expect.any(AbortSignal) },
    );
    expect(balance(view)?.textContent).toContain("可用：82");
    expect(fixture.mutate).not.toHaveBeenCalled();
    expect(view.container.querySelectorAll("input")).toHaveLength(0);
    expect(text(view)).not.toMatch(/充值|价格|购买|提交|授权|测试余额/u);
  });

  it.each(["zh", "en"] as const)(
    "preserves exact 48-digit balances and clearly collapsed historical snapshots in %s",
    async (locale) => {
      const fixture = new CreditFixture();
      const current = account(POOL_A, 3, HUGE);
      fixture.list.mockResolvedValue(accounts([current]));
      fixture.read.mockResolvedValue(
        entries(current, [
          {
            revision: 1,
            kind: "grant",
            credits: "100",
            account: account(POOL_A, 1, "100"),
          },
        ]),
      );
      const view = mount();
      await render(view, fixture, { locale });
      await select(view);
      expect(balance(view)?.textContent).toContain(HUGE);
      expect(balance(view)?.textContent).toContain(
        (BigInt(HUGE) + 18n).toString(),
      );
      expect(balance(view)?.textContent).not.toMatch(/[0-9]e\+/u);
      const details = view.container.querySelector("details");
      expect(details?.open).toBe(false);
      expect(details?.querySelector("summary")?.textContent).toBe(
        locale === "zh"
          ? "该修订后的历史余额"
          : "Historical balance after this revision",
      );
      expect(details?.textContent).toContain("100");
      expect(
        view.container.innerHTML.replace(
          /radix-[^\s"]+/gu,
          "radix-credit-fixture",
        ),
      ).toMatchSnapshot();
    },
  );

  it("distinguishes a connected empty account list from unconfigured credits without inventing zero balances", async () => {
    const fixture = new CreditFixture();
    fixture.list.mockResolvedValueOnce(accounts([])).mockResolvedValueOnce({
      schemaVersion: "crewon.plugin-credit-accounts.v1",
      state: "unconfigured",
      accounts: [],
      nextPoolId: null,
    });
    const view = mount();
    await render(view, fixture);
    expect(text(view)).toContain("尚未建立插件积分账户。");
    expect(text(view)).not.toContain("独立积分尚未接通。");
    expect(view.container.querySelector('[role="combobox"]')).toBeNull();
    await click(view.container, "刷新积分");
    expect(text(view)).toContain("独立积分尚未接通。");
    expect(text(view)).not.toContain("尚未建立插件积分账户。");
    expect(balance(view)).toBeNull();
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it.each([
    [403, "无权读取插件积分。"],
    [404, "独立积分服务暂不可用，请稍后刷新。"],
    [503, "独立积分服务暂不可用，请稍后刷新。"],
    [500, "读取独立积分失败，请重新刷新。"],
  ] as const)(
    "shows a distinct refusal/service failure for HTTP %s",
    async (status, message) => {
      const fixture = new CreditFixture();
      fixture.list.mockRejectedValue(httpError(status));
      const view = mount();
      await render(view, fixture);
      expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
        message,
      );
      expect(balance(view)).toBeNull();
      expect(text(view)).not.toContain("尚未建立插件积分账户。");
      expect(fixture.read).not.toHaveBeenCalled();
      expect(fixture.mutate).not.toHaveBeenCalled();
    },
  );

  it("rejects late account responses after an account switch on the same client and aborts the old request", async () => {
    const fixture = new CreditFixture();
    const old = deferred<PluginCreditAccountsResponse>();
    fixture.list
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(accounts([account(POOL_B)]));
    const view = mount();
    await render(view, fixture);
    const oldSignal = fixture.list.mock.calls[0]?.[1]?.signal;
    expect(oldSignal?.aborted).toBe(false);
    await render(view, fixture, { ownerKey: "named-account:2" });
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => {
      old.resolve(accounts([account("former-account-pool")]));
      await settle();
    });
    const values = await listedPools(view);
    expect(values).toContain(POOL_B);
    expect(values).not.toContain("former-account-pool");
    expect(fixture.list).toHaveBeenCalledTimes(2);
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it("withdraws a former account's selected balance and ignores its late entries after ownerKey changes", async () => {
    const fixture = new CreditFixture();
    const old = deferred<PluginCreditEntriesResponse>();
    fixture.read.mockImplementationOnce(() => old.promise);
    const view = mount();
    await render(view, fixture);
    await select(view);
    const oldSignal = fixture.read.mock.calls[0]?.[1]?.signal;
    await render(view, fixture, { ownerKey: "named-account:2" });
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => {
      old.resolve(entries(account(POOL_A, 7, "7654321")));
      await settle();
    });
    expect(balance(view)).toBeNull();
    expect(text(view)).not.toContain("7654321");
    expect(fixture.read).toHaveBeenCalledTimes(1);
  });

  it("separates a changed client from the same account key", async () => {
    const first = new CreditFixture();
    const second = new CreditFixture();
    const old = deferred<PluginCreditAccountsResponse>();
    first.list.mockImplementationOnce(() => old.promise);
    second.list.mockResolvedValue(accounts([account(POOL_B)]));
    const view = mount();
    await render(view, first);
    await render(view, second);
    expect(first.list.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => {
      old.resolve(accounts([account("old-client-pool")]));
      await settle();
    });
    const values = await listedPools(view);
    expect(values).toContain(POOL_B);
    expect(values).not.toContain("old-client-pool");
  });

  it("clears and aborts on the actual account event and does not refresh with revoked identity", async () => {
    const fixture = new CreditFixture();
    const pending = deferred<PluginCreditEntriesResponse>();
    fixture.read.mockImplementationOnce(() => pending.promise);
    const view = mount();
    await render(view, fixture);
    await select(view);
    await act(async () => {
      window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT));
      await settle();
    });
    expect(fixture.list.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fixture.read.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(view.container.querySelector('[role="combobox"]')).toBeNull();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
      "账号已变化，请重新打开插件设置。",
    );
    await act(async () => {
      pending.resolve(entries(account(POOL_A, 7, "77777")));
      await settle();
    });
    expect(text(view)).not.toContain("77777");
    const refresh = view.container.querySelector<HTMLButtonElement>("button");
    expect(refresh?.disabled).toBe(true);
    await act(async () => {
      refresh?.click();
      await settle();
    });
    expect(fixture.list).toHaveBeenCalledTimes(1);
    expect(fixture.mutate).not.toHaveBeenCalled();
  });

  it("changes language during an in-flight read without aborting or restarting requests", async () => {
    const fixture = new CreditFixture();
    const pending = deferred<PluginCreditEntriesResponse>();
    fixture.read.mockImplementationOnce(() => pending.promise);
    const view = mount();
    await render(view, fixture);
    await select(view);
    const originalSignal = fixture.read.mock.calls[0]?.[1]?.signal;
    await render(view, fixture, { locale: "en" });
    expect(text(view)).toContain("Loading independent credits…");
    expect(originalSignal?.aborted).toBe(false);
    expect(fixture.list).toHaveBeenCalledTimes(1);
    expect(fixture.read).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve(entries());
      await settle();
    });
    expect(balance(view)?.textContent).toContain("Available: 82");
    expect(fixture.read).toHaveBeenCalledTimes(1);
  });

  it("refresh removes old pool balances before a changed server account page is available", async () => {
    const fixture = new CreditFixture();
    const refresh = deferred<PluginCreditAccountsResponse>();
    fixture.list
      .mockResolvedValueOnce(accounts())
      .mockImplementationOnce(() => refresh.promise);
    const view = mount();
    await render(view, fixture);
    await select(view);
    expect(balance(view)?.textContent).toContain("82");
    await click(view.container, "刷新积分");
    expect(balance(view)).toBeNull();
    expect(view.container.querySelector('[role="combobox"]')).toBeNull();
    await act(async () => {
      refresh.resolve(accounts([account(POOL_B)]));
      await settle();
    });
    const values = await listedPools(view);
    expect(values).toContain(POOL_B);
    expect(values).not.toContain(POOL_A);
    expect(balance(view)).toBeNull();
    expect(fixture.read).toHaveBeenCalledTimes(1);
  });

  it("replaces every 16-account page instead of accumulating accounts or previous balances", async () => {
    const fixture = new CreditFixture();
    const first = Array.from({ length: 16 }, (_, index) =>
      account(`pool-${String(index).padStart(2, "0")}`),
    );
    const second = Array.from({ length: 16 }, (_, index) =>
      account(`pool-${String(index + 16).padStart(2, "0")}`),
    );
    fixture.list
      .mockResolvedValueOnce(accounts(first, "pool-15"))
      .mockResolvedValueOnce(accounts(second, "pool-31"))
      .mockResolvedValueOnce(accounts([account("pool-32")]))
      .mockResolvedValueOnce(accounts(first, "pool-15"));
    const view = mount();
    await render(view, fixture);
    await click(view.container, "下一页", "积分账户分页");
    expect(fixture.list.mock.calls[1]?.[0]).toEqual({
      afterPoolId: "pool-15",
      limit: 16,
    });
    let values = await listedPools(view);
    expect(values).toHaveLength(16);
    expect(values).not.toContain("pool-00");
    expect(values).toContain("pool-31");
    await click(view.container, "下一页", "积分账户分页");
    expect(fixture.list.mock.calls[2]?.[0]).toEqual({
      afterPoolId: "pool-31",
      limit: 16,
    });
    values = await listedPools(view);
    expect(values).toEqual(["pool-32"]);
    await click(view.container, "首页", "积分账户分页");
    expect(fixture.list.mock.calls[3]?.[0]).toEqual({
      afterPoolId: null,
      limit: 16,
    });
    expect(text(view)).toContain("第 1 页");
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it("allows returning to the first account page when a later page became empty", async () => {
    const fixture = new CreditFixture();
    const first = Array.from({ length: 16 }, (_, index) =>
      account(`pool-${String(index).padStart(2, "0")}`),
    );
    fixture.list
      .mockResolvedValueOnce(accounts(first, "pool-15"))
      .mockResolvedValueOnce(accounts([]))
      .mockResolvedValueOnce(accounts(first, "pool-15"));
    const view = mount();
    await render(view, fixture);
    await click(view.container, "下一页", "积分账户分页");
    expect(balance(view)).toBeNull();
    expect(view.container.querySelector('[role="combobox"]')).toBeNull();
    await click(view.container, "首页", "积分账户分页");
    expect(await listedPools(view)).toHaveLength(16);
    expect(fixture.list.mock.calls[2]?.[0]).toEqual({
      afterPoolId: null,
      limit: 16,
    });
  });

  it("keeps an entry-read refusal distinct from a missing account and shows no stale balance", async () => {
    const fixture = new CreditFixture();
    fixture.read.mockRejectedValue(httpError(403));
    const view = mount();
    await render(view, fixture);
    await select(view);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
      "无权读取插件积分。",
    );
    expect(balance(view)).toBeNull();
    expect(text(view)).not.toContain("尚未建立插件积分账户。");
    expect(fixture.mutate).not.toHaveBeenCalled();
  });

  it("reads at most 50 entries per page by revision and separates historical balance from current balance", async () => {
    const fixture = new CreditFixture();
    const current = account(POOL_A, 51, "9999");
    const first: PluginCreditEntryView[] = Array.from(
      { length: 50 },
      (_, index) => ({
        revision: index + 1,
        kind: "grant",
        credits: "1",
        account: account(POOL_A, index + 1, String(index + 1)),
      }),
    );
    fixture.read
      .mockResolvedValueOnce(entries(current, first, 50))
      .mockResolvedValueOnce(
        entries(current, [
          { revision: 51, kind: "settle", credits: "14", account: current },
        ]),
      )
      .mockResolvedValueOnce(entries(current, first, 50));
    const view = mount();
    await render(view, fixture);
    await select(view);
    expect(view.container.querySelectorAll("details")).toHaveLength(50);
    expect(balance(view)?.textContent).toContain("9999");
    await click(view.container, "下一页", "积分流水分页");
    expect(fixture.read.mock.calls[1]?.[0]).toEqual({
      poolId: POOL_A,
      afterRevision: 50,
      limit: 50,
    });
    expect(view.container.querySelectorAll("details")).toHaveLength(1);
    expect(text(view)).toContain("修订 51");
    expect(text(view)).not.toContain("修订 49");
    expect(view.container.querySelectorAll("time")).toHaveLength(0);
    await click(view.container, "首页", "积分流水分页");
    expect(fixture.read.mock.calls[2]?.[0]).toEqual({
      poolId: POOL_A,
      afterRevision: 0,
      limit: 50,
    });
    expect(view.container.querySelectorAll("details")).toHaveLength(50);
    expect(fixture.mutate).not.toHaveBeenCalled();
  });

  it("aborts a former pool's entry read when selecting another server-listed pool", async () => {
    const fixture = new CreditFixture();
    fixture.list.mockResolvedValue(accounts([account(), account(POOL_B)]));
    const old = deferred<PluginCreditEntriesResponse>();
    fixture.read
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(entries(account(POOL_B, 4, "4321")));
    const view = mount();
    await render(view, fixture);
    await select(view);
    const oldSignal = fixture.read.mock.calls[0]?.[1]?.signal;
    await select(view, POOL_B);
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => {
      old.resolve(entries(account(POOL_A, 4, "1234")));
      await settle();
    });
    expect(balance(view)?.textContent).toContain("4321");
    expect(balance(view)?.textContent).not.toContain("1234");
  });

  it("does not read an arbitrary pool and rejects a response for a different selected account", async () => {
    const fixture = new CreditFixture();
    const view = mount();
    function SelectionHarness() {
      const state = usePluginCreditAccounts({
        client: fixture.client,
        ownerKey: "named-account:1",
      });
      return (
        <button onClick={() => state.selectPool("not-listed-by-server")}>
          unlisted fixture pool
        </button>
      );
    }
    await view.render(<SelectionHarness />);
    await click(view.container, "unlisted fixture pool");
    expect(fixture.read).not.toHaveBeenCalled();
    await view.unmount();
    fixture.read.mockResolvedValue(entries(account(POOL_B)));
    await render(view, fixture);
    await select(view);
    expect(balance(view)).toBeNull();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
      "读取独立积分失败，请重新刷新。",
    );
  });

  it("aborts outstanding reads and removes the account listener on unmount", async () => {
    const fixture = new CreditFixture();
    const pending = deferred<PluginCreditAccountsResponse>();
    fixture.list.mockImplementationOnce(() => pending.promise);
    const removed = vi.spyOn(window, "removeEventListener");
    cleanups.push(() => removed.mockRestore());
    const view = mount();
    await render(view, fixture);
    await view.unmount();
    expect(fixture.list.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(
      removed.mock.calls.some(
        ([name]) => name === AGENT_PLATFORM_SESSION_CHANGED_EVENT,
      ),
    ).toBe(true);
    await act(async () => {
      pending.resolve(accounts());
      await settle();
    });
    expect(view.container.childElementCount).toBe(0);
    expect(fixture.read).not.toHaveBeenCalled();
  });
});
