// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WorkflowObjectSchema } from "@crewon/domain/workflow-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPluginConfigurationDraft,
  validatePluginConfigurationDraft,
  type PluginConfigurationDraft,
} from "../../lib/plugins/pluginConfigurationSchema";
import { InstalledPluginConfigurationFields } from "./InstalledPluginConfigurationFields";
import { settleSettings } from "./InstalledPluginSettings.test-support";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const schema: WorkflowObjectSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "count", "enabled", "mode", "details", "rows"],
  properties: {
    name: { type: "string", maxLength: 3, enum: null },
    count: { type: "integer", minimum: 0, maximum: 10 },
    scale: { type: "number", minimum: 0.5, maximum: 2 },
    enabled: { type: "boolean" },
    mode: { type: "string", maxLength: 16, enum: ["simple", "advanced"] },
    details: {
      type: "object",
      additionalProperties: false,
      required: ["label"],
      properties: {
        label: { type: "string", maxLength: 32, enum: null },
        notes: {
          type: "array",
          maxItems: 2,
          items: { type: "string", maxLength: 32, enum: null },
        },
      },
    },
    rows: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["quantity"],
        properties: {
          quantity: { type: "integer", minimum: 1, maximum: 5 },
        },
      },
    },
  },
};
const saved = {
  name: "界",
  count: 0,
  enabled: true,
  mode: "advanced",
  scale: 1.25,
  details: { label: "Nested", notes: ["First"] },
  rows: [{ quantity: 2 }],
};
let container: HTMLDivElement;
let root: Root;
let current: PluginConfigurationDraft;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
    await settleSettings();
  });
  container.remove();
});
function Fields({
  initial,
  disabled = false,
}: {
  initial: PluginConfigurationDraft;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(initial);
  current = draft;
  return (
    <section className="installed-plugin-configuration">
      <InstalledPluginConfigurationFields
        schema={schema}
        draft={draft}
        onChange={setDraft}
        locale="zh"
        disabled={disabled}
        path={[]}
        idPrefix="fixture-fields"
        issues={validatePluginConfigurationDraft(schema, draft).issues}
      />
    </section>
  );
}
async function mount(value?: unknown, disabled = false) {
  await act(async () => {
    root.render(
      <Fields
        initial={createPluginConfigurationDraft(schema, value)}
        disabled={disabled}
      />,
    );
    await settleSettings();
  });
}
function control(label: string) {
  return container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
}
async function input(label: string, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(control(label), value);
    control(label).dispatchEvent(new Event("input", { bubbles: true }));
    await settleSettings();
  });
}
async function click(label: string) {
  await act(async () => {
    const button = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    )!;
    expect(button).not.toBeNull();
    button.click();
    await settleSettings();
  });
}
function parameters() {
  const validation = validatePluginConfigurationDraft(schema, current);
  expect(validation.valid).toBe(true);
  return validation.valid ? validation.parameters : null;
}

describe("installed plugin configuration fields", () => {
  it("presents each bounded schema type and nested controls in its own settings snapshot", async () => {
    await mount(saved);
    expect(container.innerHTML).toMatchSnapshot();
    expect(parameters()).toEqual(saved);
    expect(container.querySelectorAll('[data-slot="input"]')).toHaveLength(6);
    expect(
      container.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(control("mode").textContent).toContain("advanced");
  });

  it("keeps new numeric and enum values blank until they are supplied", async () => {
    await mount();
    expect(control("count").value).toBe("");
    expect(control("mode").textContent).toContain("请选择");
    expect(control("count").getAttribute("aria-invalid")).toBe("true");
    await input("count", "0");
    expect(control("count").getAttribute("aria-invalid")).toBe("false");
    await input("count", "");
    expect(current.type === "object" && current.fields.count?.value).toEqual({
      type: "integer",
      value: "",
    });
    expect(validatePluginConfigurationDraft(schema, current).valid).toBe(false);
  });

  it("changes an enumeration only after an explicit selection", async () => {
    await mount(saved);
    await act(async () => {
      control("mode").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      await settleSettings();
    });
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((item) => item.textContent === "simple");
    expect(option).toBeDefined();
    await act(async () => {
      option!.click();
      await settleSettings();
    });
    expect(parameters()?.mode).toBe("simple");
  });

  it("adds and removes optional values explicitly while retaining their draft", async () => {
    const value = {
      name: saved.name,
      count: saved.count,
      enabled: saved.enabled,
      mode: saved.mode,
      details: saved.details,
      rows: saved.rows,
    };
    await mount(value);
    expect(control("scale")).toBeNull();
    await click("添加 scale");
    expect(control("scale").value).toBe("");
    await input("scale", "1.25");
    expect(parameters()?.scale).toBe(1.25);
    await click("移除 scale");
    expect(control("scale")).toBeNull();
    expect(parameters()).toEqual(value);
    await click("添加 scale");
    expect(control("scale").value).toBe("1.25");
    expect(parameters()?.scale).toBe(1.25);
  });

  it("limits arrays and edits nested item objects without flattening them", async () => {
    await mount(saved);
    await click("添加项目 rows");
    const add = container.querySelector<HTMLButtonElement>(
      'button[aria-label="添加项目 rows"]',
    )!;
    expect(add.disabled).toBe(true);
    expect(control("rows.[2].quantity").value).toBe("");
    await input("rows.[2].quantity", "4");
    expect(parameters()?.rows).toEqual([{ quantity: 2 }, { quantity: 4 }]);
    await click("移除 rows 1");
    expect(parameters()?.rows).toEqual([{ quantity: 4 }]);
    expect(add.disabled).toBe(false);
    expect(control("rows.[1].quantity").value).toBe("4");
  });

  it("uses shared UTF-8 validation without truncating the user draft", async () => {
    await mount(saved);
    await input("name", "界界");
    expect(control("name").value).toBe("界界");
    expect(control("name").getAttribute("aria-invalid")).toBe("true");
    expect(control("name").getAttribute("aria-describedby")).toBe(
      "fixture-fields-name-error",
    );
    await input("name", "界");
    expect(parameters()?.name).toBe("界");
  });

  it("validates integer and decimal limits and switches boolean values", async () => {
    await mount(saved);
    await input("count", "1.5");
    expect(control("count").getAttribute("aria-invalid")).toBe("true");
    await input("count", "11");
    expect(control("count").getAttribute("aria-invalid")).toBe("true");
    await input("count", "1");
    await input("scale", "0.25");
    expect(control("scale").getAttribute("aria-invalid")).toBe("true");
    await input("scale", "1.5");
    await act(async () => {
      control("enabled").click();
      await settleSettings();
    });
    expect(parameters()).toMatchObject({
      count: 1,
      scale: 1.5,
      enabled: false,
    });
  });

  it("disables nested field and collection actions when the owner is busy", async () => {
    await mount(saved, true);
    for (const element of container.querySelectorAll<
      HTMLInputElement | HTMLButtonElement
    >("input,button"))
      expect(element.disabled).toBe(true);
  });
});
