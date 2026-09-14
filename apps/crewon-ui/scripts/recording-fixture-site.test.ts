import { afterEach, expect, it } from "vitest";
import {
  Window,
  type HTMLInputElement,
  type HTMLButtonElement,
  type HTMLAnchorElement,
} from "happy-dom";
import { runInNewContext } from "node:vm";
import { startRecordingFixtureSite } from "./recording-fixture-site.ts";

const SEPTEMBER_CSV =
  "order_id,channel,currency,amount,status\nA001,direct,CNY,100,paid\nA002,direct,CNY,50,canceled\n";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const { server, url } = await startRecordingFixtureSite({ port: 0 });
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  return new URL(url).origin;
}
it("preserves September download bytes and rejects unavailable periods", async () => {
  const origin = await fixture();
  for (const path of ["/export.csv", "/export.csv?period=2026-09"])
    expect(await (await fetch(origin + path)).text()).toBe(SEPTEMBER_CSV);
  expect((await fetch(origin + "/export.csv?period=2026-11")).status).toBe(400);
});
it("uses the actual date and filter handler to change the table and downloaded period", async () => {
  const origin = await fixture();
  const window = new Window({
    url: origin + "/orders",
    settings: { enableJavaScriptEvaluation: false },
  });
  cleanups.push(() => window.happyDOM.close());
  window.document.write(await (await fetch(origin + "/orders")).text());
  // Execute the exact script served by the fixture against DOM controls; this is
  // a simulated DOM plus real HTTP test, not an Electron/manual-input claim.
  runInNewContext(await (await fetch(origin + "/business.js")).text(), {
    document: window.document,
    location: window.location,
    encodeURIComponent,
  });
  const date = window.document.querySelector<HTMLInputElement>("#date")!;
  const filter = window.document.querySelector<HTMLButtonElement>("#filter")!;
  const download =
    window.document.querySelector<HTMLAnchorElement>("#download")!;
  date.value = "2026-10-01";
  expect(download.href).toBe(origin + "/export.csv"); // date alone has not applied a filter
  filter.click();
  expect(download.href).toBe(origin + "/export.csv?period=2026-10");
  expect(window.document.querySelector("#order-rows")!.textContent).toContain(
    "A101110.00paid",
  );
  expect(
    window.document.querySelector("#order-rows")!.textContent,
  ).not.toContain("A001");
  const csv = await (await fetch(download.href)).text();
  const rows = csv
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.split(","));
  const target = rows.filter(
    (row) => row[1] === "direct" && row[2] === "CNY" && row[4] === "paid",
  );
  expect(target.map((row) => row[0])).toEqual(["A101", "A103"]);
  expect(target.reduce((sum, row) => sum + Number(row[3]) * 100, 0)).toBe(
    20000,
  );
  expect(rows.some((row) => row[4] === "canceled")).toBe(true);
  expect(rows.some((row) => row[1] !== "direct")).toBe(true);
  expect(rows.some((row) => row[2] !== "CNY")).toBe(true);
  date.value = "2026-09-01";
  filter.click();
  expect(await (await fetch(download.href)).text()).toBe(SEPTEMBER_CSV);
  date.value = "2026-11-01";
  filter.click();
  expect(download.hasAttribute("href")).toBe(false);
  expect(download.getAttribute("aria-disabled")).toBe("true");
});
