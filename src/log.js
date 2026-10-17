function write(stream, level, message, meta) {
  const line = `${new Date().toISOString()} ${level} ${message}`;
  if (meta === undefined) stream(line);
  else stream(line, meta);
}

export const log = {
  info: (message, meta) => write(console.log, "INFO", message, meta),
  warn: (message, meta) => write(console.warn, "WARN", message, meta),
  error: (message, meta) => write(console.error, "ERROR", message, meta),
};
