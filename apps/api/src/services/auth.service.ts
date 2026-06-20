import { config } from "../config.js";
import { RegisterInputs, LoginInputs } from "@payments/zod-schemas";
import { SafeUser } from "@payments/types";
import { Prisma, prisma } from "@payments/db/client";
import bcrypt from "bcrypt";
import { ConflictError, UnauthorizedError } from "../errors/index.js";
import jwt from "jsonwebtoken";

type AuthPayload = { user: SafeUser; token: string };
const DECOY_HASH = bcrypt.hashSync("decoy-not-a-real-password", 12);

export async function login(data: LoginInputs): Promise<AuthPayload> {
  const user = await prisma.user.findUnique({ where: { email: data.email } });
  const hash = user?.passwordHash ?? DECOY_HASH;
  const checkPassword = await bcrypt.compare(data.password, hash);
  if (!user || !checkPassword) {
    throw new UnauthorizedError("Unauthorized User");
  }
  return buildAuthPayload(user);
}

export async function register(data: RegisterInputs): Promise<AuthPayload> {
  const passwordHash = await bcrypt.hash(data.password, 12);
  const { password: _password, ...rest } = data;
  const userInputs = { ...rest, passwordHash };

  try {
    const user = await prisma.$transaction(async (txn) => {
      const created = await txn.user.create({ data: userInputs });

      await txn.wallet.create({
        data: {
          userId: created.id,
          balance: 0,
        },
      });
      return created;
    });
    return buildAuthPayload(user);
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      throw new ConflictError(
        "An account with this email or phone already exists",
      );
    }
    throw e;
  }
}

function buildAuthPayload(user: {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  createdAt: Date;
}): AuthPayload {
  const payload = { userId: user.id, email: user.email };
  const token = jwt.sign(payload, config.jwtSecret, { expiresIn: "15m" });
  const { id, email, firstName, lastName, createdAt } = user;
  const safeUser: SafeUser = { id, email, firstName, lastName, createdAt };
  return { user: safeUser, token };
}
