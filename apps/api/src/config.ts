function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export const config = {
  jwtSecret: requireEnv("JWT_SECRET"),
  port: process.env.PORT || "3001",
};
