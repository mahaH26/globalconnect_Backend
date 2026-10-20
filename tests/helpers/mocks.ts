export const clock = { date: "2026-10-20", minutes: 535 };
export const leaveDays = { value: 3 };

export const authMock = () => {
  const actual = jest.requireActual("../../src/middleware/auth");
  return {
    ...actual,
    requireAuth: (req: any, res: any, next: any) => {
      const role = req.headers["x-test-role"];
      if (!role) return res.status(401).json({ error: "Missing token" });
      req.user = { id: "user-maha", role, full_name: "Maha Hafeez" };
      next();
    },
  };
};

export const settingsMock = () => {
  const actual = jest.requireActual("../../src/utils/settings");
  return {
    ...actual,
    getSettings: async () => ({
      work_start: "09:00",
      work_end: "17:00",
      grace_minutes: 15,
      points_on_time: 1,
      points_late: -1,
      weekend_days: [5, 6],
    }),
    localNow: () => ({ date: clock.date, minutes: clock.minutes }),
    countWorkingDays: () => leaveDays.value,
  };
};

export const notifyMock = {
  notifyAdmins: jest.fn(),
  notifyUser: jest.fn(),
};
