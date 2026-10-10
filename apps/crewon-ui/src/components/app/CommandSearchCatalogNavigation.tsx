import type { Locale } from "../../lib/i18n";
import type { ThreadCatalogNavigation } from "../../lib/thread/threadCatalogNavigation";
import "../ThreadCatalogPager.css";

/** The catalog replaces each result page; navigation never claims to append it. */
export function CommandSearchCatalogNavigation({
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
        ? "读取失败，请重试"
        : "Could not load. Try again."
      : navigation.empty && (navigation.hasOlder || navigation.hasNewer)
        ? zh
          ? "本页暂无结果，可以翻页查看"
          : "No results on this page. Browse another page."
        : null;
  if (status === null && !navigation.hasOlder && !navigation.hasNewer)
    return null;
  return (
    <div className="thread-catalog-pager" data-command-search-pages="">
      {status !== null ? (
        <p role="status" aria-live="polite">
          {status}
        </p>
      ) : null}
      {navigation.hasNewer || navigation.hasOlder || navigation.failed ? (
        <nav aria-label={zh ? "搜索结果分页" : "Search result pages"}>
          {navigation.hasNewer ? (
            <button
              type="button"
              disabled={navigation.loading}
              onClick={navigation.onNewer}
            >
              {zh ? "上一页" : "Previous page"}
            </button>
          ) : null}
          {navigation.failed ? (
            <button
              type="button"
              disabled={navigation.loading}
              onClick={navigation.onRefresh}
            >
              {zh ? "重试" : "Retry"}
            </button>
          ) : null}
          {navigation.hasOlder ? (
            <button
              type="button"
              disabled={navigation.loading}
              onClick={navigation.onOlder}
            >
              {zh ? "下一页" : "Next page"}
            </button>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
