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
  if (!navigation.loading && !navigation.failed) return null;
  const status = navigation.loading
    ? zh
      ? "正在读取会话…"
      : "Loading conversations…"
    : navigation.failed
      ? zh
        ? "读取会话失败，请重试。"
        : "Could not load conversations. Please retry."
      : null;
  return (
    <div className="thread-catalog-pager">
      {status !== null && (
        <p role="status" aria-live="polite">
          {status}
        </p>
      )}
      {navigation.failed && !navigation.loading ? (
        <button type="button" onClick={navigation.onRefresh}>
          {zh ? "重试" : "Retry"}
        </button>
      ) : null}
    </div>
  );
}
