import request from "supertest";
import app from "../../src/app";
import { notifyAdmins, notifyUser } from "../../src/utils/notify";
import { leaveDays } from "../helpers/mocks";
import { payloads, resetDb, setResult } from "../helpers/supabaseMock";

jest.mock("../../src/config/supabase", () => require("../helpers/supabaseMock"));
jest.mock("../../src/middleware/auth", () => require("../helpers/mocks").authMock());
jest.mock("../../src/utils/settings", () => require("../helpers/mocks").settingsMock());
jest.mock("../../src/utils/notify", () => require("../helpers/mocks").notifyMock);

const valid = {
  leave_type: "annual",
  start_date: "2026-11-01",
  end_date: "2026-11-03",
  reason: "Family visit",
};

const create = (body: any) =>
  request(app).post("/leave").set("x-test-role", "employee").send(body);

beforeEach(() => {
  resetDb();
  jest.clearAllMocks();
  leaveDays.value = 3;
  setResult("leave_policies:select", [{ leave_type: "annual", days_per_year: 10 }]);
  setResult("leave_requests:select", []);
  setResult("leave_requests:insert", { id: "l1", status: "pending" });
});

describe("create leave request", () => {
  it("rejects an unknown leave type", async () => {
    const res = await create({ ...valid, leave_type: "holiday" });
    expect(res.status).toBe(400);
  });

  it("rejects a bad date format", async () => {
    const res = await create({ ...valid, start_date: "01/11/2026" });
    expect(res.status).toBe(400);
  });

  it("rejects an end date before the start date", async () => {
    const res = await create({ ...valid, start_date: "2026-11-05", end_date: "2026-11-01" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/end_date/);
  });

  it("rejects dates that are all weekend days", async () => {
    leaveDays.value = 0;
    const res = await create(valid);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/weekend/);
  });

  it("rejects a request larger than the remaining balance", async () => {
    setResult("leave_policies:select", [{ leave_type: "annual", days_per_year: 2 }]);
    const res = await create(valid);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Not enough annual leave/);
  });

  it("accepts a valid request, stores 3 days and tells admins", async () => {
    const res = await create(valid);
    expect(res.status).toBe(201);
    expect(payloads["leave_requests:insert"].days).toBe(3);
    expect(payloads["leave_requests:insert"].user_id).toBe("user-maha");
    expect(notifyAdmins).toHaveBeenCalledWith(
      "Leave request received",
      expect.stringContaining("Maha Hafeez requested 3 day(s)"),
      "leave_request",
      "user-maha",
    );
  });
});

describe("review leave request", () => {
  const pending = {
    id: "l1",
    user_id: "user-other",
    status: "pending",
    leave_type: "annual",
    start_date: "2026-11-01",
    end_date: "2026-11-03",
  };

  const review = (body: any) =>
    request(app).patch("/leave/l1/review").set("x-test-role", "admin").send(body);

  beforeEach(() => {
    setResult("leave_requests:select", pending);
    setResult("leave_requests:update", { id: "l1", status: "approved" });
  });

  it("rejects an invalid status", async () => {
    const res = await review({ status: "maybe" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the request does not exist", async () => {
    setResult("leave_requests:select", null);
    const res = await review({ status: "approved" });
    expect(res.status).toBe(404);
  });

  it("returns 409 when it was already reviewed", async () => {
    setResult("leave_requests:select", { ...pending, status: "approved" });
    const res = await review({ status: "approved" });
    expect(res.status).toBe(409);
  });

  it("admin approves: records reviewer and notifies the employee", async () => {
    const res = await review({ status: "approved" });
    expect(res.status).toBe(200);
    expect(payloads["leave_requests:update"].status).toBe("approved");
    expect(payloads["leave_requests:update"].reviewed_by).toBe("user-maha");
    expect(notifyUser).toHaveBeenCalledWith(
      "user-other",
      "Leave request approved",
      expect.any(String),
      "leave_review",
    );
  });
});
