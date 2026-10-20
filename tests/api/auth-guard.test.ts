import request from "supertest";
import app from "../../src/app";

const protectedGets = [
  "/me",
  "/me/notifications",
  "/dashboard",
  "/insights/me",
  "/progression/me",
  "/chat/conversations",
  "/reports/attendance",
];

describe("protected routes reject anonymous users", () => {
  it.each(protectedGets)("GET %s returns 401 without a token", async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(401);
  });

  it("PATCH /me returns 401 without a token", async () => {
    const res = await request(app).patch("/me").send({ full_name: "Maha Hafeez" });
    expect(res.status).toBe(401);
  });

  it("rejects a fake token", async () => {
    const res = await request(app)
      .get("/me")
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });
});
