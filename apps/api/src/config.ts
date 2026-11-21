function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export const config = {
  jwtSecret: requireEnv("JWT_SECRET"),
  hmacE2BSecretKey: requireEnv("ENGINE_TO_BANK_SECRET"),
  port: process.env.PORT || "3001",
  bankTransferUrl: requireEnv("BANK_TRANSFER_URL"),
  bankTransferHost: requireEnv("BANK_TRANSFER_HOST"),
};
