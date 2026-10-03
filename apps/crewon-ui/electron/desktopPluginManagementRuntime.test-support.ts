import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { RuntimeSupervisor } from "./runtimeSupervisor.ts";
import { desktopPluginBootstrapFixture } from "./desktopPluginBootstrap.test-support.ts";

export function desktopPluginManagementFixture(input: {
  provider: "absent" | "configured";
  approval: "absent" | "present";
  controlHealth?: "live" | "unavailable";
}) {
  const files = desktopPluginBootstrapFixture();
  if (input.approval === "present") files.writeApproval();
  const audit = join(files.directory, "children.jsonl");
  const shared = [
    "import {appendFileSync,readFileSync} from 'node:fs';",
    "const env=process.env;const bootstrap=env.CREWON_DESKTOP_PLUGIN_BOOTSTRAP_PATH;",
    "const record=(kind)=>appendFileSync(" +
      JSON.stringify(audit) +
      ",JSON.stringify({",
    "kind,pid:process.pid,bootstrapPath:bootstrap??null,",
    "manifest:bootstrap?JSON.parse(readFileSync(bootstrap,'utf8')):null,",
    "modelApiKey:env.CREWON_MODEL_API_KEY??null,agentVersionId:env.CREWON_AGENT_VERSION_ID,",
    "artifactDb:env.CREWON_ARTIFACT_DB_PATH,artifactKey:env.CREWON_ARTIFACT_ENCRYPTION_KEY_ID,",
    "ambientPluginKeys:Object.keys(env).filter(k=>k.startsWith('CREWON_PLUGIN_')),",
    "actor:{principalId:env.CREWON_PRINCIPAL_ID,actorId:env.CREWON_ACTOR_ID,tenantId:env.CREWON_TENANT_ID,spaceId:env.CREWON_SPACE_ID}",
    "})+'\\n');",
  ].join("\n");
  const paths = {
    control: join(files.directory, "control.mjs"),
    release: join(files.directory, "release.mjs"),
    worker: join(files.directory, "worker.mjs"),
    modelCatalog: "/unused/model-catalog",
    workspaceMcp: "/unused/mcp",
    source: false,
  };
  writeFileSync(paths.release, shared + "record('release');");
  writeFileSync(
    paths.worker,
    shared +
      "record('worker');process.stdin.resume();setInterval(()=>{},1000);",
  );
  writeFileSync(
    paths.control,
    shared +
      [
        "import {createServer} from 'node:http';record('control');",
        "const server=createServer((req,res)=>{res.setHeader('content-type','application/json');",
        "if(req.url==='/api/v1/health/live'){res.statusCode=" +
          (input.controlHealth === "unavailable" ? 503 : 200) +
          ";res.end('{}');return;}",
        "if(req.url==='/api/v1/health/ready'){res.statusCode=" +
          (input.provider === "configured" ? 200 : 503) +
          ";res.end('{}');return;}",
        "res.statusCode=404;res.end('{}');});",
        "server.listen(Number(env.CREWON_CONTROL_PORT),'127.0.0.1');",
        "process.on('SIGTERM',()=>server.close(()=>process.exit(0)));",
      ].join("\n"),
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
  const owner = new RuntimeSupervisor({
    dataDirectory: files.dataDirectory,
    paths,
    repositoryRoot: files.directory,
    provider: () =>
      input.provider === "absent"
        ? null
        : {
            providerId: "orchestration-fixture",
            endpoint: "http://127.0.0.1:1/v1",
            modelId: "fixture-model",
            apiKey: "fixture-model-secret",
          },
    providerModelCatalog: async () => ["fixture-model"],
    agentPlatformApiKeyForOrigin: () => null,
    workspaceRoot: () => null,
    logOutputs: { stdout, stderr },
  });
  return {
    ...files,
    owner,
    logs,
    records: (): Array<{
      kind: string;
      pid: number;
      bootstrapPath: string | null;
      manifest: Record<string, unknown> | null;
      modelApiKey: string | null;
      ambientPluginKeys: string[];
      actor: unknown;
      agentVersionId: string;
      artifactDb: string;
      artifactKey: string;
    }> =>
      existsSync(audit)
        ? readFileSync(audit, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [],
    bootstrapFiles: () =>
      readdirSync(files.dataDirectory).filter((name) =>
        name.startsWith("plugin-bootstrap-"),
      ),
    close: async () => {
      await owner.stop();
      stdout.destroy();
      stderr.destroy();
      rmSync(files.directory, { recursive: true, force: true });
    },
  };
}
