import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";

it("keeps the event loop responsive when actual stdout and stderr pipes are not consumed", async () => {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `
    const { RuntimeLogForwarder } = await import(process.argv[1]);
    const logs = new RuntimeLogForwarder({stdout:process.stdout,stderr:process.stderr});
    process.on('message', message => {
      if (message === 'ping') process.send({kind:'pong',state:logs.status()});
      if (message === 'stop') { logs.suspend(); process.exit(0); }
    });
    const chunk=Buffer.alloc(64*1024,120);
    for(let i=0;i<512;i++) {
      logs.write(i%2?'stdout':'stderr','Worker',chunk);
      await new Promise(resolve=>setImmediate(resolve));
    }
    process.send({kind:'ready'});
  `,
      new URL("./runtimeLogForwarder.ts", import.meta.url).href,
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
  deadline.unref();
  const closed = once(child, "close");
  const exited = once(child, "exit");
  const message = () =>
    Promise.race([
      once(child, "message"),
      exited.then(() => {
        throw new Error("log_process_exited_before_reply");
      }),
    ]);
  try {
    expect((await message())[0]).toEqual({ kind: "ready" });
    const reply = message();
    child.send("ping");
    const result = (await reply)[0];
    expect(result.kind).toBe("pong");
    for (const status of Object.values(result.state) as {
      queuedBytes: number;
      inFlightBytes: number;
      discardedBytes: number;
    }[]) {
      expect(status.queuedBytes).toBeLessThanOrEqual(128 * 1024);
      expect(status.inFlightBytes).toBeGreaterThan(0);
      expect(status.inFlightBytes).toBeLessThanOrEqual(16 * 1024);
      expect(status.discardedBytes).toBeGreaterThan(10 * 1024 * 1024);
    }
    child.send("stop");
    expect((await exited)[0]).toBe(0);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    child.stdout!.resume();
    child.stderr!.resume();
    await closed;
  }
}, 15_000);
