import type { NextFunction, Request, Response } from "express";
import crypto from "node:crypto";
import { AuthenticationError, ValidationError } from "../errors/index.js";
import { config } from "../config.js";

const SIGNATURE_REGEX = /^t=(?<t>\d{1,12}),v1=(?<v1>[0-9a-f]{64})$/;
function authFailed(): never {
  throw new AuthenticationError(
    "AUTHENTICATION_FAILED",
    "Signature verification failed",
  );
}

function createSignedPayload(
  t: number,
  body: string,
  method: string,
  path: string,
): string {
  return `${t}.${method}${path}.${body}`;
}
export function getSignatureHeader(data: {
  secret: string;
  payload: string;
  now: number;
  method: string;
  path: string;
}): string {
  const { secret, payload, now, method, path } = data;

  const v1 = crypto
    .createHmac("sha256", secret)
    .update(createSignedPayload(now, payload, method, path))
    .digest("hex");

  const xSignatureHeader = `t=${now},v1=${v1}`;
  return xSignatureHeader;
}

export function verify(data: {
  secret: string;
  header: string | undefined;
  payload: unknown;
  now: number;
  method: string;
  path: string;
}): Buffer {
  const { secret, header, payload, now, method, path } = data;

  if (!header) {
    authFailed();
  }

  const body = payload ?? Buffer.alloc(0);

  if (!Buffer.isBuffer(body)) {
    authFailed();
  }
  const { t, v1 } = SIGNATURE_REGEX.exec(header ?? "")?.groups ?? {};
  if (!t || !v1) {
    authFailed();
  }
  const time = Math.abs(now - parseInt(t));
  if (time > 300) {
    throw new AuthenticationError(
      "SIGNATURE_EXPIRED",
      "Signature verification failed",
    );
  }

  const computedHash = crypto
    .createHmac("sha256", secret)
    .update(createSignedPayload(Number(t), "", method, path))
    .update(body)
    .digest();

  const isMatch = crypto.timingSafeEqual(Buffer.from(v1, "hex"), computedHash);
  if (!isMatch) {
    authFailed();
  }
  return body;
}

export function verifySignature(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const header = req.get("x-signature");
  const secret = config.engineToBankSecret;
  const now = Math.floor(Date.now() / 1000);
  const payload = verify({
    secret,
    header,
    payload: req.body,
    now,
    method: req.method,
    path: req.originalUrl,
  });
  if (payload.byteLength) {
    try {
      req.body = JSON.parse(payload.toString("utf8"));
    } catch (error) {
      throw new ValidationError("payload is not a valid JSON", error);
    }
  }
  next();
}
