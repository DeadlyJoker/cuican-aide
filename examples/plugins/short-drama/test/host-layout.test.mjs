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
    assert.equal(calls[0].input.context.createOrigin,"creative");
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
    assert.equal(f.container.querySelector("h1").textContent,"新建短剧");
    await snapshot("host-creation-heading",f.container.querySelector(".drama-home-hero>h1").outerHTML);
    assert.equal(f.container.querySelectorAll("textarea").length,1);
  } finally {await f.dispose();}
});
