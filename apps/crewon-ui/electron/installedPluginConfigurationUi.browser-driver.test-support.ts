/** Real Chromium Web route acceptance; no formal Main, preload or Native access is substituted. */
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";

type Input = Readonly<{
  origin: string;
  cookieName: string;
  cookieValue: string;
  certificateFingerprint: string;
  phase: "write" | "read";
  value: string;
  pluginId: string;
  evidenceDirectory: string;
  userData: string;
}>;
type ResizeProof = Readonly<{
  width: number;
  height: number;
  horizontalOverflow: number;
  railWidth: number;
  canvasWidth: number;
  panelWidth: number;
  panelRight: number;
  panelMinWidth: string;
  panelDisplay: string;
  fieldReachable: boolean;
  saveReachable: boolean;
}>;
const input = JSON.parse(readFileSync(process.argv[2], "utf8")) as Input;
app.setPath("userData", input.userData);
let window: BrowserWindow | null = null;
const consoleErrors: string[] = [];

app.on(
  "certificate-error",
  (event, _contents, url, _error, certificate, done) => {
    let approved = false;
    try {
      approved =
        new URL(url).origin === input.origin &&
        new X509Certificate(certificate.data).fingerprint256 ===
          input.certificateFingerprint;
    } catch {
      /* All origins/certificates other than this explicitly named fixture stay rejected. */
    }
    if (approved) event.preventDefault();
    done(approved);
  },
);

async function evaluate<T>(source: string): Promise<T> {
  return window!.webContents.executeJavaScript(source) as Promise<T>;
}
async function waitFor(source: string, label: string): Promise<void> {
  const until = Date.now() + 30_000;
  while (true) {
    const failure = await evaluate<string | undefined>(
      "document.body.dataset.proofError",
    ).catch(() => undefined);
    assert.equal(failure, undefined, failure);
    if (await evaluate<boolean>(source).catch(() => false)) return;
    if (Date.now() >= until)
      throw new Error(
        `configuration_web_timeout:${label}:${JSON.stringify(consoleErrors)}`,
      );
    await new Promise((accept) => setTimeout(accept, 20));
  }
}
async function click(label: string, selector = "body"): Promise<void> {
  const scope = `document.querySelector(${JSON.stringify(selector)})`;
  const value = JSON.stringify(label);
  const match = `(b.getAttribute('aria-label')===${value}||b.textContent.trim()===${value})`;
  await waitFor(
    `Array.from(${scope}?.querySelectorAll('button')??[]).some(b=>!b.disabled&&b.checkVisibility()&&${match})`,
    "button " + label,
  );
  await evaluate(
    `Array.from(${scope}.querySelectorAll('button')).find(b=>!b.disabled&&b.checkVisibility()&&${match}).click()`,
  );
}
async function capture(name: string): Promise<void> {
  await evaluate(
    "new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))",
  );
  await new Promise((accept) => setTimeout(accept, 100));
  const pixels = await window!.webContents.capturePage();
  assert.ok(!pixels.isEmpty());
  writeFileSync(join(input.evidenceDirectory, name), pixels.toPNG());
}
async function settings(): Promise<void> {
  await waitFor(
    "document.querySelector('.sidebar-account summary')!==null",
    "original account menu",
  );
  await evaluate("document.querySelector('.sidebar-account summary').click()");
  await click("设置", ".sidebar-account");
  await click("工具与扩展", ".settings-sidebar");
  await waitFor(
    `document.querySelector('.installed-plugin-settings')?.textContent.includes(${JSON.stringify(input.pluginId)})`,
    "actual installed package catalog",
  );
}
async function checkResizedSettings(): Promise<readonly ResizeProof[]> {
  const original = window!.getContentSize();
  const proofs: ResizeProof[] = [];
  try {
    for (const [label, width, height] of [
      ["lowheight", 1280, 640],
      ["narrow", 860, 640],
    ] as const) {
      window!.setContentSize(width, height);
      await waitFor(
        `innerWidth===${width}&&innerHeight===${height}`,
        "actual " + label + " viewport",
      );
      const geometry = await evaluate<ResizeProof>(`(async()=>{
        const panel=document.querySelector('.installed-plugin-configuration');
        const field=panel.querySelector('input');
        const save=Array.from(panel.querySelectorAll('button')).find(b=>b.textContent.trim()==='保存参数');
        const within=element=>{const r=element.getBoundingClientRect();return element.checkVisibility()&&r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1};
        const painted=()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
        field.scrollIntoView({block:'center'});
        await painted();
        const fieldReachable=within(field);
        save.scrollIntoView({block:'center'});
        await painted();
        const bounds=panel.getBoundingClientRect();
        return {width:innerWidth,height:innerHeight,
          horizontalOverflow:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)-document.documentElement.clientWidth,
          railWidth:document.querySelector('.settings-sidebar').getBoundingClientRect().width,
          canvasWidth:document.querySelector('.settings-command-canvas').getBoundingClientRect().width,
          panelWidth:bounds.width,panelRight:bounds.right,panelMinWidth:getComputedStyle(panel).minWidth,
          panelDisplay:getComputedStyle(panel).display,fieldReachable,saveReachable:within(save)};
      })()`);
      assert.equal(geometry.horizontalOverflow, 0, label);
      assert.ok(geometry.railWidth > 0, label);
      assert.ok(geometry.canvasWidth > 0, label);
      assert.ok(geometry.panelWidth <= geometry.canvasWidth, label);
      assert.ok(geometry.panelRight <= width + 1, label);
      assert.equal(geometry.panelMinWidth, "0px", label);
      assert.equal(geometry.panelDisplay, "grid", label);
      assert.equal(geometry.fieldReachable, true, label);
      assert.equal(geometry.saveReachable, true, label);
      proofs.push(geometry);
      await capture("configuration-web-" + label + ".png");
    }
  } finally {
    window!.setContentSize(original[0]!, original[1]!);
    await waitFor(
      `innerWidth===${original[0]}&&innerHeight===${original[1]}`,
      "original viewport restored",
    );
  }
  return proofs;
}

