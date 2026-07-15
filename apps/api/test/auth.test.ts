import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, registerUser } from "./helpers.js";

describe("POST /api/v1/auth/register", () => {
  it("creates a user and returns a token + safe-user envelope", async () => {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({
        firstName: "Ada",
        lastName: "Lovelace",
        phoneNumber: "+12025550100",
        email: "ada@test.local",
        password: "Test1234",
      })
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toEqual(expect.any(String));
    expect(res.body.data.user).toMatchObject({
      email: "ada@test.local",
      firstName: "Ada",
      lastName: "Lovelace",
    });
    expect(res.body.data.user).not.toHaveProperty("passwordHash");
  });

  it("rejects a duplicate email with 409", async () => {
    await registerUser({ email: "dupe@test.local" });

    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({
        firstName: "X",
        lastName: "Y",
        phoneNumber: "+12025559001",
        email: "dupe@test.local",
        password: "Test1234",
      })
      .expect(409);

    expect(res.body).toEqual({
      success: false,
      error: expect.objectContaining({ code: "CONFLICT" }),
    });
  });

  it("rejects a duplicate phone number with 409", async () => {
    await registerUser({ phoneNumber: "+12025550123" });

    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({
        firstName: "X",
        lastName: "Y",
        phoneNumber: "+12025550123",
        email: "other@test.local",
        password: "Test1234",
      })
      .expect(409);

    expect(res.body).toEqual({
      success: false,
      error: expect.objectContaining({ code: "CONFLICT" }),
    });
  });
});

describe("POST /api/v1/auth/login", () => {
  it("logs in with correct credentials", async () => {
    await registerUser({ email: "login@test.local", password: "Test1234" });

    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "login@test.local", password: "Test1234" })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toEqual(expect.any(String));
  });

  it("rejects a wrong password with 401", async () => {
    await registerUser({ email: "wrongpw@test.local", password: "Test1234" });

    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "wrongpw@test.local", password: "Wrong9999" })
      .expect(401);

    expect(res.body).toEqual({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Unauthorized User" },
    });
  });

  it("rejects an unknown email with the SAME 401 envelope (no user enumeration)", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "nobody@test.local", password: "Test1234" })
      .expect(401);

    // Byte-identical shape to the wrong-password case above.
    expect(res.body).toEqual({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Unauthorized User" },
    });
  });
});
