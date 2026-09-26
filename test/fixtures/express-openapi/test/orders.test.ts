import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../src/index.js";

describe("orders", () => {
  it("requires a token", async () => {
    const res = await request(app).get("/orders");
    expect(res.status).toBe(401);
  });
});
