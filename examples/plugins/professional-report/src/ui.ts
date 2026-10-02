import { defineUiPlugin, type PluginUiProps } from "@crewon/plugin-sdk/ui";
import type { PluginJsonValue } from "@crewon/plugin-sdk/contracts";
declare const __PLUGIN_VERSION__: string;

function jsonObject(
  value: PluginJsonValue,
): Readonly<Record<string, PluginJsonValue>> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, PluginJsonValue>>)
    : null;
}

export default defineUiPlugin({
  apiVersion: "crewon.plugin-ui.v1",
  pluginId: "example.professional",
  mount(root, props, services) {
    const doc = root.ownerDocument;
    let current = props;
    let disposed = false;
    let request: {
      threadId: string;
      expectedThreadRevision: number;
      idempotencyKey: string;
      input: { subject: string };
    } | null = null;
    const title = doc.createElement("h2");
    title.textContent = "独立专业报告插件 · " + __PLUGIN_VERSION__;
    const copy = doc.createElement("p");
    copy.textContent =
      "提交到原任务系统，使用个人独立积分。报告由宿主配置的外部 API 提供。";
    const label = doc.createElement("label");
    label.textContent = "报告主题";
    const input = doc.createElement("textarea");
    input.setAttribute("aria-label", "报告主题");
    input.maxLength = 2000;
    const projectedInput = jsonObject(jsonObject(props.data)?.input ?? null);
    input.value =
      typeof projectedInput?.subject === "string"
        ? projectedInput.subject
        : "本季度项目风险与行动建议";
    label.append(input);
    const submit = doc.createElement("button");
    submit.type = "button";
    submit.textContent = "创建报告任务";
    submit.dataset.action = "report.generate";
    const output = doc.createElement("output");
    output.dataset.role = "receipt";
    output.setAttribute("aria-live", "polite");
    root.dataset.independentPluginVersion = __PLUGIN_VERSION__;
    Object.assign(root.style, {
      padding: "24px",
      color: "inherit",
      font: "inherit",
    });
    Object.assign(input.style, {
      display: "block",
      width: "100%",
      margin: "12px 0",
      color: "inherit",
      background: "var(--surface)",
      border: "1px solid var(--border)",
      borderRadius: "6px",
      padding: "12px",
    });
    Object.assign(submit.style, {
      color: "inherit",
      background: "var(--surface)",
      border: "1px solid var(--border)",
      borderRadius: "6px",
      padding: "8px 12px",
    });
    root.append(title, copy, label, submit, output);
    function update(next: PluginUiProps) {
      current = next;
      root.dataset.pluginTheme = next.theme.mode;
    }
    update(props);
    submit.onclick = async () => {
      if (disposed) return;
      try {
        if (!request) {
          const data = jsonObject(current.data);
          if (
            !data ||
            typeof data.threadId !== "string" ||
            typeof data.expectedThreadRevision !== "number"
          )
            throw new Error(
              "professional_plugin_thread_projection_unavailable",
            );
          request = {
            threadId: data.threadId,
            expectedThreadRevision: data.expectedThreadRevision,
            idempotencyKey:
              typeof data.idempotencyKey === "string"
                ? data.idempotencyKey
                : crypto.randomUUID(),
            input: { subject: input.value },
          };
        }
        submit.disabled = true;
        input.disabled = true;
        const result = await services.invoke("report.generate", request, {});
        if (!disposed)
          output.textContent = "任务已受理：" + JSON.stringify(result);
      } catch {
        if (!disposed) {
          output.textContent = "任务未确认受理，可重试同一次请求。";
          submit.disabled = false;
        }
      }
    };
    return {
      update,
      dispose() {
        disposed = true;
        submit.onclick = null;
        root.replaceChildren();
      },
    };
  },
});
