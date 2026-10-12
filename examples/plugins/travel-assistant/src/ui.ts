import { defineUiPlugin, createPluginUiNavigationClient, type PluginUiProps } from "@crewon/plugin-sdk/ui";
import {
  initialState,
  reduce,
  hasUnconfirmedEdits,
  type Action,
  type Request,
  type Tab,
} from "./demo.js";
import {
  plan,
  watch,
  orderView,
  connections,
  resetPanel,
  escape,
  icon,
  button,
} from "./views.js";
import { styles, hostSurfaceStyles } from "./styles.js";
export default defineUiPlugin({
  apiVersion: "crewon.plugin-ui.v1",
  pluginId: "crewon.travel-demo",
  mount(root, props, services) {
    const navigation = createPluginUiNavigationClient(services);
    let surface = "workbench";
    let managedTrip = false;
    const tabs: [Tab, string][] = [["assistant", "我的行程"], ["plan", "需求与方案"], ["watch", "价格监测"], ["orders", "订单与行程"], ["connections", "服务连接"]];
    const doc = root.ownerDocument,
      owner = doc.createElement("section"),
      sheet = doc.createElement("style"),
      content = doc.createElement("div"),
      live = doc.createElement("p");
    owner.className = "travel-demo";
    owner.setAttribute("aria-label", "出行助手演示插件");
    sheet.textContent = styles + hostSurfaceStyles;
    content.className = "wrap";
    live.className = "sr-only";
    live.setAttribute("aria-live", "polite");
    owner.append(sheet, content, live);
    root.append(owner);
    let state = initialState(),
      disposed = false,
      tokens: string[] = [],
      chatDraft = "",
      origin = "";
    function update(next: PluginUiProps) {
      if (disposed) return;
      tokens.forEach((name) => owner.style.removeProperty(name));
      tokens = [];
      for (const [name, value] of Object.entries(next.theme.tokens))
        if (/^--[a-z][a-z0-9-]*$/.test(name)) {
          owner.style.setProperty(name, value);
          tokens.push(name);
        }
      owner.dataset.theme = next.theme.mode;
      owner.style.colorScheme = next.theme.mode;
      const data = next.data as {hostPresentation?: {surface?: string; context?: {view?: string;tripKey?:string}}} | null;
      surface = data?.hostPresentation?.surface === "sidebar" ? "sidebar" : "workbench";
      owner.dataset.surface = surface;
      managedTrip = data?.hostPresentation?.context?.tripKey === "example";
      const view = data?.hostPresentation?.context?.view;
      if (tabs.some(([tab]) => tab === view)) state = {...state, tab: view as Tab};
      render();
    }
    function render(focus?: string) {
      if (disposed) return;
      if (surface === "sidebar") {
        content.innerHTML = `<div class="plugin-sidebar"><p class="eyebrow">出行助手</p><h2>我的行程</h2><p class="tiny muted">在中间与 Agent 讨论，右侧查看和调整方案。</p><nav aria-label="出行项目导航">${tabs.map(([tab, label]) => `<button type="button" data-action="tab-${tab}" class="sidebar-item">${icon(tab === "watch" ? "bell" : tab === "orders" ? "train" : "arrow")}${label}</button>`).join("")}</nav><div class="sidebar-project"><span class="tiny muted">示例行程</span><strong>上海 → 北京</strong><span class="tiny muted">车次、票价和订单为示例</span></div></div>`;
        return;
      }
      const overview = `<section class="empty travel-overview"><span class="empty-icon">${icon("train")}</span><p class="eyebrow">出行工作台</p><h2>把下一程安排好</h2><p>直接在中间告诉 Agent 目的地、时间和预算。<br>也可以手动填写需求，比较出行方案。</p>${button("tab-plan", "填写需求，查看方案", {primary:true, icon:"arrow"})}</section><section class="panel soft"><h3>上海 → 北京</h3><p class="tiny muted">先体验需求、方案、价格提醒和订单的完整流程。当前使用固定示例数据。</p></section>`;
      content.innerHTML = `<header class="compact-bar"><strong>${tabs.find(([tab]) => tab === state.tab)?.[1] ?? "我的行程"}</strong><div class="actions"><span class="tiny muted">示例数据</span>${button("reset-request", "重新开始")}</div></header>${resetPanel(state)}${state.notice ? `<div class="message">${escape(state.notice)}</div>` : ""}<main class="travel-page">${state.tab === "assistant" ? overview : state.tab === "plan" ? plan(state) : state.tab === "watch" ? watch(state) : state.tab === "orders" ? orderView(state) : connections(state)}</main>`;
      const prompt =
        content.querySelector<HTMLTextAreaElement>('[name="prompt"]');
      if (prompt) prompt.value = chatDraft;
      live.textContent = state.notice;
      if (focus) content.querySelector<HTMLElement>(focus)?.focus();
    }
    function dispatch(action: Action, focus?: string) {
      state = reduce(state, action);
      render(focus);
    }
    function readDraft(): Request {
      const form = content.querySelector<HTMLFormElement>(
        '[data-role="request"]',
      );
      if (!form) return state.draft;
      const field = (name: string) =>
        form.elements.namedItem(name) as HTMLInputElement;
      return {
        date: field("date").value,
        budget: Number(field("budget").value),
        passengers: Number(field("passengers").value),
        latestArrival: field("latestArrival").value,
        preferTrain: field("preferTrain").checked,
        allowAir: field("allowAir").checked,
      };
    }
    function send(text: string) {
      if (!text.trim()) return;
      chatDraft = "";
      dispatch({ type: "chat", text }, '[name="prompt"]');
    }
    function onSubmit(event: Event) {
      event.preventDefault();
      const form = event.target as HTMLFormElement;
      if (form.dataset.role === "chat") {
        send((form.elements.namedItem("prompt") as HTMLTextAreaElement).value);
        return;
      }
      state = reduce(state, { type: "confirm", request: readDraft() });
      render(state.editing ? '[name="budget"]' : '[data-action="edit"]');
    }
    function onInput(event: Event) {
      const target = event.target as HTMLInputElement;
      if (target.name === "prompt") {
        chatDraft = target.value;
        return;
      }
      if (target.name === "loseResponse") {
        state = { ...state, loseResponse: target.checked };
        return;
      }
      if (target.closest('[data-role="request"]')) {
        state = { ...state, draft: readDraft() };
        const dirty = hasUnconfirmedEdits(state);
        const hint = content.querySelector('[data-role="draft-status"]');
        if (hint)
          hint.textContent = dirty
            ? "输入已修改，请重新确认；原方案暂不可购买。"
            : "到达指车站 / 机场；接驳时间及费用另计。";
        if (dirty)
          content
            .querySelectorAll<HTMLButtonElement>(
              '[data-action="select"],[data-action="start-watch"],[data-action="submit-order"]',
            )
            .forEach((b) => (b.disabled = true));
      }
    }
    function onChange(event: Event) {
      const target = event.target as HTMLSelectElement;
      if (target.name === "sort")
        dispatch(
          { type: "sort", value: target.value as "recommended" | "price" },
          '[name="sort"]',
        );
    }
    function onClick(event: MouseEvent) {
      const el = (event.target as HTMLElement).closest<HTMLButtonElement>(
        "button[data-action]",
      );
      if (!el || el.disabled || !owner.contains(el)) return;
      const a = el.dataset.action!;
      if (a.startsWith("tab-")) {
        const tab = a.slice(4) as Tab;
        if (!tabs.some(([value]) => value === tab)) return;
        if (surface === "sidebar" || managedTrip) {
          void navigation.openPage({contributionId:"travel", key:"trip:example", title:tabs.find(([value]) => value === tab)![1], mode:"reuse", context:{view:tab,tripKey:"example"}}).catch(() => {live.textContent = "页面暂时无法打开，请重新进入插件。";});
          return;
        }
        return dispatch({ type:"tab", tab });
      }
      if (a.startsWith("filter-"))
        return dispatch(
          { type: "filter", value: a.slice(7) as "all" | "train" | "air" },
          `[data-action="${a}"]`,
        );
      if (a.startsWith("preset-"))
        return dispatch({
          type: "preset",
          value: a.slice(7) as "arrival" | "price" | "pair",
        });
      if (a.startsWith("chat-example-"))
        return send(
          (
            {
              arrival:
                "周五上海到北京，预算800元，1人，21点前到，高铁优先，接受机票备选",
              price:
                "10月9日上海到北京，预算500元，1人，21点前到，便宜的机票也行",
              pair: "10月9日上海到北京，两人同行，预算1600元，21点前到，高铁优先",
            } as Record<string, string>
          )[a.slice(13)]!,
        );
      if (a === "confirm-chat")
        return dispatch(
          { type: "confirm", request: state.draft },
          '[name="prompt"]',
        );
      if (a === "edit-from-chat") {
        state = reduce(state, { type: "tab", tab: "plan" });
        return dispatch({ type: "edit" }, '[name="budget"]');
      }
      if (a === "select") {
        origin = el.dataset.id!;
        return dispatch(
          { type: "select", id: origin },
          '[data-action="submit-order"]',
        );
      }
      const mapping: Record<string, Action> = {
        "edit": { type: "edit" },
        "cancel-edit": { type: "cancelEdit" },
        "start-watch": { type: "watch", command: "start" },
        "watch-from-chat": { type: "watch", command: "start" },
        "pause-watch": { type: "watch", command: "pause" },
        "resume-watch": { type: "watch", command: "resume" },
        "stop-watch": { type: "watch", command: "stop" },
        "drop": { type: "drop" },
        "dismiss": { type: "dismiss" },
        "submit-order": { type: "submit" },
        "reconcile": { type: "reconcile" },
        "pay": { type: "pay" },
        "issue": { type: "issue" },
        "reset-request": { type: "resetRequest" },
        "reset-cancel": { type: "resetCancel" },
        "reset": { type: "reset" },
      };
      if (mapping[a]) {
        state = reduce(state, mapping[a]);
        if (a === "start-watch") {
          state = { ...state, tab: "watch" };
          if(managedTrip)void navigation.openPage({contributionId:"travel",key:"trip:example",title:"价格监测",mode:"reuse",context:{view:"watch",tripKey:"example"}}).catch(()=>{live.textContent="页面暂时无法切换。";});
        }
        if (a === "reset") chatDraft = "";
        render(
          a === "dismiss"
            ? `[data-action="select"][data-id="${origin}"]`
            : a === "edit"
              ? '[name="budget"]'
              : a === "reconcile"
                ? '[data-action="pay"]'
                : a === "pay"
                  ? '[data-action="issue"]'
                  : a === "reset-request"
                    ? '[data-action="reset-cancel"]'
                    : a === "reset"
                      ? '[name="prompt"]'
                      : undefined,
        );
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.isComposing &&
        target.getAttribute("name") === "prompt"
      ) {
        event.preventDefault();
        send((target as HTMLTextAreaElement).value);
      }
      if (event.key === "Escape" && (state.selected || state.resetRequested)) {
        event.preventDefault();
        dispatch(
          state.selected ? { type: "dismiss" } : { type: "resetCancel" },
          state.selected
            ? `[data-action="select"][data-id="${origin}"]`
            : '[data-action="reset-request"]',
        );
      }
    }
    owner.addEventListener("click", onClick);
    owner.addEventListener("input", onInput);
    owner.addEventListener("change", onChange);
    owner.addEventListener("submit", onSubmit);
    owner.addEventListener("keydown", onKeyDown);
    update(props);
    render();
    return {
      update,
      dispose() {
        disposed = true;
        owner.remove();
      },
    };
  },
});
