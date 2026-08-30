type PanelField = {
  id: string;
  value: string;
};

export function panelFieldValue(
  panel: { fields?: PanelField[] } | null | undefined,
  fieldId: string,
  fallback = "",
): string {
  return panel?.fields?.find((field) => field.id === fieldId)?.value ?? fallback;
}

export function trimmedPanelFieldValue(
  panel: { fields?: PanelField[] } | null | undefined,
  fieldId: string,
  fallback = "",
): string {
  return panelFieldValue(panel, fieldId, fallback).trim();
}

export function panelHasField(
  panel: { fields?: PanelField[] } | null | undefined,
  fieldId: string,
): boolean {
  return Boolean(panel?.fields?.some((field) => field.id === fieldId));
}

export function patchPanelState<Panel extends object>(
  panel: Panel | null,
  patch: Partial<Panel>,
): Panel | null {
  return panel
    ? {
        ...panel,
        ...patch,
      }
    : panel;
}

export function updatePanelFieldValue<
  Panel extends object,
  Field extends PanelField = PanelField,
>(
  panel: (Panel & { fields?: Field[] }) | null,
  fieldId: string,
  value: string,
): (Panel & { fields?: Field[] }) | null {
  return panel?.fields
    ? ({
        ...panel,
        fields: panel.fields.map((field) =>
          field.id === fieldId ? { ...field, value } : field,
        ),
      } as Panel & { fields?: Field[] })
    : panel;
}
