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

/**
 * Control shape for a settings field. `text` stays the default so existing
 * panels keep rendering unchanged; the rest let appearance settings expose real
 * controls instead of squeezing colors and sizes through text inputs.
 */
export type CapabilityFieldControl =
  | "color"
  | "number"
  | "segmented"
  | "slider"
  | "text"
  | "toggle";

export type CapabilityPanelField = {
  commitOnChange?: boolean;
  control?: CapabilityFieldControl;
  description?: string;
  id: string;
  max?: number;
  min?: number;
  multiline?: boolean;
  label: string;
  options?: Array<{ label: string; value: string }>;
  placeholder?: string;
  rows?: number;
  secret?: boolean;
  step?: number;
  unit?: string;
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
