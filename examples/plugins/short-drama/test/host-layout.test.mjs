import { foundationProps, foundationService } from "./foundation-ui.test-support.mjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import { metadataService, persistentProps } from "./persistent-ui.test-support.mjs";

const directory=process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ?? new URL(`../dist/${process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "51.0.0"}/`,import.meta.url).pathname;
const {default:definition}=await import(pathToFileURL(join(directory,"ui.mjs")).href);
after(async () => browser.happyDOM.close());
async function snapshot(name, html) {
  const file=new URL(`./snapshots/${name}.html`,import.meta.url);
  if(process.env.CREWON_UPDATE_HOST_LAYOUT_SNAPSHOTS === "1") await writeFile(file,html+"\n");
  assert.equal(html,(await readFile(file,"utf8")).trimEnd());
}
test("host sidebar owns project creation without duplicating the plugin title",async () => {
  const base=metadataService(), calls=[];
  const props=persistentProps(true);
  const f=fixture(definition,{props:{...props,data:{...props.data,hostPresentation:{surface:"sidebar",context:{}}}},services:{async invoke(action,input,options){
    if(action.startsWith("crewon.plugin-navigation")){calls.push({action,input});throw new Error("named_navigation_fixture");}
    return base.services.invoke(action,input,options);
  }}});
  try {
    await settle();
    assert.equal(f.container.querySelector("h2"),null);
    await snapshot("host-project-heading",f.container.querySelector(".drama-sidebar-heading").outerHTML);
    await f.click(f.container.querySelector('[aria-label="新建项目"]'));
    assert.equal(calls.length,1);
    assert.deepEqual(calls[0].input.context,{});
    assert.equal(base.calls.some(call => call.action.endsWith("createProject")),false);
  } finally {await f.dispose();}
});
test("host workbench focuses on creation and results instead of repeating the project directory",async () => {
  const base=metadataService(),props=persistentProps(true);
  const f=fixture(definition,{props:{...props,data:{...props.data,hostPresentation:{surface:"workbench",context:{}}}},services:base.services});
  try {
    await settle();
    assert.equal(f.container.querySelector(".drama-topbar"),null);
    assert.equal(f.container.querySelector(".drama-home-projects"),null);
    assert.equal(f.container.querySelector(".drama-recovery-disclosure"),null);
    assert.equal(f.container.querySelector("h1").textContent,"从想法开始");
    await snapshot("host-creation-heading",f.container.querySelector(".drama-home-hero>h1").outerHTML);
    assert.equal(f.container.querySelectorAll("textarea").length,0);
  } finally {await f.dispose();}
});

test("failed sidebar reads stay visible and retry only when the user requests it", async () => {
  const base=metadataService(), props=persistentProps(true);
  base.create("已保存的短剧", "创作需求");
  base.refuse(true);
  const f=fixture(definition,{props:{...props,data:{...props.data,hostPresentation:{surface:"sidebar",context:{}}}},services:base.services});
  try {
    await settle();
    assert.ok(f.container.querySelector('[role="alert"]'));
    const reads=base.methodCalls("listProjects").length;
    await settle();
    assert.equal(base.methodCalls("listProjects").length, reads);
    base.refuse(false);
    const retry=[...f.container.querySelectorAll("button")].find(b=>b.textContent==="重试读取项目");
    assert.ok(retry);
    await f.click(retry);
    await settle();
    assert.equal(base.methodCalls("listProjects").length, reads+1);
    assert.equal(f.container.querySelector('[role="alert"]'),null);
    assert.ok(f.container.textContent.includes("已保存的短剧"));
    assert.equal(base.calls.some(call=>call.action.endsWith("createProject")),false);
  } finally { await f.dispose(); }
});

