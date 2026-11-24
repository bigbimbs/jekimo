import { CronExpressionParser } from "cron-parser";

export function nextCronDate(expression: string, timezone: string, after: Date): Date {
  // Five fields bound the minimum cadence to one minute; random H fields are not deterministic.
  if (expression.trim().split(/\s+/).length !== 5 || /[Hh@]/.test(expression))
    throw new RangeError("use a five-field cron expression");
  new Intl.DateTimeFormat("en", { timeZone: timezone }).format(after);
  return CronExpressionParser.parse(expression, { tz: timezone, currentDate: after }).next().toDate();
}
