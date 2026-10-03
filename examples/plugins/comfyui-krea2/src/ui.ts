import { defineUiPlugin, type PluginUiProps } from "@crewon/plugin-sdk/ui";
import type { PluginJsonValue } from "@crewon/plugin-sdk/contracts";
import {
  jsonRecord,
  readTaskProjection,
  readTaskReceipt,
} from "./ui-task-projection.js";
import { renderResults } from "./ui-task-results.js";
declare const __PLUGIN_VERSION__: string;

type Action = "image.generate" | "image.query";
type Request = Readonly<{
  threadId: string;
  expectedThreadRevision: number;
  idempotencyKey: string;
}> &
  Readonly<Record<string, PluginJsonValue>>;
type Intent = Readonly<{ action: Action; request: Request }>;

export default defineUiPlugin({
  apiVersion: "crewon.plugin-ui.v1",
  pluginId: "crewon.comfyui-krea2",
  mount(root, props, services) {
    const doc = root.ownerDocument;
    let projection = readTaskProjection(props.data);
    let disposed = false;
    let intent: Intent | null = null;
    let physical: Readonly<{
      intent: Intent;
      controller: AbortController;
      work: Promise<void>;
    }> | null = null;
    let confirmedRevision: number | null = null;
    const usedProjectedKeys = new Set<Action>();
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
    const input = jsonRecord(jsonRecord(props.data)?.input ?? null);
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
    const results = doc.createElement("section");
    results.dataset.role = "task-results";
    results.setAttribute("aria-label", "已受理任务的实际结果");
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
    root.append(
      title,
      copy,
      promptLabel,
      generate,
      query,
      source,
      output,
      results,
    );
    function renderControls() {
      const busy = physical !== null;
      const available =
        projection.thread !== null &&
        (intent !== null ||
          (projection.ready &&
            (confirmedRevision === null ||
              projection.thread.revision >= confirmedRevision)));
      prompt.disabled = busy || intent !== null;
      generate.disabled =
        busy ||
        !available ||
        (intent !== null && intent.action !== "image.generate");
      query.disabled =
        busy ||
        !available ||
        projection.source === null ||
        (intent !== null && intent.action !== "image.query");
      generate.textContent =
        intent?.action === "image.generate" && !busy
          ? "重试同一次生图任务"
          : "创建生图任务";
      query.textContent =
        intent?.action === "image.query" && !busy
          ? "重试同一次结果查询"
          : "查询原生成结果";
      source.textContent = projection.source
        ? "原任务：" +
          projection.source.sourceRunId +
          " · " +
          projection.source.operationId
        : "从原生图任务选择一条生成记录后可查询。";
    }
    function update(next: PluginUiProps) {
      if (disposed) return;
      const nextProjection = readTaskProjection(next.data);
      const threadChanged =
        projection.thread?.threadId !== nextProjection.thread?.threadId;
      const sourceChanged =
        projection.source?.sourceRunId !== nextProjection.source?.sourceRunId ||
        projection.source?.operationId !== nextProjection.source?.operationId;
      if (
        threadChanged ||
        (sourceChanged && intent?.action === "image.query")
      ) {
        intent = null;
        physical?.controller.abort();
        output.textContent = "任务上下文已切换，请确认当前任务后再提交。";
      }
      if (threadChanged) confirmedRevision = null;
      projection = nextProjection;
      root.dataset.pluginTheme = next.theme.mode;
      renderResults(results, next.data);
      renderControls();
    }
    update(props);
    function createIntent(action: Action): Intent | null {
      if (
        !projection.thread ||
        (action === "image.query" && !projection.source)
      )
        return null;
      const projectedKey =
        action === "image.generate"
          ? projection.generateKey
          : projection.queryKey;
      const idempotencyKey =
        projectedKey && !usedProjectedKeys.has(action)
          ? projectedKey
          : crypto.randomUUID();
      usedProjectedKeys.add(action);
      const common = {
        threadId: projection.thread.threadId,
        expectedThreadRevision: projection.thread.revision,
        idempotencyKey,
      };
      const request: Request = Object.freeze(
        action === "image.generate"
          ? { ...common, input: Object.freeze({ prompt: prompt.value }) }
          : { ...common, ...projection.source! },
      );
      return Object.freeze({ action, request });
    }
    function invoke(action: Action): Promise<void> {
      if (disposed || physical || (intent && intent.action !== action))
        return Promise.resolve();
      if (!intent && !projection.ready) return Promise.resolve();
      if (
        !intent &&
        confirmedRevision !== null &&
        (!projection.thread || projection.thread.revision < confirmedRevision)
      )
        return Promise.resolve();
      const selected = intent ?? createIntent(action);
      if (!selected) return Promise.resolve();
      intent = selected;
      const controller = new AbortController();
      // Register this physical attempt before invoking any host callback, including reentrant disposal.
      const work = Promise.resolve().then(async () => {
        try {
          if (disposed || intent !== selected || controller.signal.aborted)
            return;
          const result = await services.invoke(action, selected.request, {
            signal: controller.signal,
          });
          if (disposed || intent !== selected) return;
          const receipt = readTaskReceipt(result, selected.request);
          if (!receipt) throw new Error("krea_plugin_task_receipt_invalid");
          confirmedRevision = Math.max(
            confirmedRevision ?? 0,
            receipt.threadRevision,
          );
          intent = null;
          output.textContent = "任务已受理：" + JSON.stringify(receipt);
        } catch {
          if (!disposed && intent === selected)
            output.textContent = "任务未确认受理；重试将发送同一请求。";
        } finally {
          if (physical?.intent === selected) physical = null;
          if (!disposed) renderControls();
        }
      });
      physical = Object.freeze({ intent: selected, controller, work });
      renderControls();
      return work;
    }
    generate.onclick = () => invoke("image.generate");
    query.onclick = () => invoke("image.query");
    return {
      update,
      dispose() {
        disposed = true;
        intent = null;
        physical?.controller.abort();
        generate.onclick = null;
        query.onclick = null;
        root.replaceChildren();
        return physical?.work;
      },
    };
  },
});
