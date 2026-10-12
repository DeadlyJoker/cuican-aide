export type Tab = "assistant" | "plan" | "watch" | "orders" | "connections";
export type OrderStatus =
  | "unknown"
  | "pendingPayment"
  | "ticketing"
  | "ticketed";
export type Request = {
  date: string;
  budget: number;
  passengers: number;
  latestArrival: string;
  preferTrain: boolean;
  allowAir: boolean;
};
export type Offer = {
  id: string;
  mode: "train" | "air";
  code: string;
  name: string;
  from: string;
  to: string;
  departure: string;
  arrival: string;
  duration: string;
  price: number;
  seat: string;
  baggage: string;
  change: string;
};
export const offers: readonly Offer[] = [
  {
    id: "rail",
    mode: "train",
    code: "演示 G108",
    name: "高铁直达",
    from: "上海虹桥",
    to: "北京南",
    departure: "07:20",
    arrival: "12:58",
    duration: "5小时38分",
    price: 553,
    seat: "二等座",
    baggage: "按铁路行李规则",
    change: "退改费用按办理时间计算（演示）",
  },
  {
    id: "flight",
    mode: "air",
    code: "演示 MU5107",
    name: "午后航班",
    from: "上海虹桥机场",
    to: "北京首都机场",
    departure: "13:00",
    arrival: "15:20",
    duration: "2小时20分",
    price: 680,
    seat: "经济舱",
    baggage: "含20kg托运行李（演示）",
    change: "改签需补差价（演示）",
  },
  {
    id: "late",
    mode: "train",
    code: "演示 G156",
    name: "晚间高铁",
    from: "上海虹桥",
    to: "北京南",
    departure: "17:30",
    arrival: "23:08",
    duration: "5小时38分",
    price: 498,
    seat: "二等座",
    baggage: "按铁路行李规则",
    change: "退改费用按办理时间计算（演示）",
  },
];
export type Order = {
  id: string;
  offer: Offer;
  total: number;
  request: Request;
  status: OrderStatus;
};
export type DemoState = {
  tab: Tab;
  draft: Request;
  confirmed: Request | null;
  watch: "off" | "active" | "paused" | "stopped";
  dropped: boolean;
  notice: string;
  order: Order | null;
  selected: string | null;
  loseResponse: boolean;
  dispatchCount: number;
  editing: boolean;
  filter: "all" | "train" | "air";
  sort: "recommended" | "price";
  resetRequested: boolean;
  proposalReady: boolean;
  messages: { role: "user" | "assistant"; text: string }[];
};
export function initialState(): DemoState {
  return {
    tab: "assistant",
    draft: {
      date: "2026-10-09",
      budget: 800,
      passengers: 1,
      latestArrival: "21:00",
      preferTrain: true,
      allowAir: true,
    },
    confirmed: null,
    watch: "off",
    dropped: false,
    notice: "",
    order: null,
    selected: null,
    loseResponse: false,
    dispatchCount: 0,
    editing: true,
    filter: "all",
    sort: "recommended",
    resetRequested: false,
    messages: [],
    proposalReady: false,
  };
}
export function validate(request: Request): string | null {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(request.date) ||
    Number.isNaN(Date.parse(request.date + "T00:00:00Z")) ||
    new Date(request.date + "T00:00:00Z").toISOString().slice(0, 10) !==
      request.date
  )
    return "请填写有效出行日期。";
  if (
    !Number.isInteger(request.budget) ||
    request.budget < 1 ||
    request.budget > 100000
  )
    return "总预算需为1—100000元的整数。";
  if (
    !Number.isInteger(request.passengers) ||
    request.passengers < 1 ||
    request.passengers > 6
  )
    return "演示支持1—6名成人。";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(request.latestArrival))
    return "请填写有效的最晚到达时间。";
  return null;
}
export function hasUnconfirmedEdits(state: DemoState): boolean {
  return (
    state.confirmed !== null &&
    JSON.stringify(state.draft) !== JSON.stringify(state.confirmed)
  );
}
export function candidates(
  state: DemoState,
): { offer: Offer; total: number; reason: string | null }[] {
  const request = state.confirmed ?? state.draft;
  return offers
    .map((source) => {
      const offer = {
        ...source,
        price: source.id === "flight" && state.dropped ? 498 : source.price,
      };
      const total = offer.price * request.passengers;
      const reason =
        offer.mode === "air" && !request.allowAir
          ? "未同意飞机方案"
          : total > request.budget
            ? "超出总预算"
            : offer.arrival > request.latestArrival
              ? "超过最晚到达时间"
              : null;
      return { offer, total, reason };
    })
    .sort(
      (a, b) =>
        Number(Boolean(a.reason)) - Number(Boolean(b.reason)) ||
        (request.preferTrain
          ? Number(a.offer.mode !== "train") - Number(b.offer.mode !== "train")
          : 0) ||
        a.total - b.total,
    );
}
export type Action =
  | { type: "confirm"; request: Request }
  | { type: "tab"; tab: Tab }
  | { type: "watch"; command: "start" | "pause" | "resume" | "stop" }
  | { type: "drop" }
  | { type: "select"; id: string }
  | { type: "dismiss" }
  | { type: "submit" }
  | { type: "reconcile" }
  | { type: "pay" }
  | { type: "issue" }
  | { type: "edit" }
  | { type: "cancelEdit" }
  | { type: "filter"; value: DemoState["filter"] }
  | { type: "sort"; value: DemoState["sort"] }
  | { type: "preset"; value: "arrival" | "price" | "pair" }
  | { type: "resetRequest" }
  | { type: "resetCancel" }
  | { type: "reset" }
  | { type: "chat"; text: string };
