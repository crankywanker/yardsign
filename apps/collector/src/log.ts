/**
 * Structured JSON logs. One line per call, always carrying the request id (or a
 * job id for cron and queue work) so a whole request can be grepped out of the stream.
 */
export type LogFields = Record<string, unknown>;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

function write(level: 'info' | 'warn' | 'error', base: LogFields, msg: string, fields?: LogFields): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...base, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function createLogger(base: LogFields): Logger {
  return {
    info: (msg, fields) => write('info', base, msg, fields),
    warn: (msg, fields) => write('warn', base, msg, fields),
    error: (msg, fields) => write('error', base, msg, fields),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}

export function requestId(req: Request): string {
  return req.headers.get('cf-ray') ?? crypto.randomUUID();
}

export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) return { error: err.message, stack: err.stack };
  return { error: String(err) };
}
