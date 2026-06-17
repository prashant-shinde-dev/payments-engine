export class AppError extends Error {
  code: string;
  statusCode: number;

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
  constructor(message: string) {
    super("NOT_FOUND", message, 404);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super("VALIDATION_ERROR", message, 400);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super("CONFLICT", message, 409);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string) {
    super("UNAUTHORIZED", message, 401);
  }
}

export class InsufficientFundsError extends AppError {
  constructor(message: string) {
    super("INSUFFICIENT_FUNDS", message, 402);
  }
}
