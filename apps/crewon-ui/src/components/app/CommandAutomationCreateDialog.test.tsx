// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandAutomationCreateDialog } from "./CommandAutomationCreateDialog";
import { skillAutomationDraft } from "./automationCreateDraft";
import { scheduleSkillInvocation } from "./automationSkill.test-support";

vi.mock("../composer/CommandComposer", () => ({
  CommandComposerSelect: ({
    ariaLabel,
    value,
    disabled,
    options,
    onChange,
  }: {
    ariaLabel: string;
    value: string;
    disabled?: boolean;
    options: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

function mount(
  overrides: Partial<Parameters<typeof CommandAutomationCreateDialog>[0]> = {},
) {
  const props = {
    busy: false,
    connected: true,
    createDraft: skillAutomationDraft(
      { title: "每周报告", invocation: scheduleSkillInvocation() },
      1,
    ),
    error: null,
    onClose: vi.fn(),
    onSubmit: vi.fn(async () => undefined),
    runtimeAvailable: true,
    selectedThreadId: "thread-1",
    ...overrides,
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<CommandAutomationCreateDialog {...props} />));
  return props;
}

function field(label: string): HTMLInputElement | HTMLSelectElement {
  const match = Array.from(container?.querySelectorAll("label") ?? []).find(
    (entry) => entry.querySelector("span")?.textContent === label,
  );
  const input = match?.querySelector("input,select");
  if (
    !(input instanceof HTMLInputElement || input instanceof HTMLSelectElement)
  )
    throw new Error(`missing field: ${label}`);
  return input;
}

function change(label: string, value: string) {
  const input = field(label);
  act(() => {
    const prototype =
      input instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      input,
      value,
    );
    input.dispatchEvent(
      new Event(input instanceof HTMLInputElement ? "input" : "change", {
        bubbles: true,
      }),
    );
  });
}

async function submit() {
  await act(async () => {
    container
      ?.querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("Skill schedule creation behavior", () => {
  it("requires approval by default even with a fixed Skill and delivery target", async () => {
    const props = mount();
    expect(container?.textContent).toContain("每次日程任务");
    await submit();
    expect(props.onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        toolPermissionMode: "requestApproval",
        skillInvocation: scheduleSkillInvocation(),
      }),
    );
  });

  it("submits an explicitly selected whole-task approval mode outside the Skill invocation", async () => {
    const props = mount();
    const selector = container?.querySelector<HTMLSelectElement>(
      '[aria-label="日程任务工具审批"]',
    );
    expect(selector).not.toBeNull();
    act(() => {
      if (!selector) throw new Error("missing approval selector");
      selector.value = "approveForMe";
      selector.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await submit();
    expect(props.onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        toolPermissionMode: "approveForMe",
        skillInvocation: scheduleSkillInvocation(),
      }),
    );
    expect(
      vi.mocked(props.onSubmit).mock.calls[0]?.[0].skillInvocation,
    ).not.toHaveProperty("toolPermissionMode");
  });

  it("freezes the approval selector while the creation outcome is unresolved", async () => {
    let resolve!: () => void;
    mount({
      onSubmit: vi.fn(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      ),
    });
    await submit();
    expect(
      container?.querySelector<HTMLSelectElement>(
        '[aria-label="日程任务工具审批"]',
      )?.disabled,
    ).toBe(true);
    await act(async () => resolve());
    expect(
      container?.querySelector<HTMLSelectElement>(
        '[aria-label="日程任务工具审批"]',
      )?.disabled,
    ).toBe(false);
  });

  it("keeps the legacy non-Skill schedule request unchanged", async () => {
    const props = mount({ createDraft: undefined });
    expect(
      container?.querySelector('[aria-label="日程任务工具审批"]'),
    ).toBeNull();
    await submit();
    expect(props.onSubmit).toHaveBeenCalledOnce();
    expect(vi.mocked(props.onSubmit).mock.calls[0]?.[0]).not.toHaveProperty(
      "toolPermissionMode",
    );
  });

  it("preserves parameter types and fixed version when submitting the existing schedule form", async () => {
    const props = mount();
    change("count", "7");
    change("includeNotes", "false");
    change("date", "2026-09-21");
    await submit();
    expect(props.onSubmit).toHaveBeenCalledOnce();
    expect(props.onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        agentVersionId: null,
        skillInvocation: {
          ...scheduleSkillInvocation(),
          parameters: { date: "2026-09-21", count: 7, includeNotes: false },
        },
        schedule: expect.objectContaining({
          scheduleType: "daily",
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        }),
      }),
    );
  });

  it("stores a dynamic date rule separately from the Skill invocation", async () => {
    const props = mount();
    change("date · 取值方式", "previousWeekStart");
    expect(container?.textContent).toContain("date 会按日程时区自动计算");
    expect(container?.querySelectorAll('input[type="text"]')).toHaveLength(0);
    await submit();
    expect(props.onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        parameterBindings: { date: "previousWeekStart" },
        skillInvocation: scheduleSkillInvocation(),
      }),
    );
  });

  it("removes a date rule when switching back to a literal", async () => {
    const props = mount();
    change("date · 取值方式", "previousWeekEnd");
    change("date · 取值方式", "literal");
    expect(field("date").value).toBe("2026-09-14");
    await submit();
    expect(vi.mocked(props.onSubmit).mock.calls[0]?.[0]).not.toHaveProperty(
      "parameterBindings",
    );
  });

  it("blocks both the button and submit event when the delivery thread differs", async () => {
    const props = mount({ selectedThreadId: "thread-other" });
    expect(container?.textContent).toContain("交付目标与当前对话不一致");
    expect(
      container?.querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.disabled,
    ).toBe(true);
    await submit();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("keeps recoverable server errors visible inside the modal", () => {
    mount({ error: "当前账号已无权执行这个 Skill。请恢复访问权限后重试。" });
    expect(
      container?.querySelector('[role="dialog"] [role="alert"]')?.textContent,
    ).toContain("恢复访问权限");
  });

  it("cancels without issuing any creation request", () => {
    const props = mount();
    const button = Array.from(container?.querySelectorAll("button") ?? []).find(
      (entry) => entry.textContent === "取消",
    );
    act(() => button?.click());
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("does not create while disconnected", async () => {
    const props = mount({ connected: false });
    await submit();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("does not issue another creation while the first submit is unresolved", async () => {
    let resolve!: () => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    mount({ onSubmit });
    await submit();
    await submit();
    expect(onSubmit).toHaveBeenCalledOnce();
    await act(async () => resolve());
  });
});
