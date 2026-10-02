import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { RuntimeSupervisor } from "./runtimeSupervisor.ts";
import {
  deferred,
  flush,
  uiLease,
} from "./desktopPluginUiAssets.test-support.ts";
import { DesktopPluginUiAssetBroker } from "./desktopPluginUiAssets.ts";

async function managedFixture() {
  const directory = await mkdtemp(join(tmpdir(), "crewon-native-supervisor-"));
  const control = join(directory, "control.mjs"),
    worker = join(directory, "worker.mjs"),
    release = join(directory, "release.mjs");
  const lease = uiLease();
  await writeFile(join(directory, "lease.json"), JSON.stringify(lease));
  await writeFile(release, "export {};");
  await writeFile(worker, "process.stdin.resume();setInterval(()=>{},1000);");
  await writeFile(
    control,
    `import{createServer}from'node:http';import{readFileSync,writeFileSync,existsSync}from'node:fs';import{dirname,join}from'node:path';const root=dirname(process.env.CREWON_CONTROL_DB_PATH);createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/api/v1/health/ready'){res.end('{}');return;}if(req.headers.authorization!=='Bearer '+process.env.CREWON_CONTROL_SESSION_TOKEN||req.headers.origin!==process.env.CREWON_CONTROL_ORIGIN){res.statusCode=403;res.end('{}');return;}if(req.method==='DELETE'){writeFileSync(join(root,'delete-entered'),'1');if(existsSync(join(root,'reject-delete'))){res.statusCode=503;res.end('{}');return;}let t=setInterval(()=>{if(existsSync(join(root,'allow-delete'))){clearInterval(t);res.end('{"closed":true}');}},10);req.on('close',()=>{if(res.writableEnded)clearInterval(t);});return;}res.end(readFileSync(join(root,'lease.json')));}).listen(Number(process.env.CREWON_CONTROL_PORT),'127.0.0.1');`,
  );
  const owner = new RuntimeSupervisor({
    agentPlatformApiKeyForOrigin: () => null,
    dataDirectory: directory,
    repositoryRoot: directory,
    paths: {
      control,
      worker,
      release,
      modelCatalog: "/unused",
      workspaceMcp: "/unused",
      source: false,
    },
    provider: () => ({
      providerId: "native-fixture",
      endpoint: "http://127.0.0.1:1/v1",
      modelId: "fixture-model",
      apiKey: null,
    }),
    providerModelCatalog: async () => ["fixture-model"],
    workspaceRoot: () => null,
  });
  await owner.start();
  const broker = new DesktopPluginUiAssetBroker({
    session: () => ({
      ...owner.session(),
      generation: owner.sessionGeneration,
    }),
    controlOwner: () => owner.currentControlOwner(),
  });
  const off = owner.onSessionInvalidated(() => broker.invalidate());
  const binding = await broker.adopt({
    lease,
    expectedControlOrigin: new URL(owner.session().baseUrl).origin,
  });
  return {
    owner,
    broker,
    binding,
    directory,
    close: async () => {
      off();
      await writeFile(join(directory, "allow-delete"), "1");
      await broker.close();
      await owner.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function supervisor() {
  return new RuntimeSupervisor({
    agentPlatformApiKeyForOrigin: () => null,
    dataDirectory: "/unused-native-lifetime",
    repositoryRoot: null,
    paths: {
      control: "/unused/control",
      modelCatalog: "/unused/catalog",
      release: "/unused/release",
      worker: "/unused/worker",
      workspaceMcp: "/unused/mcp",
      source: false,
    },
    provider: () => null,
    providerModelCatalog: async () => null,
    workspaceRoot: () => null,
  });
}
describe("native asset cleanup before managed runtime shutdown", () => {
  it("withdraws the actual supervisor generation synchronously and waits for the transferred cleanup promise", async () => {
    const owner = supervisor(),
      physical = deferred<void>();
    let called = 0,
      done = false;
    const off = owner.onSessionInvalidated(() => {
      called++;
      return physical.promise;
    });
    const stopping = owner.stop().then(() => {
      done = true;
    });
    expect(owner.sessionGeneration).toBe(1);
    expect(called).toBe(1);
    await flush();
    expect(done).toBe(false);
    physical.resolve();
    await stopping;
    expect(done).toBe(true);
    off();
    await owner.stop();
    expect(called).toBe(1);
  });

  it("reports failed physical cleanup after terminal shutdown rather than announcing successful native release", async () => {
    const owner = supervisor();
    const off = owner.onSessionInvalidated(() =>
      Promise.reject(new Error("actual_cleanup_failed")),
    );
    await expect(owner.stop()).rejects.toThrow("native_session_cleanup_failed");
    off();
    await owner.stop();
  });

  it("actual managed restart keeps the old Control alive until its native DELETE finishes", async () => {
    const f = await managedFixture();
    try {
      const old = f.owner.currentControlOwner();
      const restarting = f.owner.restart();
      await vi.waitFor(
        async () =>
          expect(
            await readFile(join(f.directory, "delete-entered"), "utf8"),
          ).toBe("1"),
        { timeout: 3000 },
      );
      expect(old.exitCode).toBe(null);
      expect(old.signalCode).toBe(null);
      expect(f.broker.allows(f.binding.entryUrl)).toBe(false);
      expect(f.broker.usage.bindings).toBe(1);
      await writeFile(join(f.directory, "allow-delete"), "1");
      await restarting;
      expect(f.owner.currentControlOwner()).not.toBe(old);
      expect(old.exitCode !== null || old.signalCode !== null).toBe(true);
      expect(f.broker.usage.bindings).toBe(0);
    } finally {
      await f.close();
    }
  }, 12_000);

  it("actual Control crash retires only its settled native mount and permits automatic restart", async () => {
    const f = await managedFixture();
    try {
      const old = f.owner.currentControlOwner();
      old.kill("SIGKILL");
      await once(old, "close");
      await vi.waitFor(
        () => expect(f.owner.currentControlOwner()).not.toBe(old),
        { timeout: 5000 },
      );
      expect(f.broker.usage.bindings).toBe(0);
      expect(f.broker.allows(f.binding.entryUrl)).toBe(false);
    } finally {
      await f.close();
    }
  }, 12_000);

  it("actual terminal Control proves remote mount retirement after a live DELETE failed, without masking local uncertainty", async () => {
    const f = await managedFixture();
    try {
      const old = f.owner.currentControlOwner();
      await writeFile(join(f.directory, "reject-delete"), "1");
      await f.owner.restart();
      expect(old.exitCode !== null || old.signalCode !== null).toBe(true);
      expect(f.owner.currentControlOwner()).not.toBe(old);
      expect(f.broker.usage.bindings).toBe(0);
    } finally {
      await f.close();
    }
  }, 12_000);
});
