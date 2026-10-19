import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktopPluginBootstrapFixture } from "./desktopPluginBootstrap.test-support.ts";
import { prepareDesktopPluginBootstrap } from "./desktopPluginBootstrap.ts";
import {
  captureDesktopNativePluginPolicy,
  createDesktopNativePluginAuthority,
  DESKTOP_NATIVE_PLUGIN_POLICY_FILE,
} from "./desktopNativePluginAuthority.ts";
import { LocalWorkspaceAuthority } from "./localWorkspaceRegistry.ts";
import {
  DesktopNativeProjectWorkspaceBridge,
  type DesktopNativeProjectWorkspaceResponse,
  type DesktopNativeProjectWorkspaceTicket,
} from "./desktopNativeProjectWorkspaceBridge.ts";

const program = `
process.on("message", message => {
  if (message?.kind === "fixture.send") {
    process.send(message.request, () => process.send({kind:"fixture.sent",id:message.id}));
  } else if (message?.kind === "fixture.send-stop") {
    process.send({kind:"fixture.stopping"});
    for (const request of message.requests ?? [message.request]) process.send(request);
    process.kill(process.pid, "SIGSTOP");
  } else if (message?.schemaVersion === "crewon.desktop-native-project-workspace-response.v1") {
    process.send({kind:"fixture.response",response:message});
  } else if (message?.kind === "fixture.exit") process.exit(0);
  else if (message?.kind === "fixture.disconnect") process.disconnect();
});
process.send({kind:"fixture.ready"});
`;
export async function nativeProjectWorkspaceBridgeFixture(
  approvalRequirement: "none" | "perAction" = "none",
  controlProgram = program,
  options: Readonly<{
    beforeBootstrap?(
      fixture: ReturnType<typeof desktopPluginBootstrapFixture>,
    ): void;
  }> = {},
) {
  const f = desktopPluginBootstrapFixture();
  let bootstrap: NonNullable<
    Awaited<ReturnType<typeof prepareDesktopPluginBootstrap>>
  >;
  try {
    options.beforeBootstrap?.(f);
    f.writeApproval();
    bootstrap = (await prepareDesktopPluginBootstrap(f.input))!;
  } catch (error) {
    rmSync(f.directory, { recursive: true, force: true });
    throw error;
  }
  const packageIdentity = {
    pluginId: f.source.pluginId,
    publisherId: f.source.publisherId,
    version: f.source.version,
    packageDigest: f.source.packageDigest,
  };
  const policyPath = join(f.dataDirectory, DESKTOP_NATIVE_PLUGIN_POLICY_FILE);
  writeFileSync(
    policyPath,
    JSON.stringify({
      schemaVersion: "crewon.desktop-native-plugin-policy.v1",
      packages: [{ ...packageIdentity, approvalRequirement }],
      networkGrants: [],
    }),
    { mode: 0o600 },
  );
  const policy = captureDesktopNativePluginPolicy(f.dataDirectory, bootstrap)!;
  const native = createDesktopNativePluginAuthority({
    dataDirectory: f.dataDirectory,
    bootstrap,
    policy,
  });
  const ordinary = join(f.directory, "ordinary"),
    other = join(f.directory, "other");
  mkdirSync(ordinary, { mode: 0o700 });
  mkdirSync(other, { mode: 0o700 });
  const workspaces = new LocalWorkspaceAuthority(f.dataDirectory, ordinary);
  const children: { child: ChildProcess; terminated: Promise<void> }[] = [];
  const bridges: DesktopNativeProjectWorkspaceBridge[] = [];
  let sequence = 0;
  async function spawnControl() {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", controlProgram],
      {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      },
    );
    // Node can omit the aggregate ChildProcess close after IPC disconnect/send
    // errors. Join the actual process exit and each owned pipe's closure instead.
    const exited = new Promise<void>((resolve) => child.once("exit", resolve));
    const pipesClosed = [child.stdout, child.stderr].map(
      (pipe) =>
        new Promise<void>((resolve) =>
          pipe ? pipe.once("close", resolve) : resolve(),
        ),
    );
    const terminated = Promise.all([exited, ...pipesClosed]).then(() => {});
    child.stdout?.resume();
    child.stderr?.resume();
    children.push({ child, terminated });
    try {
      await waitMessage(child, (value) => value.kind === "fixture.ready");
      return child;
    } catch (error) {
      // No caller receives the fixture on startup failure, so this owner must
      // join its real process and pipes before releasing the Native resources.
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      await terminated;
      throw error;
    }
  }
  let control: ChildProcess;
  try {
    control = await spawnControl();
  } catch (error) {
    native.close();
    await bootstrap.cleanup();
    rmSync(f.directory, { recursive: true, force: true });
    throw error;
  }
  const signal = new AbortController();
  function bridge(
    options: Partial<
      ConstructorParameters<typeof DesktopNativeProjectWorkspaceBridge>[0]
    > = {},
  ) {
    const owner = new DesktopNativeProjectWorkspaceBridge({
      nativeAuthority: native,
      workspaces,
      control,
      signal: signal.signal,
      ...options,
    });
    bridges.push(owner);
    return owner;
  }
  async function send(
    child: ChildProcess,
    request: unknown,
    responseExpected = true,
  ) {
    const id = `sent-${++sequence}`;
    const sent = waitMessage(
      child,
      (value) => value.kind === "fixture.sent" && value.id === id,
    );
    const response = responseExpected
      ? waitMessage(
          child,
          (value) =>
            value.kind === "fixture.response" &&
            value.response?.requestId ===
              (request as { requestId?: unknown })?.requestId,
        ).then(
          (value) => value.response as DesktopNativeProjectWorkspaceResponse,
        )
      : undefined;
    child.send({ kind: "fixture.send", id, request });
    await sent;
    return response;
  }
  return {
    ...f,
    bootstrap,
    policy,
    policyPath,
    native,
    workspaces,
    ordinary,
    other,
    control,
    signal,
    packageIdentity,
    bridge,
    spawnControl,
    send,
    prepare: (
      owner: DesktopNativeProjectWorkspaceBridge,
      projectId = "project-a",
    ) => owner.prepare({ projectId, packageIdentity }),
    request: (
      ticket: DesktopNativeProjectWorkspaceTicket,
      requestId = "request-a",
    ) => ({
      schemaVersion: "crewon.desktop-native-project-workspace-request.v1",
      requestId,
      ticketId: ticket.ticketId,
    }),
    async close() {
      for (const owner of bridges) await owner.close();
      for (const { child } of children)
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGTERM");
      await Promise.all(children.map(({ terminated }) => terminated));
      // Negative pin-mutation fixtures cannot safely use the original cleanup owner.
      try {
        native.close();
      } catch {}
      try {
        await bootstrap.cleanup();
      } catch {}
      rmSync(f.directory, { recursive: true, force: true });
    },
  };
}

export function waitMessage(
  child: ChildProcess,
  accept: (value: any) => boolean,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const message = (value: unknown) => {
      if (value !== null && typeof value === "object" && accept(value)) {
        cleanup();
        resolve(value);
      }
    };
    const exit = () => {
      cleanup();
      reject(new Error("fixture_child_exited"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("fixture_message_deadline"));
    }, 5000);
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("message", message);
      child.removeListener("exit", exit);
    };
    child.on("message", message);
    child.on("exit", exit);
  });
}
