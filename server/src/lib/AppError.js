/**
 * Expected, user-facing failure. Services throw this; the central error handler
 * turns it into the standard envelope. Anything else is treated as a bug (500).
 */
export class AppError extends Error {
  constructor(code, status, message, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}