export function reduce(state: DemoState, action: Action): DemoState {
  const next = { ...state };
  switch (action.type) {
    case "chat": {
      const text = action.text.trim().slice(0, 1000);
      if (!text) return next;
      const respond = (current: DemoState, reply: string): DemoState => ({
        ...current,
        tab: "assistant",
        proposalReady: current.proposalReady,
        messages: [
          ...state.messages,
          { role: "user" as const, text },
          { role: "assistant" as const, text: reply },
        ].slice(-12),
        notice: "",
      });
      if (state.order)
        return respond(
          { ...next, proposalReady: false },
          "这趟行程已有演示订单。先查看原订单进度，避免重复购买；需要切换场景时，可以重新开始演示。",
        );
      if (/取消|退款|退票/.test(text))
        return respond(
          { ...next, proposalReady: false },
          "演示版尚未包含取消和退款操作。暂停监测不会取消订单，真实售后需要正式渠道接入。",
        );
      if (
        /监测|盯票|降价|提醒/.test(text) &&
        state.confirmed &&
        !hasUnconfirmedEdits(state)
      ) {
        const watched = reduce(next, { type: "watch", command: "start" });
        return respond(
          watched,
          "已开启本页演示监测。我会按已确认的总预算判断是否提醒；你可以手动模拟一次价格变化。提醒不会自动下单。",
        );
      }
      if (
        /北京(?:到|去|至)上海/.test(text) ||
        (/到|去|至/.test(text) && !/北京/.test(text))
      )
        return respond(
          { ...next, proposalReady: false },
          "当前演示只提供上海到北京的样例。正式版会扩展路线；现在可以试试这个方向的预算与到达时间。",
        );
      if (
        !/上海|北京|预算|元|人|高铁|飞机|机票|周五|周六|\d{4}-\d{2}-\d{2}/.test(
          text,
        )
      )
        return respond(
          { ...next, proposalReady: false },
          "我需要明确目的地、日期、预算和人数。演示路线是上海到北京，你可以说：10月9日，1人，预算800元，21点前到，高铁优先。",
        );
      const budgetMatch =
        text.match(/(?:预算|不超过|以内|低于)\s*(\d+)/) ??
        text.match(/(\d+)\s*元/);
      const peopleMatch = text.match(/([1-6])\s*(?:名|位|个)?(?:人|成人)/);
      const timeMatch = text.match(/(\d{1,2})(?::|点)(\d{2})?\s*(?:前|之前)/);
      const isoDate = text.match(/\d{4}-\d{2}-\d{2}/)?.[0];
      const request: Request = {
        ...state.draft,
        ...(budgetMatch ? { budget: Number(budgetMatch[1]) } : {}),
        ...(peopleMatch
          ? { passengers: Number(peopleMatch[1]) }
          : /两人|两位|2人/.test(text)
            ? { passengers: 2 }
            : {}),
        ...(timeMatch
          ? {
              latestArrival: `${timeMatch[1].padStart(2, "0")}:${timeMatch[2] ?? "00"}`,
            }
          : {}),
        date:
          isoDate ??
          (/周六|10月10日/.test(text)
            ? "2026-10-10"
            : /周五|10月9日/.test(text)
              ? "2026-10-09"
              : state.draft.date),
        preferTrain: /低价|便宜|价格优先/.test(text)
          ? false
          : /高铁优先/.test(text)
            ? true
            : state.draft.preferTrain,
        allowAir: /不接受(?:飞机|机票)|不坐飞机|只坐高铁/.test(text)
          ? false
          : /飞机|机票/.test(text)
            ? true
            : state.draft.allowAir,
      };
      const error = validate(request);
      if (error)
        return respond(
          { ...next, proposalReady: false },
          error + "请补充后再比较方案。",
        );
      return respond(
        {
          ...next,
          draft: request,
          editing: true,
          selected: null,
          proposalReady: true,
        },
        "我把你的需求整理在下面了。未提到的字段沿用当前样例值，请核对具体日期、总预算和人数，再确认筛选。演示只做本地规则解析，不调用真实模型。",
      );
    }
    case "edit":
      return { ...next, editing: true, selected: null };
    case "cancelEdit":
      return state.confirmed
        ? {
            ...next,
            draft: { ...state.confirmed },
            editing: false,
            selected: null,
          }
        : next;
    case "filter":
      return { ...next, filter: action.value, selected: null };
    case "sort":
      return { ...next, sort: action.value, selected: null };
    case "preset": {
      if (state.order)
        return { ...next, notice: "已有演示订单。重新演示后可载入其他场景。" };
      const request = {
        ...initialState().draft,
        ...(action.value === "price"
          ? { budget: 500, preferTrain: false }
          : action.value === "pair"
            ? { budget: 1600, passengers: 2 }
            : {}),
      };
      return reduce(
        { ...next, filter: "all", sort: "recommended", tab: "plan" },
        { type: "confirm", request },
      );
    }
    case "resetRequest":
      return { ...next, resetRequested: true, selected: null };
    case "resetCancel":
      return { ...next, resetRequested: false };
    case "reset":
      return state.resetRequested ? initialState() : next;
    case "tab":
      return { ...next, tab: action.tab, selected: null };
    case "confirm": {
      const error = validate(action.request);
      if (error)
        return {
          ...next,
          draft: { ...action.request },
          editing: true,
          notice: error,
        };
      return {
        ...next,
        draft: { ...action.request },
        confirmed: { ...action.request },
        editing: false,
        proposalReady: false,
        watch: state.watch === "active" ? "paused" : state.watch,
        selected: null,
        dropped: false,
        notice: "出行需求已确认，已按预算与到达时间筛选样例方案。",
      };
    }
    case "watch": {
      if (!state.confirmed || hasUnconfirmedEdits(state))
        return { ...next, notice: "请先确认当前出行需求。" };
      if (
        (action.command === "start" || action.command === "resume") &&
        (state.watch === "active" || state.order)
      )
        return next;
      if (action.command === "resume" && state.watch !== "paused") return next;
      if (action.command === "pause" && state.watch !== "active") return next;
      return {
        ...next,
        watch:
          action.command === "start" || action.command === "resume"
            ? "active"
            : action.command === "pause"
              ? "paused"
              : "stopped",
        notice:
          action.command === "pause"
            ? "已暂停价格监测。已有订单仍保留。"
            : action.command === "stop"
              ? "监测已停止。已有订单不会取消。"
              : "演示监测已开启。点击价格变化按钮，查看提醒如何触发。",
      };
    }
    case "drop": {
      if (state.watch !== "active" || state.dropped) return next;
      const changed = { ...next, dropped: true };
      const match = candidates(changed).find(
        (item) => item.offer.id === "flight",
      );
      return {
        ...changed,
        notice:
          match && !match.reason
            ? "模拟提醒：机票含税价降至498元/人，符合你的约束。未自动下单。"
            : "已模拟价格变化，但机票仍不符合当前约束，不触发购票提醒。",
      };
    }
    case "select": {
      const match = candidates(state).find(
        (item) => item.offer.id === action.id,
      );
      if (
        !state.confirmed ||
        hasUnconfirmedEdits(state) ||
        !match ||
        match.reason ||
        state.order
      )
        return {
          ...next,
          notice: state.order
            ? "已有演示订单。请先查看原订单，避免重复购买。"
            : "请确认需求并选择符合约束的方案。",
        };
      return { ...next, selected: action.id };
    }
    case "dismiss":
      return { ...next, selected: null };
    case "submit": {
      const match = candidates(state).find(
        (item) => item.offer.id === state.selected,
      );
      if (
        !state.confirmed ||
        hasUnconfirmedEdits(state) ||
        !match ||
        match.reason ||
        state.order
      )
        return next;
      return {
        ...next,
        order: {
          id: "DEMO-0001",
          offer: { ...match.offer },
          total: match.total,
          request: { ...state.confirmed },
          status: state.loseResponse ? "unknown" : "pendingPayment",
        },
        dispatchCount: state.dispatchCount + 1,
        selected: null,
        tab: "orders",
        watch: "paused",
        notice: state.loseResponse
          ? "模拟提交回执丢失。请核查原订单；不会重复提交。"
          : "演示订单已受理，等待模拟付款；没有真实购票或扣款。",
      };
    }
    case "reconcile":
      return state.order?.status === "unknown"
        ? {
            ...next,
            order: { ...state.order, status: "pendingPayment" },
            notice: "已模拟查回原订单，未重新提交。",
          }
        : next;
    case "pay":
      return state.order?.status === "pendingPayment"
        ? {
            ...next,
            order: { ...state.order, status: "ticketing" },
            notice: "模拟支付成功，等待出票。没有扣款。",
          }
        : next;
    case "issue":
      return state.order?.status === "ticketing"
        ? {
            ...next,
            order: { ...state.order, status: "ticketed" },
            watch: "stopped",
            notice: "演示出票完成。此记录不是有效车票或机票。",
          }
        : next;
  }
}
