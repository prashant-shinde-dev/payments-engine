import express, { NextFunction, Request, Response } from "express";
import { login, register } from "../services/auth.service.js";
import {
  LoginInputs,
  RegisterInputs,
  loginSchema,
  registerSchema,
} from "@payments/zod-schemas";
import { ValidationError } from "../errors/index.js";

export const router = express.Router();

router.post("/login", async (req: Request, res: Response) => {
  const response = loginSchema.safeParse(req.body);

  if (!response.success) {
    throw new ValidationError(response.error.message);
  }
  const data: LoginInputs = response.data;
  const apiResponse = await login(data);
  res.status(200).json(apiResponse);
});

router.post("/register", async (req: Request, res: Response) => {
  const response = registerSchema.safeParse(req.body);

  if (!response.success) {
    throw new ValidationError(response.error.message);
  }
  const data: RegisterInputs = response.data;
  const apiResponse = await register(data);
  res.status(201).json(apiResponse);
});