void app.whenReady().then(async () => {
  try {
    window = new BrowserWindow({
      width: 1280,
      height: 900,
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    window.webContents.on("console-message", (details) => {
      if (
        (details.level === "error" || details.level === "warning") &&
        consoleErrors.length < 16
      )
        consoleErrors.push(details.message.slice(0, 256));
    });
    await window.webContents.session.cookies.set({
      url: input.origin,
      name: input.cookieName,
      value: input.cookieValue,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "strict",
    });
    await window.loadURL(
      input.origin + "/?surface=desktop&platform=mac&os=mac",
    );
    await waitFor(
      "document.querySelector('.sidebar-account summary')?.checkVisibility()===true",
      "original account menu is actually visible",
    );
    const originalShellStyles = await evaluate<Record<string, string>>(`(()=>{
      const win=document.querySelector('.command-window');
      const rail=document.querySelector('.command-sidebar');
      const account=document.querySelector('.sidebar-account');
      return {windowDisplay:getComputedStyle(win).display,railDisplay:getComputedStyle(rail).display,
        windowWidth:String(win.getBoundingClientRect().width),accountDisplay:getComputedStyle(account).display,
        font:getComputedStyle(rail).fontFamily};
    })()`);
    assert.equal(originalShellStyles.windowDisplay, "grid");
    assert.equal(originalShellStyles.railDisplay, "grid");
    assert.notEqual(originalShellStyles.accountDisplay, "none");
    await capture("configuration-web-" + input.phase + "-account.png");
    await settings();
    const originalNavigation = await evaluate<string[]>(
      "Array.from(document.querySelectorAll('.settings-sidebar strong')).map(e=>e.textContent.trim())",
    );
    for (const label of [
      "外观",
      "AI 模型",
      "工具与扩展",
      "助理与记忆",
      "常规",
      "账号",
      "安全与权限",
      "网页应用",
      "连接管理",
      "键盘快捷键",
    ])
      assert.ok(originalNavigation.includes(label), label);
    // The final labels/selectors are the production panel's accessible contract.
    await click("业务配置", ".installed-plugin-settings");
    await waitFor(
      "document.querySelector('.installed-plugin-configuration input')!==null",
      "actual schema-generated configuration input",
    );
    if (input.phase === "write") {
      await evaluate(`(()=>{
        const field=document.querySelector('.installed-plugin-configuration input');
        const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
        set.call(field,${JSON.stringify(input.value)});
        field.dispatchEvent(new Event('input',{bubbles:true}));
        field.dispatchEvent(new Event('change',{bubbles:true}));
      })()`);
      await click("保存参数", ".installed-plugin-configuration");
      await waitFor(
        "document.querySelector('.installed-plugin-configuration')?.textContent.includes('业务配置已保存')",
        "actual PUT accepted",
      );
    } else {
      await waitFor(
        `document.querySelector('.installed-plugin-configuration input')?.value===${JSON.stringify(input.value)}`,
        "cold browser reads saved PostgreSQL configuration",
      );
    }
    await capture("configuration-web-" + input.phase + ".png");
    const responsiveLayouts =
      input.phase === "write" ? await checkResizedSettings() : [];
    await click("返回", ".settings-sidebar");
    await waitFor(
      "document.querySelector('.sidebar-account summary')!==null",
      "original shell restored",
    );
    await settings();
    await click("业务配置", ".installed-plugin-settings");
    await waitFor(
      `document.querySelector('.installed-plugin-configuration input')?.value===${JSON.stringify(input.value)}`,
      "closed settings remount reads persisted values",
    );
    assert.equal(
      await evaluate<boolean>(
        "typeof window.require==='undefined'&&typeof window.crewonDesktop==='undefined'",
      ),
      true,
    );
    const styles = await evaluate<Record<string, string>>(`(()=>{
      const win=document.querySelector('.settings-command-window');
      const rail=document.querySelector('.settings-sidebar');
      const panel=document.querySelector('.installed-plugin-configuration');
      const card=document.querySelector('.installed-plugin-card');
      const header=document.querySelector('.installed-plugin-settings>header');
      return {windowDisplay:getComputedStyle(win).display,railDisplay:getComputedStyle(rail).display,
        windowWidth:String(win.getBoundingClientRect().width),font:getComputedStyle(rail).fontFamily,
        panelDisplay:getComputedStyle(panel).display,panelGap:getComputedStyle(panel).gap,
        cardPadding:getComputedStyle(card).padding,cardBorder:getComputedStyle(card).borderTopStyle,
        cardBorderWidth:getComputedStyle(card).borderTopWidth,headerDisplay:getComputedStyle(header).display,
        productionStyleArtifacts:Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(e=>new URL(e.href).pathname).join(',')};
    })()`);
    assert.equal(styles.windowDisplay, "grid");
    assert.equal(styles.panelDisplay, "grid");
    assert.equal(styles.panelGap, "14px");
    assert.equal(styles.cardPadding, "18px");
    assert.equal(styles.cardBorder, "solid");
    assert.equal(styles.cardBorderWidth, "1px");
    assert.equal(styles.headerDisplay, "flex");
    assert.match(styles.productionStyleArtifacts!, /CommandSettingsRoute-/u);
    const proof = {
      acceptance: "named-production-PG-Web-settings-route",
      phase: input.phase,
      electron: process.versions.electron,
      nativeBridge: false,
      originalAccountMenu: true,
      originalSettingsNavigation: originalNavigation,
      actualInstalledConfigurationPanel: true,
      settingsRemountRead: true,
      originalShellStyles,
      styles,
      responsiveLayouts,
    };
    writeFileSync(
      join(input.evidenceDirectory, "browser-" + input.phase + "-proof.json"),
      JSON.stringify(proof, null, 2) + "\n",
    );
    process.stdout.write(
      "CREWON_CONFIGURATION_UI_PROOF:" + JSON.stringify(proof) + "\n",
    );
    window.destroy();
    app.exit(0);
  } catch (error) {
    process.stderr.write(String(error) + "\n");
    window?.destroy();
    app.exit(1);
  }
});
