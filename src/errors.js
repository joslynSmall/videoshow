export class AppError extends Error {
  constructor(code, status, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.expose = options.expose ?? true;
    this.detail = options.detail;
  }
}
