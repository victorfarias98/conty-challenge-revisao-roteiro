export const BRAND_TIME_ZONE = "America/Sao_Paulo";

// en-CA formata como YYYY-MM-DD, o mesmo formato em que o prazo é gravado.
const BRAND_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: BRAND_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function brandDay(instant: Date): string {
  return BRAND_DAY.format(instant);
}

export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// O prazo é o dia inteiro no fuso da marca: só passa quando o dia da marca já é outro.
export function isDeadlinePassed(now: Date, dueDate: string): boolean {
  return brandDay(now) > dueDate;
}
