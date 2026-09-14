import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { expect, it, vi } from "vitest";
import { RuntimeSupervisor } from "./runtimeSupervisor.ts";

it("starts, remains responsive and stops real runtime children across blocked-output restarts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-supervisor-logs-"));
  const control = join(directory, "control.mjs");
  const worker = join(directory, "worker.mjs");
  const release = join(directory, "release.mjs");
  const completions: (() => void)[] = [];
  const target = () =>
    new Writable({
      write(_chunk, _encoding, callback) {
        completions.push(callback);
      },
    });
  const stdout = target();
  const stderr = target();
  writeFileSync(
    release,
    `
    import { rmSync } from 'node:fs';
    import { join, dirname } from 'node:path';
    rmSync(join(dirname(process.env.CREWON_CONTROL_DB_PATH), 'worker-finished.json'), {force:true});
    process.stdout.write('Release prepared\\n');
  `,
  );
  writeFileSync(
    control,
    `
    import { createServer } from 'node:http';
    import { readFileSync } from 'node:fs';
    import { join, dirname } from 'node:path';
    createServer((_request, response) => {
      let worker = null;
      try { worker = JSON.parse(readFileSync(join(dirname(process.env.CREWON_CONTROL_DB_PATH), 'worker-finished.json'),'utf8')); } catch {}
      response.setHeader('content-type','application/json');
      response.end(JSON.stringify({controlPid: process.pid, worker}));
    }).listen(Number(process.env.CREWON_CONTROL_PORT), '127.0.0.1');
    process.stderr.write('Control listening\\n');
  `,
  );
  writeFileSync(
    worker,
    `
    import { once } from 'node:events';
    import { writeFileSync } from 'node:fs';
    import { join, dirname } from 'node:path';
    process.stdin.resume();
    const chunk = Buffer.alloc(64*1024,120);
    for (let i=0;i<512;i++) {
      const output = i%2 ? process.stdout : process.stderr;
      if (!output.write(chunk)) await once(output,'drain');
    }
    writeFileSync(join(dirname(process.env.CREWON_CONTROL_DB_PATH),'worker-finished.json'),JSON.stringify({
      pid: process.pid, bytes: chunk.length*512,
      model: process.env.CREWON_MODEL_ID,
      agentVersion: process.env.CREWON_AGENT_VERSION_ID,
      profiles: JSON.parse(process.env.CREWON_DEV_AGENT_PROFILES_JSON),
    }));
  `,
  );
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
      providerId: "test",
      endpoint: "http://127.0.0.1:1/v1",
      modelId: "test-model",
      apiKey: null,
    }),
    providerModelCatalog: async () => ["test-model"],
    agentPlatformApiKeyForOrigin: () => null,
    logOutputs: { stdout, stderr },
  });
  let identity: unknown;
  const pids = new Set<number>();
  try {
    for (let i = 0; i < 5; i++) {
      if (i === 0) await supervisor.start();
      else await supervisor.restart();
      const session = supervisor.session();
      await vi.waitFor(
        async () => {
          const result = await fetch(session.baseUrl, {
            signal: AbortSignal.timeout(1000),
          });
          const state = await result.json();
          expect(state.worker?.bytes).toBe(32 * 1024 * 1024);
          expect(pids.has(state.worker.pid)).toBe(false);
        },
        { timeout: 5000, interval: 20 },
      );
      const state = await (
        await fetch(session.baseUrl, { signal: AbortSignal.timeout(1000) })
      ).json();
      pids.add(state.controlPid);
      pids.add(state.worker.pid);
      const { pid: _pid, ...currentIdentity } = state.worker;
      if (i === 0) identity = currentIdentity;
      else expect(currentIdentity).toEqual(identity);
      expect(completions).toHaveLength(2);
      expect(stdout.writableLength + stderr.writableLength).toBeLessThanOrEqual(
        32 * 1024,
      );
      for (const status of Object.values(supervisor.logStatus())) {
        expect(status.queuedBytes).toBeLessThanOrEqual(128 * 1024);
        expect(status.queuedChunks).toBeLessThanOrEqual(64);
      }
    }
    await supervisor.stop();
    expect(() => supervisor.session()).toThrow("control_runtime_unavailable");
    expect(pids.size).toBe(10);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    for (const status of Object.values(supervisor.logStatus()))
      expect(status.queuedBytes).toBe(0);
    expect(
      readFileSync(join(directory, "worker-finished.json"), "utf8"),
    ).toContain("test-model");
  } finally {
    await supervisor.stop();
    for (const completion of completions) completion();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stdout.listenerCount("error")).toBe(0);
    expect(stderr.listenerCount("error")).toBe(0);
    stdout.destroy();
    stderr.destroy();
    rmSync(directory, { recursive: true });
  }
}, 25_000);
