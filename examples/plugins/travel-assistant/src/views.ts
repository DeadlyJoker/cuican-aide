import {
  candidates,
  hasUnconfirmedEdits,
  type DemoState,
  type Offer,
} from "./demo.js";
export const escape = (value: string | number) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const paths = {
  train:
    '<rect x="5" y="3" width="14" height="15" rx="4"/><path d="M5 10h14M8 21l2-3m6 3-2-3M9 14h.01M15 14h.01"/>',
  air: '<path d="m22 2-7 20-4-9-9-4L22 2Zm-11 11L22 2"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  shield:
    '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  reset: '<path d="M3 10a9 9 0 1 1 2 9M3 3v7h7"/>',
};
export const icon = (name: keyof typeof paths) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
export function button(
  action: string,
  label: string,
  options: {
    primary?: boolean;
    disabled?: boolean;
    extra?: string;
    icon?: keyof typeof paths;
  } = {},
): string {
  return `<button type="button" class="btn ${options.primary ? "primary" : ""}" data-action="${action}" ${options.disabled ? "disabled" : ""} ${options.extra ?? ""}>${options.icon ? icon(options.icon) : ""}${label}</button>`;
}
export const statusLabels = {
  unknown: "结果待核实",
  pendingPayment: "待模拟付款",
  ticketing: "模拟出票中",
  ticketed: "演示已出票",
};
const watchLabels = {
  off: "未开启",
  active: "演示监测中",
  paused: "已暂停",
  stopped: "已停止",
};
const dateLabel = (date: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`
    : "日期待确认";
export function sidebar(state: DemoState): string {
  const request = state.confirmed;
  const best = candidates(state).find((item) => !item.reason);
  return `<aside class="aside"><section class="panel soft"><div class="side-title">${icon("shield")}<h3>你的出行边界</h3></div>${request ? `<div class="rule"><span>出行日期</span><strong>${dateLabel(request.date)}</strong></div><div class="rule"><span>最晚到达</span><strong>${escape(request.latestArrival)}</strong></div><div class="rule"><span>成人乘客</span><strong>${request.passengers}人</strong></div><div class="rule"><span>总预算</span><strong>¥${request.budget}</strong></div><div class="rule"><span>交通偏好</span><strong>${request.preferTrain ? "高铁优先" : "价格优先"}</strong></div><div class="rule"><span>机票备选</span><strong>${request.allowAir ? "接受" : "不接受"}</strong></div>${best ? `<div class="budget-meter"><div class="row"><span class="tiny muted">推荐方案占预算</span><strong class="tiny">${Math.round((best.total / request.budget) * 100)}%</strong></div><div class="meter"><span style="width:${Math.min(100, (best.total / request.budget) * 100)}%"></span></div><p class="tiny muted">推荐总价 ¥${best.total} · 余量 ¥${request.budget - best.total}</p></div>` : ""}` : `<p class="tiny muted">预算、人数和到达时间确认后，方案会按这些约束筛选。</p>`}<p class="aside-note">直达 · 有座 · 无默认附加消费<br>到达指车站 / 机场，接驳费用另计。</p></section><section class="panel"><div class="side-title">${icon("clock")}<h3>购票进度</h3></div><ol class="steps">${[Boolean(request), Boolean(state.order), Boolean(state.order && state.order.status !== "unknown"), state.order?.status === "ticketing" || state.order?.status === "ticketed", state.order?.status === "ticketed"].map((done, i) => `<li class="${done ? "done" : ""}"><span>${["确认出行需求", "比较并确认方案", "核实订单受理", "完成模拟付款", "核实模拟出票"][i]}</span></li>`).join("")}</ol><p class="aside-note">付款和出票分开确认；响应丢失时，只核查原订单。</p></section></aside>`;
}
function editor(state: DemoState): string {
  const draft = state.draft;
  if (state.confirmed && !state.editing)
    return `<section class="request-summary"><div><div class="row route-title"><h2>上海 ${icon("arrow")} 北京</h2><span class="badge">已确认</span></div><p>${dateLabel(state.confirmed.date)} · ${state.confirmed.passengers}名成人 · ${state.confirmed.latestArrival}前到达 · 总预算 ¥${state.confirmed.budget}</p></div>${button("edit", "修改需求", { extra: 'aria-expanded="false"' })}</section>`;
  return `<section class="panel request-panel"><div class="card-head"><div><p class="eyebrow">01 / 出行需求</p><h2>把这一程安排好</h2></div><span class="badge">样例路线</span></div><div class="route"><div><span class="tiny muted">出发城市</span><strong class="city">上海</strong><span class="tiny muted">虹桥站 / 虹桥机场</span></div><span class="route-arrow">${icon("arrow")}</span><div><span class="tiny muted">目的城市</span><strong class="city">北京</strong><span class="tiny muted">北京南站 / 首都机场</span></div></div><form data-role="request" novalidate><div class="fields"><label>出行日期<input name="date" type="date" value="${escape(draft.date)}" required></label><label>总预算 · 元<input name="budget" type="number" min="1" max="100000" step="1" value="${draft.budget}" required></label><label>成人乘客<input name="passengers" type="number" min="1" max="6" step="1" value="${draft.passengers}" required></label><label>最晚到达<input name="latestArrival" type="time" value="${escape(draft.latestArrival)}" required></label></div><div class="checks"><label><input name="preferTrain" type="checkbox" ${draft.preferTrain ? "checked" : ""}>高铁优先</label><label><input name="allowAir" type="checkbox" ${draft.allowAir ? "checked" : ""}>接受机票备选</label></div><div class="form-foot"><p class="tiny muted" data-role="draft-status" aria-live="polite">${hasUnconfirmedEdits(state) ? "输入已修改，请重新确认；原方案暂不可购买。" : "到达指车站 / 机场；接驳时间及费用另计。"}</p><div class="actions">${state.confirmed ? button("cancel-edit", "取消修改") : ""}<button class="btn primary" type="submit">${state.confirmed ? "重新确认需求" : "确认需求，查看方案"}${icon("arrow")}</button></div></div></form></section>`;
}
function confirmation(state: DemoState, offer: Offer, total: number): string {
  return `<section class="confirmation" role="dialog" aria-modal="false" aria-label="确认这一个演示方案"><div class="side-title">${icon("shield")}<h3>最后确认一下</h3></div><div class="confirm-grid"><div><span>出行日期</span><strong>${escape(state.confirmed!.date)}</strong></div><div><span>乘客</span><strong>${state.confirmed!.passengers}名成人</strong></div><div><span>席别 / 舱位</span><strong>${offer.seat}</strong></div><div><span>固定样例总价</span><strong>¥${total}</strong></div></div><label class="fault-option"><input type="checkbox" name="loseResponse" ${state.loseResponse ? "checked" : ""}><span>模拟提交响应丢失<small>体验核查原订单，避免重复购买</small></span></label><div class="form-foot"><p class="tiny muted">只创建本页演示记录，不会购票或扣款。</p><div class="actions">${button("dismiss", "返回比较")}${button("submit-order", "确认模拟下单", { primary: true, disabled: hasUnconfirmedEdits(state), icon: "arrow" })}</div></div></section>`;
}
function offerCard(
  state: DemoState,
  item: ReturnType<typeof candidates>[number],
  recommended: boolean,
): string {
  const { offer, total, reason } = item;
  const request = state.confirmed!;
  const selected = state.selected === offer.id;
  return `<article class="offer ${reason ? "excluded" : recommended ? "recommended" : ""} ${selected ? "selected" : ""}" data-offer="${offer.id}"><div class="card-head"><div class="offer-identity"><span class="mode-icon">${icon(offer.mode)}</span><div><h3>${offer.name}<span class="meta">${offer.code}</span></h3><p class="meta">${offer.seat} · 直达</p></div></div><span class="badge">${reason ? "不符合" : recommended ? "优先推荐" : "备选方案"}</span></div><div class="schedule"><div><div class="time">${offer.departure}</div><div class="meta">${offer.from}</div></div><div class="track">${offer.duration}<div class="line"></div>${offer.mode === "train" ? "铁路" : "航空"}</div><div><div class="time">${offer.arrival}</div><div class="meta">${offer.to}</div></div><div class="price"><span class="currency">¥</span>${total}<div class="meta">${request.passengers}人 · 含税总价</div></div></div><div class="offer-foot"><p class="explanation">${reason ? `未通过：${reason}` : offer.mode === "train" && request.preferTrain ? "符合预算与到达时间，优先选高铁直达。" : "符合预算与到达时间，保留一条出行备选。"}</p>${button("select", state.order ? "已有演示订单" : selected ? "方案已选中" : "模拟确认方案", { primary: recommended && !reason, disabled: Boolean(reason) || Boolean(state.order) || hasUnconfirmedEdits(state), extra: `data-id="${offer.id}" aria-expanded="${selected}"` })}</div><details class="fare-details"><summary>行李、退改与价格说明</summary><div class="fare-copy"><p>${offer.baggage} · ${offer.change}</p><p>¥${offer.price}/人 × ${request.passengers}人 = ¥${total}；固定含税样例价，无默认附加消费。接驳费用另计。</p></div></details>${selected ? confirmation(state, offer, total) : ""}</article>`;
}
export function plan(state: DemoState): string {
  const all = candidates(state);
  const shown = all.filter(
    (item) => state.filter === "all" || item.offer.mode === state.filter,
  );
  if (state.sort === "price")
    shown.sort(
      (a, b) =>
        Number(Boolean(a.reason)) - Number(Boolean(b.reason)) ||
        a.total - b.total,
    );
  const eligible = shown.filter((item) => !item.reason),
    excluded = shown.filter((item) => item.reason);
  const presets = `<div class="presets" aria-label="体验场景"><span class="tiny muted">试一个场景</span>${button("preset-arrival", "按时抵达", { disabled: Boolean(state.order) })}${button("preset-price", "低价优先", { disabled: Boolean(state.order) })}${button("preset-pair", "两人同行", { disabled: Boolean(state.order) })}</div>`;
  return `${presets}${editor(state)}${
    state.confirmed
      ? `<div class="section-head"><div><p class="eyebrow">02 / 方案比较</p><h2>${eligible.length ? `${eligible.length}个符合约束的方案` : "暂时没有符合约束的方案"}</h2></div><span class="tiny muted">固定样例 · 非实时库存</span></div><div class="comparison-tools"><div class="segments" aria-label="交通筛选">${[
          ["all", "全部"],
          ["train", "高铁"],
          ["air", "飞机"],
        ]
          .map(([value, label]) =>
            button(`filter-${value}`, label, {
              extra: `aria-pressed="${state.filter === value}"`,
            }),
          )
          .join(
            "",
          )}</div><label class="sort-label">排序<select name="sort" aria-label="方案排序"><option value="recommended" ${state.sort === "recommended" ? "selected" : ""}>综合推荐</option><option value="price" ${state.sort === "price" ? "selected" : ""}>总价优先</option></select></label></div>${eligible.length ? eligible.map((item, index) => offerCard(state, item, index === 0)).join("") : `<section class="empty"><span class="empty-icon">${icon("train")}</span><h3>换一个条件，再看看</h3><p>当前${state.filter === "all" ? "交通" : state.filter === "train" ? "高铁" : "飞机"}样例没有满足预算与到达时间的方案。<br>可以调整预算、人数或交通筛选，所有修改都由你确认。</p>${button("edit", "调整出行需求", { primary: true })}</section>`}${excluded.length ? `<details class="excluded-list"><summary>查看${excluded.length}个未通过筛选的方案<span>保留原因，便于比较</span></summary>${excluded.map((item) => offerCard(state, item, false)).join("")}</details>` : ""}<section class="watch-invite"><span class="mode-icon">${icon("bell")}</span><div><h3>${state.order ? "已有订单，避免重复购买" : state.watch === "active" ? "价格监测已开启" : "等一个更合适的价格"}</h3><p class="tiny muted">${state.order ? "查看原订单的付款与出票状态。" : "按当前总预算判断，提醒与购买分开。"}</p></div>${state.order ? button("tab-orders", "查看订单") : state.watch === "active" ? button("tab-watch", "查看监测") : button("start-watch", "开启演示监测", { disabled: hasUnconfirmedEdits(state) })}</section>`
      : `<section class="welcome-hint">${icon("shield")}<p>先确认你的预算与到达时间，我们再解释每个方案为什么适合你。</p></section>`
  }`;
}
export function watch(state: DemoState): string {
  if (state.watch === "off")
    return `<section class="empty"><span class="empty-icon">${icon("bell")}</span><h2>等到合适的价格，再做决定</h2><p>确认需求后开启演示监测。<br>价格变化由你手动触发，不会后台轮询。</p>${state.confirmed && !hasUnconfirmedEdits(state) ? button("start-watch", "开启示例监测", {primary:true}) : button("tab-plan", "去确认需求", {primary:true})}</section>`;
  const match = candidates(state).find((item) => item.offer.id === "flight");
  const hit = state.dropped && !match?.reason;
  return `<section class="panel watch-panel"><div class="card-head"><div><p class="eyebrow">PRICE WATCH / 价格监测</p><h2>上海 ${icon("arrow")} 北京</h2></div><span class="badge"><span class="dot ${state.watch === "active" ? "active-dot" : ""}"></span>${watchLabels[state.watch]}</span></div><div class="watch-stats"><div><span class="tiny muted">机票样例含税价 / 人</span><div class="stat">¥${state.dropped ? 498 : 680}</div>${state.dropped ? '<span class="price-drop">比初始样例价低 ¥182 / 人</span>' : '<span class="tiny muted">等待一次模拟价格变化</span>'}</div><div><span class="tiny muted">你的总预算</span><strong>¥${state.confirmed!.budget}</strong><p class="tiny muted">${state.confirmed!.passengers}名成人 · ${dateLabel(state.confirmed!.date)}</p></div></div><div class="chart" role="img" aria-label="固定价格样例：从680元降至498元，不是历史行情"><div class="chart-labels"><span>¥680</span><span>¥498</span></div><svg viewBox="0 0 600 120" preserveAspectRatio="none" aria-hidden="true"><path class="chart-grid" d="M0 15H600M0 100H600"/><path class="chart-line" d="${state.dropped ? "M0 15H370L440 100H590" : "M0 15H590"}"/><circle cx="590" cy="${state.dropped ? 100 : 15}" r="4"/></svg><div class="chart-dates"><span>初始样例</span><span>${state.dropped ? "模拟降价后" : "当前样例"}</span></div></div><div class="actions">${button("drop", state.dropped ? "本轮价格变化已模拟" : "模拟一次价格变化", { primary: true, disabled: state.watch !== "active" || state.dropped, icon: "arrow" })}${state.watch === "active" ? button("pause-watch", "暂停") : state.watch === "paused" ? button("resume-watch", "恢复", { disabled: Boolean(state.order) }) : ""}${button("stop-watch", "停止监测", { disabled: state.watch === "stopped" })}</div></section><section class="panel"><h3>本轮监测记录</h3><ol class="watch-events"><li><span class="event-dot"></span><div><strong>需求已确认</strong><p>总预算 ¥${state.confirmed!.budget} · ${state.confirmed!.passengers}人 · ${state.confirmed!.latestArrival}前到达</p></div></li><li><span class="event-dot"></span><div><strong>初始样例价 ¥680 / 人</strong><p>仅监测，不自动下单。</p></div></li>${state.dropped ? `<li><span class="event-dot filled"></span><div><strong>${hit ? "满足约束，已生成模拟提醒" : "已降价，但仍不符合约束"}</strong><p>${hit ? "新总价 ¥" + match!.total + "，可以查看方案后决定。" : escape(match?.reason ?? "需要重新核验")}</p></div></li>` : ""}</ol>${button("tab-plan", "查看当前方案", { icon: "arrow" })}<p class="aside-note">固定价格图只展示演示事件；暂停不取消已有订单，关闭页面后重置。</p></section>`;
}
export function orderView(state: DemoState): string {
  const order = state.order;
  if (!order)
    return `<section class="empty"><span class="empty-icon">${icon("train")}</span><h2>这一程，等你选定</h2><p>选择一个符合约束的方案，<br>体验订单、付款和出票的完整流程。</p>${button("tab-plan", "去比较方案", { primary: true })}</section>`;
  const descriptions = {
    unknown: "模拟提交回执丢失，先核查原订单，不重复下单。",
    pendingPayment: "订单已模拟受理。下一步完成模拟付款，不会扣款。",
    ticketing: "模拟付款已完成。下一步核实出票，付款不代表出票。",
    ticketed: "这一程的演示流程已完成。此记录不是真实车票或机票。",
  };
  const action =
    order.status === "unknown"
      ? button("reconcile", "模拟核查原订单", { primary: true, icon: "shield" })
      : order.status === "pendingPayment"
        ? button("pay", "模拟付款（不扣款）", { primary: true, icon: "arrow" })
        : order.status === "ticketing"
          ? button("issue", "模拟确认出票", { primary: true, icon: "check" })
          : button("reset-request", "再体验一次", { icon: "reset" });
  return `<section class="order-state ${order.status === "ticketed" ? "complete" : ""}"><span class="state-symbol">${icon(order.status === "ticketed" ? "check" : order.status === "unknown" ? "shield" : "clock")}</span><div><p class="eyebrow">${order.status === "ticketed" ? "DEMO COMPLETE / 演示完成" : "NEXT STEP / 下一步"}</p><h2>${statusLabels[order.status]}</h2><p>${descriptions[order.status]}</p></div></section><section class="panel ticket"><div class="card-head"><div class="offer-identity"><span class="mode-icon">${icon(order.offer.mode)}</span><div><h3>上海 → 北京</h3><p class="meta">${escape(order.request.date)} · ${order.offer.code} · ${order.offer.seat}</p></div></div><span class="badge">DEMO ONLY</span></div><div class="schedule"><div><div class="time">${order.offer.departure}</div><div class="meta">${order.offer.from}</div></div><div class="track">${order.offer.duration}<div class="line"></div>直达</div><div><div class="time">${order.offer.arrival}</div><div class="meta">${order.offer.to}</div></div></div><div class="ticket-divider"></div><div class="ticket-data"><div><span>演示订单号</span><strong>${order.id}</strong></div><div><span>成人乘客</span><strong>${order.request.passengers}人</strong></div><div><span>模拟提交次数</span><strong data-role="dispatch-count">${state.dispatchCount}次</strong></div><div><span>固定演示总价</span><strong>¥${order.total}</strong></div></div><div class="form-foot"><p class="tiny muted">保留原需求和金额快照，修改计划不会改写此订单。</p>${action}</div></section>`;
}
export function connections(state?: DemoState): string {
  return `${officialRailEntry(state)}<section class="panel"><p class="eyebrow">SERVICES / 服务能力</p><h2>正式接入，按能力开启</h2>${[
    ["铁路12306", "train", "起售查询、官方候补与订单合作待验证"],
    ["航旅纵横", "air", "航空数据、可售报价与交易合作待验证"],
    ["支付与通知", "bell", "当前仅本页模拟，无支付或消息发送"],
  ]
    .map(
      ([name, type, copy]) =>
        `<div class="connection"><span class="mode-icon">${icon(type as "train" | "air" | "bell")}</span><div><h3>${name}</h3><p class="tiny muted">${copy}</p></div><span class="badge">未连接</span></div>`,
    )
    .join(
      "",
    )}</section><section class="panel soft"><div class="side-title">${icon("shield")}<h3>当前演示范围</h3></div><p class="muted tiny">班次、价格、监测和订单都是固定样例。无需供应商账户，不访问官方接口、不扣票款或CrewON积分。</p><p class="aside-note">演示状态仅保留在当前页面；关闭后重置。</p></section>`;
}
export function resetPanel(state: DemoState): string {
  return state.resetRequested
    ? `<section class="reset-panel panel" role="dialog" aria-modal="false" aria-label="重新开始演示"><h3>重新开始这次演示？</h3><p class="tiny muted">清空本页草稿、监测和演示订单，回到初始场景。没有真实账户或订单会受到影响。</p><div class="actions">${button("reset-cancel", "保留当前演示")}${button("reset", "确认重新演示", { primary: true })}</div></section>`
    : "";
}
export function assistant(state: DemoState): string {
  const messages = state.messages
    .map(
      (message) =>
        `<div class="chat-message ${message.role}">${message.role === "assistant" ? `<span class="agent-avatar">${icon("shield")}</span>` : ""}<div>${message.role === "assistant" ? '<span class="agent-name">出行助理 <small>本地演示</small></span>' : ""}<p>${escape(message.text)}</p></div></div>`,
    )
    .join("");
  const canShow =
    state.confirmed && !hasUnconfirmedEdits(state) && !state.proposalReady;
  const items = canShow ? candidates(state).filter((item) => !item.reason) : [];
  const draft = state.draft;
  return `<section class="agent-stage">${state.messages.length || state.confirmed ? `<div class="chat-history">${messages}${canShow ? `<div class="chat-message assistant"><span class="agent-avatar">${icon("shield")}</span><div><span class="agent-name">出行助理 <small>本地演示</small></span><p>${items.length ? `按已确认的约束，${items.length}个样例方案符合要求。${state.confirmed!.preferTrain ? "高铁优先，机票保留作备选。" : "按价格和时间比较，再由你选择。"}` : "当前样例没有符合约束的方案。可以调整预算、人数或到达时间。"}</p></div></div></div>` : ""}</div>` : ""}${!canShow ? `<div class="agent-suggestions" aria-label="示例提问">${button("chat-example-arrival", "周五去北京，800元内，高铁优先")}${button("chat-example-price", "预算500元，便宜的机票也行")}${button("chat-example-pair", "两人同行，预算1600元")}</div>` : ""}${state.proposalReady && !canShow ? `<section class="agent-request"><div class="side-title">${icon("shield")}<h3>先核对这份出行需求</h3></div><div class="confirm-grid"><div><span>演示路线 / 日期</span><strong>上海 → 北京 · ${escape(draft.date)}</strong></div><div><span>总预算 / 人数</span><strong>¥${draft.budget} · ${draft.passengers}名成人</strong></div><div><span>最晚到达</span><strong>${escape(draft.latestArrival)}</strong></div><div><span>交通偏好</span><strong>${draft.preferTrain ? "高铁优先" : "价格优先"} · ${draft.allowAir ? "接受机票" : "只选高铁"}</strong></div></div><div class="actions">${button("edit-from-chat", "修改字段")}${button("confirm-chat", "确认需求，比较方案", { primary: true, icon: "arrow" })}</div></section>` : ""}${canShow ? `<div class="agent-results">${officialRailEntry(state)}<div class="agent-result-heading"><span>已确认 · ${dateLabel(state.confirmed!.date)} · ${state.confirmed!.passengers}人 · 总预算 ¥${state.confirmed!.budget}</span>${button("tab-plan", "完整比较")}</div>${items.map((item, index) => offerCard(state, item, index === 0)).join("")}${!items.length ? button("edit-from-chat", "调整出行需求", { primary: true }) : ""}${state.watch === "active" ? `<div class="agent-watch"><p>${icon("bell")} ${state.dropped ? "价格变化已模拟" : "演示监测已开启"}</p>${button("drop", state.dropped ? "本轮已模拟" : "模拟一次价格变化", { disabled: state.dropped })}${button("tab-watch", "查看监测")}</div>` : !state.order ? `<div class="agent-followup"><p>不急着买？我可以帮你演示价格提醒。</p>${button("watch-from-chat", "开启演示监测", { icon: "bell" })}</div>` : ""}${state.order ? `<div class="agent-followup"><p>已有演示订单 · ${statusLabels[state.order.status]}</p>${button("tab-orders", "查看下一步", { primary: true })}</div>` : ""}</div>` : ""}<form class="agent-composer" data-role="chat"><label class="sr-only" for="travel-chat-input">告诉出行助理你的需求</label><textarea id="travel-chat-input" name="prompt" rows="2" maxlength="1000" placeholder="例如：10月9日上海到北京，预算800元，1人，21点前到…" required></textarea><div class="composer-footer"><span>${icon("shield")} 模拟助理 · 示例日期为2026年10月9日</span><button class="btn primary" type="submit" aria-label="发送出行需求">发送${icon("arrow")}</button></div></form><p class="composer-hint">Enter 发送 · Shift + Enter 换行</p></section>`;
}

function officialRailEntry(state?: DemoState): string {
  const request = state?.confirmed;
  return `<section class="panel official-rail"><div class="side-title">${icon("train")}<h3>12306 官方查询</h3><span class="badge">官网入口 · 非API连接</span></div><p class="tiny muted">${request ? `请在官网填写：上海 → 北京 · ${escape(request.date)} · ${request.passengers}名成人。预算 ¥${request.budget}，${escape(request.latestArrival)}前到达，需自行核对。` : "前往铁路官方渠道查询余票、购票或申请候补。"}</p><div class="actions" style="margin-top:14px"><a class="btn primary" href="https://kyfw.12306.cn/otn/leftTicket/init" target="_blank" rel="noopener noreferrer">打开12306官方查询${icon("arrow")}</a><a class="btn" href="https://mobile.12306.cn/otsmobile/h5/otsbussiness/houbuRules/houbuRules.html" target="_blank" rel="noopener noreferrer">官方候补说明</a></div><p class="aside-note">新窗口打开官网，不传账户或乘客信息；本站不读取官网余票及订单。下面的方案和订单仍为模拟，官网操作不会自动同步。</p></section>`;
}
