import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DELIVERY_UPLOAD_BODY_BYTES } from "@crewon/domain/delivery-http-policy";
const exec = promisify(execFile);

test("nginx gives only the exact delivery POST upload location the shared larger body budget", async () => {
  const config = await readFile(
    new URL("../../../deploy/crewon/nginx.conf", import.meta.url),
    "utf8",
  );
  assert.match(config, /location ~ "\^\/api\/v1\/threads\/\[A-Za-z0-9\]/u);
  assert.equal((config.match(/client_max_body_size 64k;/gu) ?? []).length, 2);
  assert.equal(
    (
      config.match(
        new RegExp(`client_max_body_size ${DELIVERY_UPLOAD_BODY_BYTES};`, "gu"),
      ) ?? []
    ).length,
    1,
  );
  assert.match(config, /if \(\$request_method != POST\) \{ return 405; \}/u);
  assert.match(config, /proxy_request_buffering off;/u);
  assert.ok(config.includes('if ($request_uri ~ "[?]") { return 400; }'));
});

test("BFF image layout resolves the shared TypeScript policy through a real workspace path", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "crewon-bff-image-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const domain = path.join(root, "packages/domain");
  await mkdir(domain, { recursive: true });
  await cp(
    new URL("../../../packages/domain/package.json", import.meta.url),
    path.join(domain, "package.json"),
  );
  await cp(
    new URL("../../../packages/domain/src/", import.meta.url),
    path.join(domain, "src"),
    { recursive: true },
  );
  await mkdir(path.join(root, "node_modules/@crewon"), { recursive: true });
  await symlink(
    "../../packages/domain",
    path.join(root, "node_modules/@crewon/domain"),
  );
  const result = await exec(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      "import {DELIVERY_UPLOAD_BODY_BYTES} from '@crewon/domain/delivery-http-policy'; process.stdout.write(String(DELIVERY_UPLOAD_BODY_BYTES));",
    ],
    { cwd: root },
  );
  assert.equal(result.stdout, String(DELIVERY_UPLOAD_BODY_BYTES));
  const dockerfile = await readFile(
    new URL("../../../deploy/crewon/web-bff.Dockerfile", import.meta.url),
    "utf8",
  );
  assert.match(
    dockerfile,
    /COPY --chown=node:node packages\/domain\/src\/ \.\/packages\/domain\/src\//u,
  );
  assert.match(
    dockerfile,
    /ln -s \.\.\/\.\.\/packages\/domain node_modules\/@crewon\/domain/u,
  );
});
