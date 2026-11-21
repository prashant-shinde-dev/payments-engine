import { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import crypto from "node:crypto";
import { UnauthorizedError, ValidationError } from "../errors/index.js";

const SIGNATURE_REGEX = /^t=(?<t>\d{1,12}),v1=(?<v1>[0-9a-f]{64})$/;

function authFailed(): never {
  throw new UnauthorizedError(
    "Signature Verification Failed",
    "AUTHENTICATION_FAILED",
  );
}

function parseBody(body: Buffer): unknown {
  try {
    const reqbody = JSON.parse(body.toString("utf8"));
    return reqbody;
  } catch (error) {
    throw new ValidationError("callback body is not valid JSON", error);
  }
}
// The string both sides sign (contract §2.2). One definition, so signer and verifier cannot drift.
function signedPrefix(t: number | string, method: string, path: string): string {
  return `${t}.${method}${path}.`;
}

export function getSignatureHeader(data: {
  secret: string;
  body: string;
  now: number;
  method: string;
  path: string;
}): string {
  const { secret, body, now, method, path } = data;
  const signedPayload = signedPrefix(now, method, path) + body;

  const v1 = crypto
    .createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");

  const xSignatureHeader = `t=${now},v1=${v1}`;
  return xSignatureHeader;
}

export function verifyWebhookPayload(data: {
  secret: string;
  header: string | undefined;
  rawBody: unknown;
  now: number;
  method: string;
  path: string;
}): Buffer {
  const { secret, header, rawBody, now, method, path } = data;
  const { t, v1 } = SIGNATURE_REGEX.exec(header ?? "")?.groups ?? {};
  if (!t || !v1) {
    authFailed();
  }

  const body = rawBody ?? Buffer.alloc(0);

  if (!Buffer.isBuffer(body)) {
    authFailed();
  }

  if (Math.abs(now - parseInt(t)) > 300) {
    throw new UnauthorizedError(
      "Signature Verification Failed",
      "SIGNATURE_EXPIRED",
    );
  }

  const computedHash = crypto
    .createHmac("sha256", secret)
    .update(signedPrefix(t, method, path))
    .update(body)
    .digest();

  const isMatch = crypto.timingSafeEqual(Buffer.from(v1, "hex"), computedHash);

  if (!isMatch) {
    authFailed();
  }
  return body;
}

export function verifyBankSignature(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const header = req.get("X-Signature");
  const now = Math.floor(Date.now() / 1000);
  const body = verifyWebhookPayload({
    secret: config.hmacB2ESecretKey,
    header,
    rawBody: req.body,
    now,
    method: req.method,
    path: req.originalUrl,
  });
  if (body.byteLength) {
    req.body = parseBody(body);
  }
  next();
}
