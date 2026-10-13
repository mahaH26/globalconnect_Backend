import { Router, Response } from "express";
import { supabase } from "../config/supabase";
import { requireAuth, AuthedRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

const BAHRAIN_OFFSET_MIN = 180;

function minutesOfDay(iso: string) {
  const d = new Date(iso);
  return (d.getUTCHours() * 60 + d.getUTCMinutes() + BAHRAIN_OFFSET_MIN) % 1440;
}

const pct = (num: number, den: number) =>
  den > 0 ? Math.round((num / den) * 1000) / 10 : null;

router.get("/me", async (req: AuthedRequest, res: Response) => {
  const months = Math.min(12, Math.max(1, Number(req.query.months) || 6));
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1),
  );
  const startDate = start.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("attendance")
    .select(
      "work_date, status, check_in, check_out, early_checkout, overtime_minutes, points_awarded",
    )
    .eq("user_id", req.user!.id)
    .gte("work_date", startDate)
    .order("work_date", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  const rows = data ?? [];

  const keys: string[] = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1),
    );
    keys.push(d.toISOString().slice(0, 7));
  }

  const buckets = new Map(
    keys.map((k) => [
      k,
      {
        month: k,
        present: 0,
        late: 0,
        absent: 0,
        early_checkouts: 0,
        overtime_minutes: 0,
        points: 0,
        worked_minutes: 0,
        days_with_hours: 0,
      },
    ]),
  );

  let checkInSum = 0;
  let checkInCount = 0;
  let streak = 0;
  let longest = 0;

  for (const r of rows) {
    const b = buckets.get(String(r.work_date).slice(0, 7));
    if (!b) continue;

    if (r.status === "present") b.present++;
    else if (r.status === "late") b.late++;
    else if (r.status === "absent") b.absent++;

    if (r.early_checkout) b.early_checkouts++;
    b.overtime_minutes += r.overtime_minutes ?? 0;
    b.points += r.points_awarded ?? 0;

    if (r.check_in) {
      checkInSum += minutesOfDay(r.check_in);
      checkInCount++;
    }
    if (r.check_in && r.check_out) {
      const mins =
        (new Date(r.check_out).getTime() - new Date(r.check_in).getTime()) /
        60000;
      if (mins > 0 && mins < 1440) {
        b.worked_minutes += mins;
        b.days_with_hours++;
      }
    }

    if (r.status === "present") {
      streak++;
      longest = Math.max(longest, streak);
    } else if (r.status === "late" || r.status === "absent") {
      streak = 0;
    }
  }

  const monthList = [...buckets.values()].map((b) => {
    const attended = b.present + b.late;
    return {
      ...b,
      worked_minutes: Math.round(b.worked_minutes),
      attendance_rate: pct(attended, attended + b.absent),
      on_time_rate: pct(b.present, attended),
    };
  });

  const t = monthList.reduce(
    (a, m) => ({
      present: a.present + m.present,
      late: a.late + m.late,
      absent: a.absent + m.absent,
      early_checkouts: a.early_checkouts + m.early_checkouts,
      overtime_minutes: a.overtime_minutes + m.overtime_minutes,
      points: a.points + m.points,
      worked_minutes: a.worked_minutes + m.worked_minutes,
      days_with_hours: a.days_with_hours + m.days_with_hours,
    }),
    {
      present: 0,
      late: 0,
      absent: 0,
      early_checkouts: 0,
      overtime_minutes: 0,
      points: 0,
      worked_minutes: 0,
      days_with_hours: 0,
    },
  );
  const attended = t.present + t.late;

  res.json({
    range_months: months,
    months: monthList,
    totals: {
      ...t,
      days_tracked: rows.length,
      attendance_rate: pct(attended, attended + t.absent),
      on_time_rate: pct(t.present, attended),
      avg_check_in_minutes: checkInCount
        ? Math.round(checkInSum / checkInCount)
        : null,
      avg_hours_per_day: t.days_with_hours
        ? Math.round((t.worked_minutes / t.days_with_hours / 60) * 10) / 10
        : null,
      longest_on_time_streak: longest,
      current_on_time_streak: streak,
      first_record: rows[0]?.work_date ?? null,
    },
  });
});

export default router;
