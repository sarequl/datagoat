/**
 * Structured logs. Workers Observability indexes JSON fields, so log one object per line:
 *   log.info("job.finished", { job: "rollups.daily", ms: 42 })
 * Never log secrets, raw API keys, passwords, IPs or emails.
 */
type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { error: err.message, errorName: err.name };
  return { error: String(err) };
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};
