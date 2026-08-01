export type CapabilityPanelItem = {
  label: string;
  path?: string;
  kind?: "directory" | "file";
  intent?: "attach-context";
  action?:
    | {
        type: "app";
        appId: string;
        appName: string;
      }
    | {
        type: "plugin";
        pluginName: string;
        marketplacePath?: string | null;
        remoteMarketplaceName?: string | null;
      }
    | {
        type: "background-terminal";
        threadId: string;
        processId: string;
      };
};

export type CapabilityPanelAction = {
  id: string;
  label: string;
  tone?: "primary" | "danger";
};

export type CapabilityPanelField = {
  commitOnChange?: boolean;
  description?: string;
  id: string;
  multiline?: boolean;
  label: string;
  options?: Array<{ label: string; value: string }>;
  placeholder?: string;
  rows?: number;
  secret?: boolean;
  value: string;
};

export type CapabilityPanel = {
  title: string;
  subtitle?: string;
  actions?: CapabilityPanelAction[];
  body?: string;
  commandInput?: boolean;
  fields?: CapabilityPanelField[];
  items?: CapabilityPanelItem[];
  error?: string;
};
