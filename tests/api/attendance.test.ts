import request from "supertest";
import app from "../../src/app";
import { notifyAdmins, notifyUser } from "../../src/utils/notify";
import { clock } from "../helpers/mocks";
import { payloads, resetDb, setResult } from "../helpers/supabaseMock";

jest.mock("../../src/config/supabase", () => require("../helpers/supabaseMock"));
jest.mock("../../src/middleware/auth", () => require("../helpers/mocks").authMock());
jest.mock("../../src/utils/settings", () => require("../helpers/mocks").settingsMock());
jest.mock("../../src/utils/notify", () => require("../helpers/mocks").notifyMock);

const OFFICE = { latitude: 26.2285, longitude: 50.586, radius_m: 100 };
const AT_OFFICE = { latitude: 26.2285, longitude: 50.586 };
const FAR_AWAY = { latitude: 26.3, longitude: 50.7 };

const checkIn = (body: any) =>
  request(app).post("/attendance/check-in").set("x-test-role", "employee").send(body);
const checkOut = (body: any) =>
  request(app).post("/attendance/check-out").set("x-test-role", "employee").send(body);

beforeEach(() => {
  resetDb();
  jest.clearAllMocks();
  clock.minutes = 535;
  setResult("office_locations:select", [OFFICE]);
  setResult("attendance:insert", { id: "a1" });
  setResult("profiles:select", { attendance_points: 0 });
});

describe("check-in", () => {
  it("rejects a request without coordinates", async () => {
    const res = await checkIn({});
    expect(res.status).toBe(400);
  });

  it("08:55 is on time: status present, +1 point, no late alert", async () => {
    clock.minutes = 535;
    const res = await checkIn(AT_OFFICE);
    expect(res.status).toBe(201);
    expect(payloads["attendance:insert"].status).toBe("present");
    expect(payloads["attendance:insert"].points_awarded).toBe(1);
    expect(notifyAdmins).not.toHaveBeenCalled();
  });

  it("09:15 is inside the grace period: still on time", async () => {
    clock.minutes = 555;
    await checkIn(AT_OFFICE);
    expect(payloads["attendance:insert"].status).toBe("present");
  });

  it("09:30 is late: status late, penalty points, admin told Maha Hafeez was late", async () => {
    clock.minutes = 570;
    const res = await checkIn(AT_OFFICE);
    expect(res.status).toBe(201);
    expect(payloads["attendance:insert"].status).toBe("late");
    expect(payloads["attendance:insert"].points_awarded).toBe(-1);
    expect(notifyAdmins).toHaveBeenCalledWith(
      "Late arrival",
      expect.stringContaining("Maha Hafeez"),
      "late",
      "user-maha",
    );
  });

  it("checking in away from the office is flagged and both sides are notified", async () => {
    const res = await checkIn(FAR_AWAY);
    expect(res.status).toBe(201);
    expect(res.body.outside_office).toBe(true);
    expect(payloads["attendance:insert"].location_verified).toBe(false);
    expect(notifyAdmins).toHaveBeenCalledWith(
      "Location verification issue",
      expect.stringContaining("Maha Hafeez"),
      "location",
      "user-maha",
    );
    expect(notifyUser).toHaveBeenCalled();
  });

  it("checking in at the office is verified", async () => {
    const res = await checkIn(AT_OFFICE);
    expect(res.body.outside_office).toBe(false);
    expect(payloads["attendance:insert"].location_verified).toBe(true);
  });

  it("second check-in on the same day returns 409", async () => {
    setResult("attendance:insert", null, { code: "23505" });
    const res = await checkIn(AT_OFFICE);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Already checked in today");
  });
});

describe("check-out", () => {
  const openRow = { id: "a1", check_in: "2026-10-20T05:55:00Z", check_out: null };

  beforeEach(() => {
    setResult("attendance:select", openRow);
    setResult("attendance:update", { id: "a1" });
  });

  it("fails when there is no check-in today", async () => {
    setResult("attendance:select", null);
    const res = await checkOut(AT_OFFICE);
    expect(res.status).toBe(400);
  });

  it("fails when already checked out", async () => {
    setResult("attendance:select", { ...openRow, check_out: "2026-10-20T14:00:00Z" });
    const res = await checkOut(AT_OFFICE);
    expect(res.status).toBe(409);
  });

  it("16:00 is an early checkout with no overtime", async () => {
    clock.minutes = 960;
    const res = await checkOut(AT_OFFICE);
    expect(res.status).toBe(200);
    expect(payloads["attendance:update"].early_checkout).toBe(true);
    expect(payloads["attendance:update"].overtime_minutes).toBe(0);
  });

  it("18:00 gives 60 minutes of overtime", async () => {
    clock.minutes = 1080;
    await checkOut(AT_OFFICE);
    expect(payloads["attendance:update"].early_checkout).toBe(false);
    expect(payloads["attendance:update"].overtime_minutes).toBe(60);
  });

  it("exactly 17:00 is neither early nor overtime", async () => {
    clock.minutes = 1020;
    await checkOut(AT_OFFICE);
    expect(payloads["attendance:update"].early_checkout).toBe(false);
    expect(payloads["attendance:update"].overtime_minutes).toBe(0);
  });
});
