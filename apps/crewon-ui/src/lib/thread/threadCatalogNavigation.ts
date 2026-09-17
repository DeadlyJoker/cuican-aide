export type ThreadCatalogNavigation = Readonly<{
  loading: boolean;
  empty: boolean;
  searching: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  failed: boolean;
  onOlder: () => void;
  onNewer: () => void;
  onRefresh: () => void;
}>;
