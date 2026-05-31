export type ApiResponse<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string } };

export interface AuthUser {
  userId: string;
  email: string;
}
