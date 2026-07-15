import request from "supertest";
import { randomUUID } from "node:crypto";
import { prisma } from "@payments/db/client";
import { createApp } from "../src/app.js";
import type { SafeUser } from "@payments/types";

/**
 * One shared in-process app for the whole suite. Supertest drives it directly —
 * no port is ever bound.
 */
export const app = createApp();

export interface RegisteredUser {
  user: SafeUser;
  token: string;
  password: string;
}

let phoneCounter = 1;

/**
 * Registers a user through the PUBLIC API — the same path a real client takes —
 * so tests exercise routing, validation, and the service together. Overrides let
 * a test pin an email/phone it wants to collide on; everything else is unique.
 */
export async function registerUser(
  overrides: Partial<{
    firstName: string;
    lastName: string;
    phoneNumber: string;
    email: string;
    password: string;
  }> = {},
): Promise<RegisteredUser> {
  const password = overrides.password ?? "Test1234";
  const body = {
    firstName: overrides.firstName ?? "Test",
    lastName: overrides.lastName ?? "User",
    phoneNumber:
      overrides.phoneNumber ?? `+31${String(phoneCounter++).padStart(10, "0")}`,
    email: overrides.email ?? `user-${randomUUID()}@test.local`,
    password,
  };

  const res = await request(app)
    .post("/api/v1/auth/register")
    .send(body)
    .expect(201);

  return {
    user: res.body.data.user as SafeUser,
    token: res.body.data.token as string,
    password,
  };
}

export function authHeader(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Direct DB write — the ONLY sanctioned one in the suite. There is no deposit
 * endpoint yet (it arrives with the async bank flow), so wallets are funded by
 * writing the balance straight to the row. `amount` is a decimal string to stay
 * off floating point.
 */
export async function fundWallet(
  userId: string,
  amount: string,
): Promise<void> {
  await prisma.wallet.update({
    where: { userId },
    data: { balance: amount },
  });
}
