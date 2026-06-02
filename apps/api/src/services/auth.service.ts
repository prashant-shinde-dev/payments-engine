import { config } from "../config.js";
import { RegisterInputs, LoginInputs } from "@payments/zod-schemas";
import { SafeUser, ApiResponse } from "@payments/types";
import { prisma } from "@payments/db/client";
import bcrypt from "bcrypt";
import { ConflictError, UnauthorizedError } from "../errors/index.js";
import jwt from "jsonwebtoken";

export async function login(
  data: LoginInputs,
): Promise<ApiResponse<{ user: SafeUser; token: string }>> {
  const user = await prisma.user.findUnique({ where: { email: data.email } });
  if (!user) {
    throw new UnauthorizedError("Unauthorized User");
  }

  const checkPassword = await bcrypt.compare(data.password, user.passwordHash);

  if (!checkPassword) {
    throw new UnauthorizedError("Unauthorized User");
  }
  return buildAuthResponse(user);
}

export async function register(
  data: RegisterInputs,
): Promise<ApiResponse<{ user: SafeUser; token: string }>> {
  const [existingEmail, existingPhoneNumber] = await Promise.all([
    prisma.user.findUnique({ where: { email: data.email } }),
    prisma.user.findUnique({ where: { phoneNumber: data.phoneNumber } }),
  ]);
  if (existingEmail || existingPhoneNumber) {
    throw new ConflictError(
      "An account with this email or phone already exists",
    );
  }

  const passwordHash = await bcrypt.hash(data.password, 12);
  const { password: _password, ...rest } = data;
  const userInputs = { ...rest, passwordHash };

  const user = await prisma.$transaction(async (txn) => {
    const user = await txn.user.create({ data: userInputs });

    await txn.wallet.create({
      data: {
        userId: user.id,
        balance: 0,
      },
    });
    return user;
  });

  return buildAuthResponse(user);
}

function buildAuthResponse(user: {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  createdAt: Date;
}): ApiResponse<{ user: SafeUser; token: string }> {
  const payload = { userId: user.id, email: user.email };
  const token = jwt.sign(payload, config.jwtSecret, { expiresIn: "15m" });
  const { id, email, firstName, lastName, createdAt } = user;
  const safeUser: SafeUser = { id, email, firstName, lastName, createdAt };
  const apiResponse: ApiResponse<{ user: SafeUser; token: string }> = {
    success: true,
    data: { user: safeUser, token },
  };
  return apiResponse;
}
