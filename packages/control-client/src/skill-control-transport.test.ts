import test from "node:test";
import assert from "node:assert/strict";
import { ControlApiClient } from "./control-api-client.ts";
test("F03 authenticated Skill transport preserves session and CSRF but refuses namespace escape",async()=>{
 const calls:{url:string;init:RequestInit}[]=[];
 const client=new ControlApiClient({baseUrl:"https://control.example",accessToken:"session",csrfToken:"csrf",origin:"https://desktop.example",fetch:async(url,init={})=>{calls.push({url:String(url),init});return new Response('{}');}});
 await client.requestSkill('/api/v1/skills',{method:'POST',headers:{authorization:'attacker','idempotency-key':'recording-import-1'},body:'{}'});
 assert.equal(calls[0]?.url,'https://control.example/api/v1/skills');const h=new Headers(calls[0]?.init.headers);assert.equal(h.get('authorization'),'Bearer session');assert.equal(h.get('x-csrf-token'),'csrf');assert.equal(h.get('idempotency-key'),'recording-import-1');assert.equal(calls[0]?.init.credentials,'include');
 for(const path of ['https://attacker.example/api/v1/skills','/api/v1/skills/../runs','/api/v1/skills/%2e%2e/runs','/api/v1/runs'])assert.throws(()=>client.requestSkill(path));
 const noCsrf=new ControlApiClient({baseUrl:'https://control.example'});assert.throws(()=>noCsrf.requestSkill('/api/v1/skills',{method:'POST'}),/csrf/);assert.equal(calls.length,1);
});
