// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InstalledPluginConfigurationPanel } from "./InstalledPluginConfigurationPanel";
import { ConfigurationPanelFetchFixture } from "./InstalledPluginConfigurationPanel.test-support";
import {
  settleSettings,
  settingsDeferred,
  settingsHttpError,
  settingsPackage,
  settingsSelection,
} from "./InstalledPluginSettings.test-support";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let globalStyle: string | null;
let globalClass: string;
beforeEach(() => {
  globalStyle = document.documentElement.getAttribute("style");
  globalClass = document.documentElement.className;
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
  expect(document.documentElement.getAttribute("style")).toBe(globalStyle);
  expect(document.documentElement.className).toBe(globalClass);
});
async function mount(
  fixture: ConfigurationPanelFetchFixture,
  disabled = false,
  locale: "zh" | "en" = "zh",
) {
  await act(async () => {
    root.render(
      <InstalledPluginConfigurationPanel
        client={fixture.client}
        selection={fixture.selection}
        locale={locale}
        disabled={disabled}
      />,
    );
    await settleSettings();
  });
}
function button(text: string) {
  const result = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === text,
  );
  expect(result, text).toBeDefined();
  return result!;
}
async function click(text: string) {
  await act(async () => {
    button(text).click();
    await settleSettings();
  });
}
async function text(value: string) {
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="organization"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settleSettings();
  });
}
function snapshot() {
  return container.innerHTML.replace(/_r_\w+_/gu, "_field_");
}

