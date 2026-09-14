/** C04 bounded calendar substitutions. C02 continues to receive concrete scalars. */
export type AutomationParameterBindings = Readonly<
  Record<string, "runDate" | "previousWeekStart" | "previousWeekEnd">
>;

export function parseAutomationParameterBindings(
  input: unknown,
): AutomationParameterBindings {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  ) {
    throw new Error("automation_parameter_bindings_invalid");
  }
  const entries = Object.entries(input);
  if (
    entries.length > 24 ||
    entries.some(
      ([key, value]) =>
        !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key) ||
        ["constructor", "prototype", "__proto__"].includes(key) ||
        !["runDate", "previousWeekStart", "previousWeekEnd"].includes(value),
    )
  )
    throw new Error("automation_parameter_bindings_invalid");
  return structuredClone(input) as AutomationParameterBindings;
}

export function resolveAutomationParameters(
  parameters: Readonly<Record<string, string | number | boolean>>,
  bindings: AutomationParameterBindings,
  scheduledFor: string,
  timezone: string,
): Record<string, string | number | boolean> {
  const parsed = parseAutomationParameterBindings(bindings);
  const match = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.exec(
    scheduledFor,
  );
  const instant = new Date(scheduledFor);
  if (
    !match ||
    !Number.isFinite(instant.getTime()) ||
    instant.toISOString().slice(0, 10) !== match[1]
  ) {
    throw new Error("automation_scheduled_for_invalid");
  }
  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US-u-ca-iso8601", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .formatToParts(instant)
        .map((part) => [part.type, part.value]),
    );
  } catch {
    throw new Error("automation_timezone_invalid");
  }
  const date = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  const isoDay = (days: number) => {
    const shifted = new Date(date);
    shifted.setUTCDate(shifted.getUTCDate() + days);
    return shifted.toISOString().slice(0, 10);
  };
  const values = {
    runDate: isoDay(0),
    previousWeekStart: isoDay(-mondayOffset - 7),
    previousWeekEnd: isoDay(-mondayOffset - 1),
  };
  return {
    ...parameters,
    ...Object.fromEntries(
      Object.entries(parsed).map(([key, rule]) => [key, values[rule]]),
    ),
  };
}
