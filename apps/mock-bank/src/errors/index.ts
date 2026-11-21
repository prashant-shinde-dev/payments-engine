export class AppError extends Error {
  code: string;
  statusCode: number;
  details?: unknown;

  constructor(
    code: string,
    message: string,
    statusCode: number,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class NotFoundError extends AppError {
  constructor(code: string = "NOT_FOUND", message: string) {
    super(code, message, 404);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("INVALID_REQUEST", message, 400);
    this.details = details;
  }
}

export class ConflictError extends AppError {
  constructor(code = "CONFLICT", message: string, statusCode: number = 409) {
    super(code, message, statusCode);
  }
}

export class AuthenticationError extends AppError {
  constructor(code: string = "UNAUTHORIZED", message: string) {
    super(code, message, 401);
  }
}

export class InsufficientFundsError extends AppError {
  constructor(message: string) {
    super("INSUFFICIENT_FUNDS", message, 402);
  }
}
