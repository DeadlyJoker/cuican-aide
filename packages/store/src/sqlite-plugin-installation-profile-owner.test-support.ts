import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { scope } from "./plugin-installation-store.test-support.ts";
import type { PluginProfileScope } from "@crewon/domain";

export async function fixture(t: TestContext) {
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-sqlite-plugin-owner-"),
  );
  const path = join(directory, "control.sqlite");
  const parents: SqliteRunStore[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const open = async () => {
    const parent = new SqliteRunStore(path);
    parents.push(parent);
    const store = parent.pluginInstallationStore();
    await store.migrate();
    return { parent, store };
  };
  const first = await open();
  const second = await open();
  const observer = new DatabaseSync(path);
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const ended = once(child, "exit");
        child.kill("SIGKILL");
        await ended;
      }
    }
    for (const parent of parents) await parent.close();
    observer.close();
    await rm(directory, { recursive: true, force: true });
  });
  const query = (sql: string) => observer.prepare(sql).all();
  const counts = () =>
    Object.fromEntries(
      [
        "installed_plugin_packages",
        "plugin_profile_selections",
        "plugin_installation_receipts",
      ].map((table) => [
        table,
        query("SELECT COUNT(*) AS count FROM " + table)[0]!.count,
      ]),
    );
  const failReceipts = (enabled: boolean) =>
    observer.exec(
      enabled
        ? "CREATE TRIGGER fixture_receipt_failure BEFORE INSERT ON plugin_installation_receipts BEGIN SELECT RAISE(ABORT,'plugin_installation_fixture_write_failed'); END"
        : "DROP TRIGGER fixture_receipt_failure",
    );
  const lockRoot = path + ".plugin-profile-locks";
  const lockFiles = async () =>
    (await readdir(lockRoot)).filter((file) => file.endsWith(".sqlite"));

  async function child(
    mode: "owner" | "writer",
    recipe?: unknown,
    childScope: PluginProfileScope = scope,
  ) {
    const module = new URL("./sqlite-run-store.ts", import.meta.url).href;
    const configuration = JSON.stringify({
      path,
      mode,
      scope: childScope,
      recipe,
    });
    const program = [
      "import {SqliteRunStore} from " + JSON.stringify(module) + ";",
      "const cfg=" + configuration + ";",
      "const parent=new SqliteRunStore(cfg.path);const store=parent.pluginInstallationStore();await store.migrate();",
      "let owner=null;if(cfg.mode==='owner')owner=await store.acquireProfileOwner({scope:cfg.scope,onOwnershipLost(){}});",
      "console.log(JSON.stringify({kind:'ready'}));",
      "process.stdin.once('data',async()=>{try{",
      "if(cfg.mode==='writer'){const value=cfg.recipe.selection?await store.commitSelection(cfg.recipe):await store.recordInstalledPackage(cfg.recipe);console.log(JSON.stringify({kind:'result',value}));}",
      "else {await owner.close();console.log(JSON.stringify({kind:'closed'}));}",
      "}catch(error){console.log(JSON.stringify({kind:'error',message:error.message,code:error.code}));}",
      "finally{process.stdin.destroy();await parent.close();}});",
    ].join("\n");
    const processChild = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", program],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    children.push(processChild);
    const messages: Record<string, unknown>[] = [];
    const waiting: Array<(value: Record<string, unknown>) => void> = [];
    let buffer = "",
      errors = "";
    processChild.stderr.on("data", (chunk) => {
      errors += String(chunk);
    });
    processChild.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      assert.ok(buffer.length < 65536);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline)) as Record<
          string,
          unknown
        >;
        buffer = buffer.slice(newline + 1);
        const receiver = waiting.shift();
        if (receiver) receiver(message);
        else messages.push(message);
      }
    });
    const next = () =>
      messages.length
        ? Promise.resolve(messages.shift()!)
        : new Promise<Record<string, unknown>>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("child_message_timeout: " + errors)),
              5000,
            );
            waiting.push((value) => {
              clearTimeout(timer);
              resolve(value);
            });
          });
    const ready = await next();
    assert.equal(ready.kind, "ready", errors);
    return {
      process: processChild,
      next,
      go: () => processChild.stdin.write("go\n"),
    };
  }
  return {
    ...first,
    peer: second.store,
    second,
    open,
    observer,
    path,
    directory,
    query,
    counts,
    failReceipts,
    lockRoot,
    lockFiles,
    child,
  };
}
