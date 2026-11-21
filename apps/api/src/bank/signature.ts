import crypto from "node:crypto";

export function getSignatureHeader(data: {
  secret: string;
  body: string;
  now: number;
  method: string;
  path: string;
}): string {
  const { secret, body, now, method, path } = data;
  const signedPayload = `${now}.${method}${path}.${body}`;

  const v1 = crypto
    .createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");

  const xSignatureHeader = `t=${now},v1=${v1}`;
  return xSignatureHeader;
}
