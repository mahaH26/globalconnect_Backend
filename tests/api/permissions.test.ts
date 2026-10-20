import request from "supertest";
import app from "../../src/app";
import { resetDb, setResult } from "../helpers/supabaseMock";

jest.mock("../../src/config/supabase", () => require("../helpers/supabaseMock"));
jest.mock("../../src/middleware/auth", () => require("../helpers/mocks").authMock());
jest.mock("../../src/utils/settings", () => require("../helpers/mocks").settingsMock());
jest.mock("../../src/utils/notify", () => require("../helpers/mocks").notifyMock);

beforeEach(() => resetDb());

describe("role permissions", () => {
  it("employee cannot list all attendance", async () => {
    const res = await request(app).get("/attendance").set("x-test-role", "employee");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Admins only");
  });

  it("employee cannot list all leave requests", async () => {
    const res = await request(app).get("/leave").set("x-test-role", "employee");
    expect(res.status).toBe(403);
  });

  it("employee cannot approve a leave request", async () => {
    const res = await request(app)
      .patch("/leave/l1/review")
      .set("x-test-role", "employee")
      .send({ status: "approved" });
    expect(res.status).toBe(403);
  });

  it("employee cannot read another user's leave balance", async () => {
    const res = await request(app).get("/leave/balance/someone").set("x-test-role", "employee");
    expect(res.status).toBe(403);
  });

  it("admin can list all attendance", async () => {
    setResult("attendance:select", []);
    const res = await request(app).get("/attendance").set("x-test-role", "admin");
    expect(res.status).toBe(200);
  });

  it("anonymous user gets 401 on attendance and leave", async () => {
    expect((await request(app).get("/attendance")).status).toBe(401);
    expect((await request(app).post("/leave").send({})).status).toBe(401);
  });
});
