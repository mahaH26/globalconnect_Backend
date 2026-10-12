import { Router, Response } from "express";
import { supabase } from "../config/supabase";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { getSettings, localNow, toMinutes } from "../utils/settings";
import { eachDate, weekdayOf, lastDayOfMonth } from "../utils/dates";

const router = Router();
router.use(requireAuth);

// My monthly summary: GET /attendance/me/summary?month=YYYY-MM
router.get("/me/summary", async (req: AuthedRequest, res: Response) => {
  const settings = await getSettings();
  const now = localNow(settings);
  const month =
    typeof req.query.month === "string" && /^\d{4}-\d{2}$/.test(req.query.month)
      ? req.query.month
      : now.date.slice(0, 7);

  const first = `${month}-01`;
  const last = lastDayOfMonth(month);
  const upTo = last < now.date ? last : now.date; // never count future days
  const userId = req.user!.id;

  const [attR, leaveR, ptsR] = await Promise.all([
    supabase
      .from("attendance")
      .select(
        "work_date, status, check_in, early_checkout, overtime_minutes, points_awarded",
      )
      .eq("user_id", userId)
      .gte("work_date", first)
      .lte("work_date", last),
    supabase
      .from("leave_requests")
      .select("start_date, end_date")
      .eq("user_id", userId)
      .eq("status", "approved")
      .lte("start_date", last)
      .gte("end_date", first),
    supabase
      .from("profiles")
      .select("attendance_points")
      .eq("id", userId)
      .single(),
  ]);
  for (const r of [attR, leaveR, ptsR]) if (r.error) throw r.error;

  const rows = attR.data ?? [];
  const attendedDates = new Set<string>(
    rows
      .filter((r: { check_in: string | null }) => r.check_in)
      .map((r: { work_date: string }) => r.work_date),
  );

  // Approved leave days that fall on working days inside the month
  const leaveDates = new Set<string>();
  for (const l of leaveR.data ?? []) {
    const from = l.start_date > first ? l.start_date : first;
    const to = l.end_date < last ? l.end_date : last;
    for (const d of eachDate(from, to))
      if (!settings.weekend_days.includes(weekdayOf(d))) leaveDates.add(d);
  }

  const cutoff = toMinutes(settings.work_start) + settings.grace_minutes;
  let expected = 0;
  let absent = 0;
  if (first <= upTo) {
    for (const d of eachDate(first, upTo)) {
      if (settings.weekend_days.includes(weekdayOf(d))) continue;
      if (leaveDates.has(d) && !attendedDates.has(d)) continue;
      if (d === now.date && now.minutes <= cutoff && !attendedDates.has(d))
        continue; // day not over yet
      expected++;
      if (!attendedDates.has(d)) absent++;
    }
  }

  const present = rows.filter(
    (r: { status: string }) => r.status === "present",
  ).length;
  const late = rows.filter(
    (r: { status: string }) => r.status === "late",
  ).length;
  res.json({
    month,
    expected_days: expected,
    present,
    late,
    absent,
    on_leave_days: [...leaveDates].filter((d) => d <= upTo).length,
    early_checkouts: rows.filter(
      (r: { early_checkout: boolean }) => r.early_checkout,
    ).length,
    overtime_minutes: rows.reduce(
      (s: number, r: { overtime_minutes: number }) =>
        s + (r.overtime_minutes || 0),
      0,
    ),
    points_this_month: rows.reduce(
      (s: number, r: { points_awarded: number }) => s + (r.points_awarded || 0),
      0,
    ),
    total_points: ptsR.data?.attendance_points ?? 0,
    attendance_rate:
      expected > 0 ? Math.round(((present + late) / expected) * 100) : null,
  });
});

export default router;
