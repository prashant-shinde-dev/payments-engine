import { config } from "../config.js";
import { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";

import { UnauthorizedError } from "../errors/index.js";
import { AuthUser } from "@payments/types";

export const authenticate: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const { authorization } = req.headers;

  if (!authorization || !authorization.startsWith("Bearer ")) {
    throw new UnauthorizedError("Invalid user please sign in again");
  }
  const token = authorization.split(" ")[1]!;

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as AuthUser;
    req.user = { userId: decoded.userId, email: decoded.email };

    next();
  } catch (error) {
    throw new UnauthorizedError(
      "Invalid or Expired token, please sign in again",
    );
  }
};
