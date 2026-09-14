import type { ThreadCatalogNavigation } from "../lib/thread/threadCatalogNavigation";
import type { Locale } from "../lib/i18n";
import "./ThreadCatalogPager.css";

export function ThreadCatalogPager({
  navigation,
  locale,
}: {
  navigation: ThreadCatalogNavigation;
  locale: Locale;
}) {
  const zh = locale === "zh";
  const status = navigation.loading
    ? zh
      ? "正在读取会话…"
      : "Loading conversations…"
    : navigation.failed
      ? zh
        ? "读取失败，可刷新重试"
        : "Could not load. Refresh to retry."
      : navigation.empty && navigation.hasOlder
        ? zh
          ? "本页没有会话，可以继续查找"
          : "No conversations on this page. Continue browsing."
        : null;
  return (
    <div className="thread-catalog-pager">
      {status !== null && (
        <p role="status" aria-live="polite">
          {status}
        </p>
      )}
      <nav aria-label={zh ? "会话分页" : "Conversation pages"}>
        <button
          type="button"
          disabled={navigation.loading || !navigation.hasNewer}
          onClick={navigation.onNewer}
        >
          {zh ? "较新" : "Newer"}
        </button>
        <button
          type="button"
          disabled={navigation.loading}
          onClick={navigation.onRefresh}
          aria-label={
            zh ? "刷新并回到最新会话" : "Refresh latest conversations"
          }
        >
          {zh ? "最新" : "Latest"}
        </button>
        <button
          type="button"
          disabled={navigation.loading || !navigation.hasOlder}
          onClick={navigation.onOlder}
        >
          {navigation.searching && navigation.empty
            ? zh
              ? "继续查找"
              : "Continue search"
            : zh
              ? "较早"
              : "Older"}
        </button>
      </nav>
    </div>
  );
}
