import { AuthUser } from "@payments/types";
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
