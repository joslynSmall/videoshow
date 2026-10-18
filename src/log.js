function write(stream, level, message, meta) {
  const entry = {
    time: new Date().toISOString(),
    level,
    event: message,
  };
  if (meta && typeof meta === "object") Object.assign(entry, meta);
  else if (meta !== undefined) entry.detail = meta;
  stream(JSON.stringify(entry));
}

export const log = {
  info: (message, meta) => write(console.log, "INFO", message, meta),
  warn: (message, meta) => write(console.warn, "WARN", message, meta),
  error: (message, meta) => write(console.error, "ERROR", message, meta),
};
