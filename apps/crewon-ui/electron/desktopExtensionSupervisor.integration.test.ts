import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { expect, it, vi } from "vitest";
import {
  DESKTOP_RUNTIME_OWNER,
  parseDesktopExtensionRuntimeConfiguration,
} from "./desktopExtensionRuntime.ts";
import { RuntimeSupervisor } from "./runtimeSupervisor.ts";

function fixture(mode: "valid" | "wrong-owner" | "no-ready" | "disabled") {
  const directory = mkdtempSync(
    join(tmpdir(), "crewon-native-extension-supervisor-"),
  );
  const audit = join(directory, "audit.jsonl");
  const shared = `
    import {appendFileSync} from 'node:fs';
    import {createHash} from 'node:crypto';
    const audit=${JSON.stringify(audit)};
    const env=process.env;
    const actor={principalId:env.CREWON_PRINCIPAL_ID,actorId:env.CREWON_ACTOR_ID,tenantId:env.CREWON_TENANT_ID,spaceId:env.CREWON_SPACE_ID};
    const record=(event)=>appendFileSync(audit,JSON.stringify({event,pid:process.pid,actor,agentVersionId:env.CREWON_AGENT_VERSION_ID,extensions:Object.fromEntries(Object.entries(env).filter(([k])=>k.startsWith('CREWON_EXTENSION'))),tokenHash:env.CREWON_EXTENSION_HOST_TOKEN?createHash('sha256').update(env.CREWON_EXTENSION_HOST_TOKEN).digest('hex'):null})+'\\n');
  `;
  const release = join(directory, "release.mjs"),
    worker = join(directory, "worker.mjs"),
    control = join(directory, "control.mjs");
  writeFileSync(release, shared + `record('release');`);
  writeFileSync(
    worker,
    shared +
      `
    import {createServer} from 'node:http';
    record('worker');process.stdin.resume();
    if (${JSON.stringify(mode)}!=='no-ready' && env.CREWON_EXTENSIONS_ENABLED==='1') {
      const server=createServer(async(req,res)=>{
        if(req.headers.authorization!=='Bearer '+env.CREWON_EXTENSION_HOST_TOKEN){res.writeHead(401).end();return;}
        let raw='';for await(const chunk of req)raw+=chunk;
        const input=JSON.parse(raw);if(JSON.stringify(input.actor)!==JSON.stringify(actor)){res.writeHead(403).end();return;}
        record('challenge');res.writeHead(200,{'content-type':'application/json'});
        res.end(JSON.stringify({protocol:'crewon.extension-host-response.v0',operation:'catalog',actor:${JSON.stringify(mode)}==='wrong-owner'?{...actor,principalId:'intruder'}:actor,registrations:[]}));
      });
      server.listen(0,'127.0.0.1',()=>{
        record('ready');process.stdout.write('CrewON Extension Host origin http://127.0.0.1:'+server.address().port+'\\n');
      });
    }
  `,
  );
  writeFileSync(
    control,
    shared +
      `
    import {createServer} from 'node:http';
    record('control');createServer((_req,res)=>res.writeHead(200,{'content-type':'application/json'}).end('{}')).listen(Number(env.CREWON_CONTROL_PORT),'127.0.0.1');
  `,
  );
  const logs: string[] = [];
  const output = () =>
    new Writable({
      write(chunk, _encoding, done) {
        logs.push(chunk.toString());
        done();
      },
    });
  const stdout = output(),
    stderr = output();
  const supervisor = new RuntimeSupervisor({
    dataDirectory: directory,
    repositoryRoot: directory,
    paths: {
      control,
      worker,
      release,
      source: false,
      modelCatalog: "/unused",
      workspaceMcp: "/unused",
    },
    provider: () => ({
      providerId: "fixture",
      endpoint: "http://127.0.0.1:1/v1",
      modelId: "fixture-model",
      apiKey: null,
    }),
    providerModelCatalog: async () => ["fixture-model"],
    agentPlatformApiKeyForOrigin: () => null,
    workspaceRoot: () => null,
    logOutputs: { stdout, stderr },
    extensionRuntime: {
      configuration: () =>
        parseDesktopExtensionRuntimeConfiguration(
          mode === "disabled"
            ? {
                schemaVersion: "crewon.desktop-extension-runtime.v0",
                enabled: false,
              }
            : {
                schemaVersion: "crewon.desktop-extension-runtime.v0",
                enabled: true,
                runtimeBindingsPath: null,
                agentVersionAssetsPath: null,
              },
        ),
      deadlineMs: 1000,
    },
  });
  const records = () =>
    readFileSync(audit, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return {
    supervisor,
    records,
    logs,
    async close() {
      await supervisor.stop();
      stdout.destroy();
      stderr.destroy();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

it("starts real Node Worker before Control, authenticates the owner and rotates private peers across restart", async () => {
  const f = fixture("valid");
  try {
    await f.supervisor.start();
    const first = f.supervisor.session();
    const original = f.records();
    expect(original.map((r) => r.event)).toEqual([
      "release",
      "worker",
      "ready",
      "challenge",
      "control",
    ]);
    expect(
      original.every(
        (r) =>
          JSON.stringify(r.actor) === JSON.stringify(DESKTOP_RUNTIME_OWNER),
      ),
    ).toBe(true);
    expect(original[0].extensions).toEqual({
      CREWON_EXTENSIONS_ENABLED: "1",
      CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT: expect.any(String),
    });
    expect(
      original[1].extensions.CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT,
    ).toBeUndefined();
    expect(
      original[4].extensions.CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT,
    ).toBeUndefined();
    expect(original[4].extensions.CREWON_EXTENSION_HOST_PORT).toBeUndefined();
    expect(original[4].tokenHash).toBe(original[1].tokenHash);
    const token = original[1].extensions.CREWON_EXTENSION_HOST_TOKEN;
    expect(token).toHaveLength(64);
    expect(JSON.stringify(first)).not.toContain(token);
    expect(f.logs.join("")).not.toContain(token);
    const firstPids = original
      .filter((r) => r.event === "worker" || r.event === "control")
      .map((r) => r.pid);
    await f.supervisor.restart();
    expect(f.supervisor.session()).toEqual(first);
    const second = f.records().slice(original.length);
    expect(second.map((r) => r.event)).toEqual([
      "release",
      "worker",
      "ready",
      "challenge",
      "control",
    ]);
    expect(second[1].tokenHash).not.toBe(original[1].tokenHash);
    expect(second[1].agentVersionId).toBe(original[1].agentVersionId);
    for (const pid of firstPids) expect(() => process.kill(pid, 0)).toThrow();
    await f.supervisor.stop();
    for (const r of second.filter(
      (r) => r.event === "worker" || r.event === "control",
    ))
      expect(() => process.kill(r.pid, 0)).toThrow();
  } finally {
    await f.close();
  }
}, 10000);

it("rejects a substituted owner before Control starts and stops the partial Worker", async () => {
  const f = fixture("wrong-owner");
  try {
    await expect(f.supervisor.start()).rejects.toThrow(
      "desktop_extension_host_owner_mismatch",
    );
    expect(f.records().some((r) => r.event === "control")).toBe(false);
    expect(() =>
      process.kill(f.records().find((r) => r.event === "worker").pid, 0),
    ).toThrow();
    expect(() => f.supervisor.session()).toThrow("control_runtime_unavailable");
  } finally {
    await f.close();
  }
});

it("cancels pending native readiness on stop and leaves no Control or orphaned Worker", async () => {
  const f = fixture("no-ready");
  try {
    const startup = f.supervisor.start();
    const assertion = expect(startup).rejects.toThrow(
      "desktop_extension_host_start_aborted",
    );
    await vi.waitFor(
      () => expect(f.records().some((r) => r.event === "worker")).toBe(true),
      { timeout: 2000, interval: 10 },
    );
    await f.supervisor.stop();
    await assertion;
    expect(f.records().some((r) => r.event === "control")).toBe(false);
    expect(() =>
      process.kill(f.records().find((r) => r.event === "worker").pid, 0),
    ).toThrow();
  } finally {
    await f.close();
  }
});

it("keeps disabled children free of ambient plugin settings", async () => {
  vi.stubEnv("CREWON_EXTENSIONS_ENABLED", "1");
  vi.stubEnv("CREWON_EXTENSION_HOST_TOKEN", "ambient-secret");
  const f = fixture("disabled");
  try {
    await f.supervisor.start();
    f.supervisor.session();
    await vi.waitFor(() => expect(f.records()).toHaveLength(3), {
      timeout: 2000,
      interval: 10,
    });
    expect(
      f.records().every((r) => Object.keys(r.extensions).length === 0),
    ).toBe(true);
    expect(f.records().some((r) => r.event === "challenge")).toBe(false);
  } finally {
    await f.close();
    vi.unstubAllEnvs();
  }
});