describe("installed plugin configuration panel", () => {
  it("repairs a saved Short Drama origin missing its trailing slash through one normal configuration save", async () => {
    const f = new ConfigurationPanelFetchFixture();
    f.selection = { ...f.selection, pluginId: "crewon.short-drama" };
    f.package = { ...f.package, pluginId: "crewon.short-drama" };
    f.schema = {
      type: "object",
      additionalProperties: false,
      required: ["baseUrl", "preset"],
      properties: {
        baseUrl: { type: "string", maxLength: 2048, enum: null },
        preset: { type: "string", maxLength: 64, enum: ["krea2-portrait"] },
      },
    };
    f.configuration = f.saved(
      { baseUrl: "https://named-comfy.example:8443", preset: "krea2-portrait" },
      18,
    );
    await mount(f);
    expect(f.mutations).toHaveLength(0);
    expect(button("保存参数").disabled).toBe(false);
    await click("保存参数");
    expect(f.mutations).toHaveLength(1);
    expect(f.mutations[0]!.body).toMatchObject({
      expectedRevision: 18,
      parameters: {
        baseUrl: "https://named-comfy.example:8443/",
        preset: "krea2-portrait",
      },
    });
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="baseUrl"]')!
        .value,
    ).toBe("https://named-comfy.example:8443/");
    expect(button("保存参数").disabled).toBe(true);
    expect(container.textContent).toContain("已保存版本 19");
  });

  it.each([
    "http://named-comfy.example/",
    "https://user:secret@named-comfy.example/",
    "https://named-comfy.example/path",
    "https://named-comfy.example/?key=x",
    "https://named-comfy.example/#x",
    " https://named-comfy.example/",
    "https://NAMED-comfy.example/",
    "https://named-comfy.example:443/",
  ])(
    "rejects an unusable Short Drama origin before saving: %s",
    async (baseUrl) => {
      const f = new ConfigurationPanelFetchFixture();
      f.selection = { ...f.selection, pluginId: "crewon.short-drama" };
      f.package = { ...f.package, pluginId: "crewon.short-drama" };
      f.schema = {
        type: "object",
        additionalProperties: false,
        required: ["baseUrl"],
        properties: {
          baseUrl: { type: "string", maxLength: 2048, enum: null },
        },
      };
      f.configuration = f.saved({ baseUrl }, 18);
      await mount(f);
      expect(
        container
          .querySelector('input[aria-label="baseUrl"]')!
          .getAttribute("aria-invalid"),
      ).toBe("true");
      expect(button("保存参数").disabled).toBe(true);
      await click("保存参数");
      expect(f.mutations).toHaveLength(0);
    },
  );
  it("reads the selected package and saves through the actual typed configuration client", async () => {
    const fixture = new ConfigurationPanelFetchFixture();
    await mount(fixture);
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("");
    await text("样例企业");
    expect(button("保存参数").disabled).toBe(false);
    expect(snapshot()).toMatchSnapshot();
    await click("保存参数");
    expect(fixture.mutations).toHaveLength(1);
    const mutation = fixture.mutations[0]!;
    expect(mutation.path).toBe(
      `/api/v1/extensions/${fixture.selection.pluginId}/configuration`,
    );
    expect(mutation.headers.get("authorization")).toBe(
      "Bearer named-current-actor-token",
    );
    expect(mutation.headers.get("x-csrf-token")).toBe(
      "named-current-csrf-token",
    );
    expect(mutation.headers.get("idempotency-key")).toBeTruthy();
    expect(mutation.body).toEqual({
      pluginVersion: "1.0.0",
      expectedRevision: 0,
      parameters: { organization: "样例企业" },
      credentialBindings: [],
    });
    expect(container.textContent).toContain("已保存版本 1");
    expect(button("保存参数").disabled).toBe(true);
    expect(
      fixture.requests.some((request) =>
        /activation|tasks|runs|quote/u.test(request.path),
      ),
    ).toBe(false);
  });

  it("locks an unknown save outcome and retries the exact PUT without another metadata read", async () => {
    const fixture = new ConfigurationPanelFetchFixture();
    await mount(fixture);
    await text("可重试参数");
    fixture.onMutation = (request) => {
      if (fixture.mutations.length === 1)
        throw new TypeError("named_network_disconnect_after_commit");
      const parameters = { organization: "可重试参数" };
      fixture.configuration = fixture.saved(parameters);
      return Response.json({
        disposition: "replayed",
        configuration: fixture.configuration,
      });
    };
    await click("保存参数");
    expect(button("重试保存").disabled).toBe(false);
    expect(container.querySelector<HTMLInputElement>("input")!.disabled).toBe(
      true,
    );
    const metadataCount = fixture.requests.filter(
      (request) => request.path === "/api/v1/extensions",
    ).length;
    const original = fixture.mutations[0]!;
    await click("重试保存");
    expect(fixture.mutations).toHaveLength(2);
    expect(fixture.mutations[1]!.body).toEqual(original.body);
    expect(fixture.mutations[1]!.headers.get("idempotency-key")).toBe(
      original.headers.get("idempotency-key"),
    );
    expect(
      fixture.requests.filter(
        (request) => request.path === "/api/v1/extensions",
      ),
    ).toHaveLength(metadataCount);
    expect(container.textContent).toContain("已保存版本 1");
  });

  it("shows unavailable metadata and a reachable reload action", async () => {
    const fixture = new ConfigurationPanelFetchFixture();
    fixture.catalogAvailable = false;
    await mount(fixture);
    expect(container.textContent).toContain("此插件的参数配置暂不可用");
    expect(container.querySelector("input")).toBeNull();
    fixture.catalogAvailable = true;
    await click("重新读取");
    expect(container.querySelector("input")).not.toBeNull();
  });

  it("labels the old saved version without using its parameters as defaults for the newly selected package", async () => {
    const fixture = new ConfigurationPanelFetchFixture();
    fixture.configuration = fixture.saved(
      { organization: "版本 A 的旧参数" },
      7,
    );
    fixture.selection = settingsSelection(2, "disabled", 2);
    fixture.package = settingsPackage(2);
    await mount(fixture);
    expect(container.textContent).toContain("已保存版本 7");
    expect(container.textContent).toContain("当前保存的配置来自版本 1.0.0");
    expect(container.textContent).toContain(
      "请核对当前选中版本 2.0.0 的参数并保存",
    );
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("");
    expect(fixture.mutations).toHaveLength(0);
    await text("版本 B 的新参数");
    await click("保存参数");
    expect(fixture.mutations[0]!.body).toEqual({
      pluginVersion: "2.0.0",
      expectedRevision: 7,
      parameters: { organization: "版本 B 的新参数" },
      credentialBindings: [],
    });
    expect(container.textContent).toContain("已保存版本 8");
    expect(container.textContent).not.toContain("当前保存的配置来自版本");
  });

  it("edits a legal saved array with many absent optional fields without rejecting its sparse parameters", async () => {
    const fixture = new ConfigurationPanelFetchFixture();
    fixture.schema = {
      type: "object",
      additionalProperties: false,
      required: ["rows"],
      properties: {
        rows: {
          type: "array",
          maxItems: 64,
          items: {
            type: "object",
            additionalProperties: false,
            required: [],
            properties: Object.fromEntries(
              Array.from({ length: 64 }, (_, index) => [
                `flag${index}`,
                { type: "boolean" as const },
              ]),
            ),
          },
        },
      },
    };
    const rows = Array.from({ length: 64 }, () => ({}));
    fixture.configuration = fixture.saved({ rows });
    await mount(fixture);
    expect(container.textContent).toContain("已保存版本 1");
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(0);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="移除 rows 1"]')!
        .click();
      await settleSettings();
      container
        .querySelector<HTMLButtonElement>('button[aria-label="添加项目 rows"]')!
        .click();
      await settleSettings();
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button("保存参数").disabled).toBe(false);
    await click("保存参数");
    expect(fixture.mutations[0]!.body).toEqual({
      pluginVersion: "1.0.0",
      expectedRevision: 1,
      parameters: { rows },
      credentialBindings: [],
    });
    expect(container.textContent).toContain("已保存版本 2");
  });

  it("preserves existing credential references without rendering a secret input or allowing a save", async () => {
    const fixture = new ConfigurationPanelFetchFixture();
    const binding = {
      slotId: "key",
      credentialBindingId: "fixture-existing-credential",
    };
    fixture.configuration = fixture.saved({ organization: "原配置" }, 4, [
      binding,
    ]);
    await mount(fixture);
    expect(container.textContent).toContain("不会移除已有引用");
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe(
      "原配置",
    );
    expect(button("保存参数").disabled).toBe(true);
    expect(fixture.mutations).toHaveLength(0);
    expect(fixture.configuration.credentialBindings).toEqual([binding]);
  });

  it("keeps controls disabled while a save is physically pending", async () => {
    const fixture = new ConfigurationPanelFetchFixture();
    await mount(fixture);
    await text("待保存");
    const pending = settingsDeferred<Response>();
    fixture.onMutation = () => pending.promise;
    await click("保存参数");
    expect(button("正在保存…").disabled).toBe(true);
    expect(button("重新读取").disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>("input")!.disabled).toBe(
      true,
    );
    fixture.configuration = fixture.saved({ organization: "待保存" });
    await act(async () => {
      pending.resolve(
        Response.json({
          disposition: "created",
          configuration: fixture.configuration,
        }),
      );
      await settleSettings();
    });
    expect(container.textContent).toContain("已保存版本 1");
  });

  it("prevents a stale selection from sending a configuration PUT", async () => {
    const fixture = new ConfigurationPanelFetchFixture();
    await mount(fixture);
    await text("不能保存");
    fixture.selection = {
      ...fixture.selection,
      revision: 2,
      state: "uninstalled",
      selectedPackageDigest: null,
    };
    await click("保存参数");
    expect(fixture.mutations).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("honors the host disabled state and localizes the panel without altering the shell", async () => {
    const fixture = new ConfigurationPanelFetchFixture();
    fixture.configuration = fixture.saved({ organization: "Existing" });
    await mount(fixture, true, "en");
    expect(container.textContent).toContain("Saved revision 1");
    expect(button("Reload").disabled).toBe(true);
    expect(button("Save parameters").disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>("input")!.disabled).toBe(
      true,
    );
    expect(fixture.mutations).toHaveLength(0);
  });

  it("shows a failed configuration read without inventing saved values", async () => {
    const fixture = new ConfigurationPanelFetchFixture();
    fixture.onRead = (request) =>
      request.path.endsWith("/configuration")
        ? settingsHttpError(500)
        : undefined;
    await mount(fixture);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector("input")).toBeNull();
    expect(fixture.mutations).toHaveLength(0);
  });
});
