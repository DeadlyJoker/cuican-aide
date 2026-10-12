import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { parsePluginPackageDescriptor } from "@crewon/plugin-sdk/contracts";
import plugin from "../dist/0.2.3/ui.mjs";
import { initialState, reduce, candidates, validate } from "../dist/demo.mjs";
const confirm = (state = initialState(), values = {}) =>
  reduce(state, { type: "confirm", request: { ...state.draft, ...values } });
test("filters total group budget and arrival, never guesses eligibility", () => {
  let state = confirm();
  assert.deepEqual(
    candidates(state)
      .filter((x) => !x.reason)
      .map((x) => x.offer.id),
    ["rail", "flight"],
  );
  state = confirm(state, { passengers: 2 });
  assert.equal(candidates(state).filter((x) => !x.reason).length, 0);
  state = confirm(state, { budget: 1600, allowAir: false });
  assert.deepEqual(
    candidates(state)
      .filter((x) => !x.reason)
      .map((x) => x.offer.id),
    ["rail"],
  );
  assert.ok(validate({ ...state.draft, date: "2026-02-30" }));
});
test("price event is manual, deduplicated and blocked while paused", () => {
  let state = reduce(confirm(), { type: "watch", command: "start" });
  state = reduce(state, { type: "watch", command: "pause" });
  assert.equal(reduce(state, { type: "drop" }).dropped, false);
  state = reduce(state, { type: "watch", command: "resume" });
  state = reduce(state, { type: "drop" });
  assert.equal(
    candidates(state).find((x) => x.offer.id === "flight").total,
    498,
  );
  assert.deepEqual(reduce(state, { type: "drop" }), state);
});
test("unknown submit reconciles the original order without redispatch, paid is not ticketed", () => {
  let state = { ...confirm(), loseResponse: true };
  state = reduce(state, { type: "select", id: "rail" });
  state = reduce(state, { type: "submit" });
  assert.equal(state.order.status, "unknown");
  assert.equal(reduce(state, { type: "submit" }).dispatchCount, 1);
  state = reduce(state, { type: "reconcile" });
  assert.equal(state.order.id, "DEMO-0001");
  assert.equal(state.dispatchCount, 1);
  state = reduce(state, { type: "pay" });
  assert.equal(state.order.status, "ticketing");
  state = reduce(state, { type: "issue" });
  assert.equal(state.order.status, "ticketed");
});
test("editing or stopping a watch preserves the original submitted order snapshot", () => {
  let state = confirm();
  state = reduce(state, { type: "select", id: "rail" });
  state = reduce(state, { type: "submit" });
  const original = structuredClone(state.order);
  state = confirm(state, { budget: 500, date: "2026-10-10" });
  state = reduce(state, { type: "watch", command: "stop" });
  assert.deepEqual(state.order, original);
  assert.equal(reduce(state, { type: "select", id: "flight" }).selected, null);
});
function props(mode = "light", tokens = {}) {
  return {
    schemaVersion: "crewon.plugin-ui-props.v1",
    contributionId: "travel",
    theme: { mode, tokens },
    data: null,
  };
}
function mount() {
  const window = new Window();
  window.document.body.innerHTML =
    '<nav id="host">原宿主</nav><div id="root" style="color:red"></div>';
  const root = window.document.getElementById("root");
  let calls = 0;
  const instance = plugin.mount(root, props(), {
    invoke: async () => {
      calls++;
      throw new Error("no_host_io_in_demo");
    },
  });
  const click = (action) => {
    if (action.startsWith("tab-") && !root.querySelector(`[data-action="${action}"]`)) {
      instance.update({...props(),data:{hostPresentation:{surface:"workbench",context:{view:action.slice(4)}}}});
      return;
    }
    const button = root.querySelector(`[data-action="${action}"]`);
    assert.ok(button, action);
    assert.equal(button.disabled, false, action);
    button.click();
  };
  const confirmForm = () => {
    if (!root.querySelector('[data-role="request"]')) click("tab-plan");
    if (!root.querySelector('[data-role="request"]')) click("edit");
    return root
      .querySelector('[data-role="request"]')
      .dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
  };
  return { window, root, instance, click, confirmForm, calls: () => calls };
}
test("DOM user flow covers monitor, uncertain receipt, payment and issuance without IO", async () => {
  const app = mount();
  app.confirmForm();
  assert.equal(app.root.querySelectorAll(".offer").length, 3);
  app.click("start-watch");
  app.click("drop");
  assert.match(app.root.textContent, /498/);
  app.click("tab-plan");
  app.root.querySelector('[data-action="select"][data-id="rail"]').click();
  const lost = app.root.querySelector('[name="loseResponse"]');
  lost.checked = true;
  lost.dispatchEvent(new app.window.Event("input", { bubbles: true }));
  app.click("submit-order");
  assert.match(app.root.textContent, /结果待核实/);
  app.click("reconcile");
  assert.equal(
    app.root.querySelector('[data-role="dispatch-count"]').textContent,
    "1次",
  );
  app.click("pay");
  assert.match(app.root.textContent, /模拟出票中/);
  app.click("issue");
  assert.match(app.root.textContent, /演示已出票/);
  assert.equal(app.calls(), 0);
  await app.instance.dispose();
  await app.window.happyDOM.close();
});
test("theme updates preserve draft, remove old local tokens and unload only owned DOM", async () => {
  const app = mount();
  const before = app.window.document.getElementById("host").outerHTML;
  app.click("tab-plan");
  const input = app.root.querySelector('[name="budget"]');
  input.value = "1600";
  input.dispatchEvent(new app.window.Event("input", { bubbles: true }));
  await app.instance.update(props("light", { "--old-token": "red" }));
  await app.instance.update(props("dark", { "--text": "white" }));
  assert.equal(app.root.querySelector('[name="budget"]').value, "1600");
  assert.equal(
    app.root
      .querySelector(".travel-demo")
      .style.getPropertyValue("--old-token"),
    "",
  );
  assert.equal(app.root.querySelector(".travel-demo").dataset.theme, "dark");
  assert.equal(app.window.document.getElementById("host").outerHTML, before);
  await app.instance.dispose();
  assert.equal(app.root.children.length, 0);
  assert.equal(app.root.getAttribute("style"), "color:red");
  assert.equal(app.window.document.getElementById("host").outerHTML, before);
  await app.window.happyDOM.close();
});
test("visual structure snapshot keeps module navigation and comparison anatomy", async () => {
  const app = mount();
  app.confirmForm();
  const snapshot = {
    title: app.root.getAttribute("aria-label"),
    nav: [...app.root.querySelectorAll(".tabs button")].map(
      (x) => x.textContent,
    ),
    offers: [...app.root.querySelectorAll(".offer")].map((x) => ({
      id: x.dataset.offer,
      recommended: x.classList.contains("recommended"),
      excluded: x.classList.contains("excluded"),
      purchaseDisabled: x.querySelector("button").disabled,
    })),
    steps: [...app.root.querySelectorAll(".steps li")].map(
      (x) => x.textContent,
    ),
  };
  assert.deepEqual(snapshot, {
    title: null,
    nav: [],
    offers: [
      {
        id: "rail",
        recommended: true,
        excluded: false,
        purchaseDisabled: false,
      },
      {
        id: "flight",
        recommended: false,
        excluded: false,
        purchaseDisabled: false,
      },
      {
        id: "late",
        recommended: false,
        excluded: true,
        purchaseDisabled: true,
      },
    ],
    steps: [],
  });
  const css = app.root.querySelector("style").textContent;
  assert.ok(!/(?:^|\})\s*(?:body|html|:root)\b/.test(css));
  assert.match(css, /@container\(max-width:520px\)/);
  await app.instance.dispose();
  await app.window.happyDOM.close();
});
test("installable UI-only descriptor matches actual byte lengths and hashes", async () => {
  const descriptor = parsePluginPackageDescriptor(
    JSON.parse(
      await readFile(
        new URL("../dist/0.2.3/crewon.plugin.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  assert.equal(descriptor.entrypoints.node, null);
  assert.deepEqual(descriptor.requires, [{service:"crewon.plugin-navigation",apiVersion:"1",optional:true}]);
  for (const file of descriptor.files) {
    const bytes = await readFile(
      new URL("../dist/0.2.3/" + file.path, import.meta.url),
    );
    assert.equal(bytes.length, file.byteLength);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  }
});
test("unconfirmed draft edits cannot buy against a stale displayed request", async () => {
  const state = confirm();
  const dirty = { ...state, draft: { ...state.draft, budget: 1 } };
  assert.equal(reduce(dirty, { type: "select", id: "rail" }).selected, null);
  const app = mount();
  app.confirmForm();
  app.click("edit");
  const budget = app.root.querySelector('[name="budget"]');
  budget.value = "1";
  budget.dispatchEvent(new app.window.Event("input", { bubbles: true }));
  assert.equal(app.root.querySelector('[data-action="select"]').disabled, true);
  assert.match(
    app.root.querySelector('[data-role="draft-status"]').textContent,
    /重新确认/,
  );
  await app.instance.dispose();
  await app.window.happyDOM.close();
});

test("host Agent remains the only composer and manual confirmation gates offers", async()=>{
 const app=mount();assert.equal(app.root.querySelector('[data-role="chat"]'),null);assert.match(app.root.textContent,/中间告诉 Agent/);assert.equal(app.root.querySelector('.offer'),null);
 app.confirmForm();assert.equal(app.root.querySelectorAll('.offer').length,3);
 await app.instance.dispose();await app.window.happyDOM.close();
});

test("unsupported prompts do not propose default tickets, history is bounded and reset requires review", async () => {
  let state = reduce(initialState(), { type: "chat", text: "北京到上海" });
  assert.equal(state.proposalReady, false);
  assert.equal(state.confirmed, null);
  for (let i = 0; i < 20; i++)
    state = reduce(state, { type: "chat", text: "你好" });
  assert.equal(state.messages.length, 12);
  assert.deepEqual(reduce(state, { type: "reset" }), state);
  const app = mount();
  app.confirmForm();app.click("reset-request");app.click("reset-cancel");assert.ok(app.root.querySelector(".offer"));app.click("reset-request");app.click("reset");assert.equal(app.root.querySelector(".offer"),null);
  await app.instance.dispose();
  await app.window.happyDOM.close();
});

test("official rail handoff is available from Agent results and isolated from demo orders", async () => {
  const app = mount();
  app.confirmForm();
  app.click("tab-connections");
  const entry = app.root.querySelector(".official-rail");
  assert.ok(entry);
  const link = entry.querySelector("a");
  assert.equal(link.href, "https://kyfw.12306.cn/otn/leftTicket/init");
  assert.equal(link.target, "_blank");
  assert.equal(link.rel, "noopener noreferrer");
  assert.match(entry.textContent, /2026-10-09/);
  assert.match(entry.textContent, /非API连接/);
  assert.match(entry.textContent, /不会自动同步/);
  assert.equal(app.calls(), 0);
  assert.equal(app.root.querySelector('[data-role="dispatch-count"]'), null);
  app.click("tab-connections");
  assert.ok(app.root.querySelector(".official-rail"));
  await app.instance.dispose();
  await app.window.happyDOM.close();
});

test("plugin-owned sidebar opens scoped host pages through the public SDK",async()=>{
 const window=new Window();const root=window.document.createElement('div');window.document.body.append(root);const requests=[];
 const handle=plugin.mount(root,{...props(),data:{hostPresentation:{surface:"sidebar"}}},{invoke:async(action,input)=>{requests.push({action,input});return {version:"crewon.plugin-ui-navigation.v1",pageId:"one"}}});
 assert.deepEqual([...root.querySelectorAll('nav button')].map(item=>item.textContent),['我的行程','需求与方案','价格监测','订单与行程','服务连接']);root.querySelector('[data-action="tab-plan"]').click();await Promise.resolve();
 assert.deepEqual(requests,[{action:'crewon.plugin-navigation.open-page',input:{contributionId:'travel',key:'trip:example',title:'需求与方案',mode:'reuse',context:{view:'plan',tripKey:'example'}}}]);assert.equal(root.querySelector('textarea'),null);await handle.dispose();await window.happyDOM.close();
});

test("changing host view retains the same trip constraints and simulation state",async()=>{
 const app=mount();app.instance.update({...props(),data:{hostPresentation:{surface:'workbench',context:{view:'plan',tripKey:'example'}}}});app.confirmForm();
 app.instance.update({...props(),data:{hostPresentation:{surface:'workbench',context:{view:'watch',tripKey:'example'}}}});
 assert.ok(app.root.querySelector('[data-action="start-watch"]'));app.click("start-watch");assert.match(app.root.querySelector(".watch-stats").textContent,/800/);
 await app.instance.dispose();await app.window.happyDOM.close();
});
