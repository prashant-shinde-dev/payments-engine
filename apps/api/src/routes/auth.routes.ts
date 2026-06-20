import express, { Request, Response } from "express";
import { login, register } from "../services/auth.service.js";
import { loginSchema, registerSchema } from "@payments/zod-schemas";
import { validate } from "../middleware/validation.js";
import { ApiResponse } from "@payments/types";

export const router = express.Router();

router.post("/login", async (req: Request, res: Response) => {
  const data = validate(loginSchema, req.body);
  const result = await login(data);
  res
    .status(200)
    .json({ success: true, data: result } satisfies ApiResponse<typeof result>);
});

router.post("/register", async (req: Request, res: Response) => {
  const data = validate(registerSchema, req.body);
  const result = await register(data);
  res
    .status(201)
    .json({ success: true, data: result } satisfies ApiResponse<typeof result>);
});