test("host project entry uses the shared Agent composer and never opens a second creative form", async () => {
  const base=foundationService(), calls=[], props=foundationProps();
  const presentation={surface:"workbench",context:{}};
  const f=fixture(definition,{props:{...props,data:{...props.data,hostPresentation:presentation}},services:{async invoke(action,input,options){
    if(action.startsWith("crewon.plugin-navigation")){calls.push({action,input});throw new Error("named_navigation_fixture");}
    return base.services.invoke(action,input,options);
  }}});
  try {
    await settle();
    assert.equal(f.container.querySelector("textarea,form"),null);
    assert.match(f.container.textContent,/在中间告诉 Agent/);
    assert.equal(base.methodCalls("createProject").length,0);
    assert.equal(calls.length,0);
    f.instance.update({...props,data:{...props.data,hostPresentation:{...presentation,context:{createOrigin:"creative"}}}});
    await settle();
    assert.equal(f.container.querySelector("dialog[open]"),null);
    assert.equal(f.container.querySelector("textarea,form"),null);
    assert.equal(base.calls.some(c=>/startStage|createConversation|createProject|generation/.test(c.action)),false);
    if(process.env.CREWON_PROJECT_ENTRY_VISUAL_FIXTURE) await writeFile(process.env.CREWON_PROJECT_ENTRY_VISUAL_FIXTURE,`<!doctype html><html lang="zh"><meta charset="utf-8"><title>短剧项目入口 · 组件验收（测试数据）</title><style>:root{--bg:#fafafa;--text:#202020;--text-muted:#555;--border:#d8d8d8;--control-surface-active:#e8e8e8;--user-ui-font-size:14px}body{margin:0;font-family:system-ui}main{width:560px;min-height:600px;margin:auto;border-inline:1px solid var(--border)}</style><body><main>${f.container.innerHTML}</main></body></html>`);
  }finally{await f.dispose();}
});

test("project stages belong to right page navigation and reuse one project tab without execution", async () => {
  const base=metadataService(), saved=base.create("导航验收", "创作需求"), calls=[], props=persistentProps(true);
  const projectId=saved.project.projectId;
  const context={projectId,stage:"overview"};
  const services={async invoke(action,input,options){
    if(action.startsWith("crewon.plugin-navigation")){calls.push({action,input});throw new Error("named_navigation_fixture");}
    return base.services.invoke(action,input,options);
  }};
  const sidebar=fixture(definition,{props:{...props,data:{...props.data,hostPresentation:{surface:"sidebar",context}}},services});
  const right=fixture(definition,{props:{...props,data:{...props.data,hostPresentation:{surface:"workbench",context}}},services});
  try {
    await settle();
    assert.equal(sidebar.container.querySelector('[aria-label="项目制作阶段"]'),null);
    const nav=right.container.querySelector('[aria-label="项目制作阶段"]');
    assert.ok(nav);
    await snapshot("host-stage-tabs",nav.outerHTML);
    if (process.env.CREWON_STAGE_VISUAL_FIXTURE) await writeFile(process.env.CREWON_STAGE_VISUAL_FIXTURE, `<!doctype html><html lang="zh"><meta charset="utf-8"><title>短剧阶段导航 · 验收视图</title><style>:root{--bg:#fafafa;--text:#202020;--text-muted:#555;--border:#d8d8d8;--control-surface-active:#e8e8e8;--user-ui-font-size:14px;--space-1:4px;--space-2:8px;--space-3:12px;--control-h-md:36px}body{margin:0;font-family:system-ui}main{width:520px;height:900px;margin:auto;border-inline:1px solid var(--border)}h1{font-size:14px;padding:12px;margin:0;border-bottom:1px solid var(--border)}</style><body><main><h1>右侧插件页 · 交互验收视图（测试数据）</h1>${right.container.innerHTML}</main></body></html>`);
    await right.click([...nav.querySelectorAll("button")].find(b=>b.textContent.trim()==="角色"));
    assert.equal(calls.length,1);
    assert.equal(calls[0].input.key,`project:${projectId}`);
    assert.deepEqual(calls[0].input.context,{projectId,stage:"characters"});
    assert.equal(base.calls.some(c=>/startStage|createConversation|generation/.test(c.action)),false);
  } finally {await sidebar.dispose();await right.dispose();}
});
