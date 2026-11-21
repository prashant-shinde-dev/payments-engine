function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const config = {
  databaseUrl: requireEnv("DATABASE_URL"),
  webhookHost: requireEnv("WEBHOOK_HOST"),
  webhookUrl: requireEnv("WEBHOOK_URL"),
  engineToBankSecret: requireEnv("ENGINE_TO_BANK_SECRET"),
  bankToEngineSecret: requireEnv("BANK_TO_ENGINE_SECRET"),
};
