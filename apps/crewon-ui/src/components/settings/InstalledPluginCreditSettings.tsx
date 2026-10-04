import type {
  PluginCreditAccountView,
  PluginCreditEntryView,
} from "@crewon/contracts";
import type { Locale } from "../../lib/i18n";
import {
  usePluginCreditAccounts,
  type PluginCreditClient,
} from "../../lib/plugins/usePluginCreditAccounts";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import "./InstalledPluginSettings.css";

export function InstalledPluginCreditSettings({
  client,
  ownerKey,
  locale,
  accountSource = "currentUser",
}: Readonly<{
  client: PluginCreditClient;
  ownerKey: string;
  locale: Locale;
  accountSource?: "currentUser" | "localDevice";
}>) {
  const state = usePluginCreditAccounts({ client, ownerKey });
  const zh = locale === "zh";
  const accountsBusy = state.status === "loading" || !state.available;
  const entriesBusy = state.entriesStatus === "loading";
  const title =
    accountSource === "localDevice"
      ? zh
        ? "本机插件积分"
        : "Local device plugin credits"
      : zh
        ? "个人插件积分"
        : "Personal plugin credits";
  return (
    <section className="installed-plugin-settings" aria-label={title}>
      <header>
        <div>
          <h2>{title}</h2>
          <p>
            {accountSource === "localDevice"
              ? zh
                ? "查看本机的插件积分账户与流水。登录账号的个人积分尚未接通。"
                : "View this device's plugin credit accounts and entries. Personal credits for your signed-in account are not connected yet."
              : zh
                ? "查看当前账号的独立积分账户与流水。"
                : "View independent credit accounts and entries for your current account."}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={accountsBusy}
          onClick={state.refresh}
        >
          {zh ? "刷新积分" : "Refresh credits"}
        </Button>
      </header>
      <CreditReadState status={state.status} locale={locale} />
      {state.status === "ready" &&
        state.accounts &&
        (state.accounts.accounts.length === 0 ? (
          <>
            <p>
              {zh
                ? "尚未建立插件积分账户。"
                : "No plugin credit account has been created."}
            </p>
            <CreditPages
              locale={locale}
              label={zh ? "积分账户" : "Credit accounts"}
              page={state.accountsPage}
              next={state.accounts.nextPoolId !== null}
              disabled={accountsBusy}
              onFirst={state.firstAccounts}
              onNext={state.nextAccounts}
            />
          </>
        ) : (
          <>
            <Select
              value={state.selectedPoolId ?? ""}
              onValueChange={state.selectPool}
              disabled={accountsBusy}
            >
              <SelectTrigger
                className="w-full"
                aria-label={zh ? "选择积分账户" : "Choose a credit account"}
              >
                <SelectValue
                  placeholder={zh ? "选择积分账户" : "Choose a credit account"}
                />
              </SelectTrigger>
              <SelectContent>
                {state.accounts.accounts.map((account) => (
                  <SelectItem key={account.poolId} value={account.poolId}>
                    {account.poolId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <CreditPages
              locale={locale}
              label={zh ? "积分账户" : "Credit accounts"}
              page={state.accountsPage}
              next={state.accounts.nextPoolId !== null}
              disabled={accountsBusy}
              onFirst={state.firstAccounts}
              onNext={state.nextAccounts}
            />
            {state.selectedPoolId === null && (
              <p>
                {zh
                  ? "选择账户后查看余额与流水。"
                  : "Choose an account to view its balance and entries."}
              </p>
            )}
          </>
        ))}
      {state.selectedPoolId !== null && (
        <section
          aria-label={zh ? "积分余额与流水" : "Credit balance and entries"}
        >
          <CreditReadState status={state.entriesStatus} locale={locale} />
          {state.entriesStatus === "ready" &&
            state.entries &&
            (state.entries.account === null ? (
              <p>
                {zh
                  ? "此插件积分账户尚未建立，请刷新账户列表。"
                  : "This plugin credit account has not been created. Refresh the account list."}
              </p>
            ) : (
              <>
                <article
                  className="installed-plugin-card"
                  aria-label={
                    zh
                      ? "当前独立积分余额"
                      : "Current independent credit balance"
                  }
                >
                  <header>
                    <h3>{state.entries.account.poolId}</h3>
                    <span>
                      {zh
                        ? `修订 ${state.entries.account.revision}`
                        : `Revision ${state.entries.account.revision}`}
                    </span>
                  </header>
                  <CreditBalance
                    account={state.entries.account}
                    locale={locale}
                  />
                </article>
                <h3>{zh ? "积分流水" : "Credit entries"}</h3>
                {state.entries.entries.length === 0 && (
                  <p>
                    {zh
                      ? "本页暂无积分流水。"
                      : "No credit entries on this page."}
                  </p>
                )}
                {state.entries.entries.map((entry) => (
                  <article
                    className="installed-plugin-card"
                    key={entry.revision}
                    aria-label={
                      zh
                        ? `积分流水修订 ${entry.revision}`
                        : `Credit entry revision ${entry.revision}`
                    }
                  >
                    <header>
                      <h4>{entryKind(entry.kind, zh)}</h4>
                      <span>
                        {zh
                          ? `修订 ${entry.revision}`
                          : `Revision ${entry.revision}`}
                      </span>
                    </header>
                    <p>
                      {zh ? "积分：" : "Credits: "}
                      <strong>{entry.credits}</strong>
                    </p>
                    <details>
                      <summary>
                        {zh
                          ? "该修订后的历史余额"
                          : "Historical balance after this revision"}
                      </summary>
                      <CreditBalance account={entry.account} locale={locale} />
                    </details>
                  </article>
                ))}
                <CreditPages
                  locale={locale}
                  label={zh ? "积分流水" : "Credit entries"}
                  page={state.entriesPage}
                  next={state.entries.nextRevision !== null}
                  disabled={entriesBusy}
                  onFirst={state.firstEntries}
                  onNext={state.nextEntries}
                />
              </>
            ))}
        </section>
      )}
    </section>
  );
}

function CreditBalance({
  account,
  locale,
}: {
  account: PluginCreditAccountView;
  locale: Locale;
}) {
  const zh = locale === "zh";
  return (
    <div>
      <p>
        {zh ? "可用：" : "Available: "}
        <strong>{account.availableCredits}</strong>
      </p>
      <p>
        {zh ? "预留：" : "Reserved: "}
        <strong>{account.reservedCredits}</strong>
      </p>
      <p>
        {zh ? "已消耗：" : "Spent: "}
        <strong>{account.spentCredits}</strong>
      </p>
      <p>
        {zh ? "累计入账：" : "Granted: "}
        <strong>{account.grantedCredits}</strong>
      </p>
    </div>
  );
}

function CreditReadState({
  status,
  locale,
}: {
  status: ReturnType<typeof usePluginCreditAccounts>["entriesStatus"];
  locale: Locale;
}) {
  const zh = locale === "zh";
  switch (status) {
    case "loading":
      return (
        <p role="status">
          {zh ? "正在读取独立积分…" : "Loading independent credits…"}
        </p>
      );
    case "unconfigured":
      return (
        <p>
          {zh
            ? "独立积分尚未接通。"
            : "Independent credits are not connected yet."}
        </p>
      );
    case "forbidden":
      return (
        <p role="alert">
          {zh
            ? "无权读取插件积分。"
            : "Your account cannot read independent credits."}
        </p>
      );
    case "unavailable":
      return (
        <p role="alert">
          {zh
            ? "独立积分服务暂不可用，请稍后刷新。"
            : "The independent credit service is unavailable. Refresh later."}
        </p>
      );
    case "error":
      return (
        <p role="alert">
          {zh
            ? "读取独立积分失败，请重新刷新。"
            : "Could not read independent credits. Refresh to try again."}
        </p>
      );
    case "withdrawn":
      return (
        <p role="alert">
          {zh
            ? "账号已变化，请重新打开插件设置。"
            : "Your account changed. Reopen plugin settings."}
        </p>
      );
    default:
      return null;
  }
}

function entryKind(kind: PluginCreditEntryView["kind"], zh: boolean): string {
  switch (kind) {
    case "grant":
      return zh ? "入账" : "Grant";
    case "reserve":
      return zh ? "预留" : "Reserve";
    case "settle":
      return zh ? "结算" : "Settle";
    case "release":
      return zh ? "解除预留" : "Release";
  }
}

function CreditPages({
  locale,
  label,
  page,
  next,
  disabled,
  onFirst,
  onNext,
}: {
  locale: Locale;
  label: string;
  page: number;
  next: boolean;
  disabled: boolean;
  onFirst(): void;
  onNext(): void;
}) {
  if (page === 1 && !next) return null;
  const zh = locale === "zh";
  return (
    <div
      className="installed-plugin-actions"
      aria-label={zh ? `${label}分页` : `${label} pages`}
    >
      <Button
        type="button"
        variant="outline"
        disabled={disabled || page === 1}
        onClick={onFirst}
      >
        {zh ? "首页" : "First page"}
      </Button>
      <span>{zh ? `第 ${page} 页` : `Page ${page}`}</span>
      <Button
        type="button"
        variant="outline"
        disabled={disabled || !next}
        onClick={onNext}
      >
        {zh ? "下一页" : "Next page"}
      </Button>
    </div>
  );
}
