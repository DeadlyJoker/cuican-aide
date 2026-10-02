import { defineUiPlugin, type PluginUiProps } from "@crewon/plugin-sdk/ui";
import type { PluginJsonValue } from "@crewon/plugin-sdk/contracts";
declare const __PLUGIN_VERSION__: string;

function record(
  value: PluginJsonValue,
): Readonly<Record<string, PluginJsonValue>> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, PluginJsonValue>>)
    : null;
}

export default defineUiPlugin({
  apiVersion: "crewon.plugin-ui.v1",
  pluginId: "crewon.comfyui-krea2",
  mount(root, props, services) {
    const doc = root.ownerDocument;
    let current = props;
    let disposed = false;
    const requests = new Map<string, PluginJsonValue>();
    const title = doc.createElement("h2");
    title.textContent = "Krea2 生图 · " + __PLUGIN_VERSION__;
    const copy = doc.createElement("p");
    copy.textContent =
      "通过已配置的 ComfyUI 服务生成一张写实图片，使用独立积分。任务受理后，可查询原生成任务的真实结果。";
    const promptLabel = doc.createElement("label");
    promptLabel.textContent = "画面描述";
    const prompt = doc.createElement("textarea");
    prompt.setAttribute("aria-label", "画面描述");
    prompt.maxLength = 2000;
    const input = record(record(props.data)?.input ?? null);
    prompt.value = typeof input?.prompt === "string" ? input.prompt : "";
    promptLabel.append(prompt);
    const generate = doc.createElement("button");
    generate.type = "button";
    generate.textContent = "创建生图任务";
    generate.dataset.action = "image.generate";
    const query = doc.createElement("button");
    query.type = "button";
    query.textContent = "查询原生成结果";
    query.dataset.action = "image.query";
    const source = doc.createElement("p");
    source.dataset.role = "query-source";
    const output = doc.createElement("output");
    output.dataset.role = "receipt";
    output.setAttribute("aria-live", "polite");
    root.dataset.independentPluginVersion = __PLUGIN_VERSION__;
    Object.assign(root.style, {
      padding: "24px",
      color: "inherit",
      font: "inherit",
    });
    Object.assign(prompt.style, {
      display: "block",
      width: "100%",
      margin: "12px 0",
      color: "inherit",
      background: "var(--surface)",
      border: "1px solid var(--border)",
      borderRadius: "6px",
      padding: "12px",
    });
    for (const button of [generate, query])
      Object.assign(button.style, {
        color: "inherit",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "6px",
        padding: "8px 12px",
        marginRight: "8px",
      });
    root.append(title, copy, promptLabel, generate, query, source, output);
    function update(next: PluginUiProps) {
      current = next;
      root.dataset.pluginTheme = next.theme.mode;
      const data = record(next.data);
      const available =
        typeof data?.sourceRunId === "string" &&
        typeof data.operationId === "string";
      query.disabled = !available || requests.has("image.query");
      source.textContent = available
        ? "原任务：" + data.sourceRunId + " · " + data.operationId
        : "从原生图任务选择一条生成记录后可查询。";
    }
    update(props);
    async function invoke(
      action: "image.generate" | "image.query",
      button: HTMLButtonElement,
    ) {
      if (disposed) return;
      try {
        let request = requests.get(action);
        if (!request) {
          const data = record(current.data);
          if (
            !data ||
            typeof data.threadId !== "string" ||
            typeof data.expectedThreadRevision !== "number"
          )
            throw new Error("krea_plugin_thread_projection_unavailable");
          const common = {
            threadId: data.threadId,
            expectedThreadRevision: data.expectedThreadRevision,
            idempotencyKey:
              typeof data[
                action === "image.generate"
                  ? "idempotencyKey"
                  : "queryIdempotencyKey"
              ] === "string"
                ? (data[
                    action === "image.generate"
                      ? "idempotencyKey"
                      : "queryIdempotencyKey"
                  ] as string)
                : crypto.randomUUID(),
          };
          if (action === "image.generate")
            request = { ...common, input: { prompt: prompt.value } };
          else {
            if (
              typeof data.sourceRunId !== "string" ||
              typeof data.operationId !== "string"
            )
              throw new Error("krea_plugin_source_projection_unavailable");
            request = {
              ...common,
              sourceRunId: data.sourceRunId,
              operationId: data.operationId,
            };
          }
          requests.set(action, request);
        }
        button.disabled = true;
        if (action === "image.generate") prompt.disabled = true;
        const receipt = await services.invoke(action, request, {});
        if (!disposed)
          output.textContent = "任务已受理：" + JSON.stringify(receipt);
      } catch {
        if (!disposed) {
          output.textContent = "任务未确认受理，可重试同一次请求。";
          button.disabled = false;
        }
      }
    }
    generate.onclick = () => void invoke("image.generate", generate);
    query.onclick = () => void invoke("image.query", query);
    return {
      update,
      dispose() {
        disposed = true;
        generate.onclick = null;
        query.onclick = null;
        root.replaceChildren();
      },
    };
  },
});
