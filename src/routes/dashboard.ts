import { Router, Response } from "express";
import { supabase } from "../config/supabase";
import { requireAuth, requireManager, AuthedRequest } from "../middleware/auth";
import { getSettings, localNow, toMinutes } from "../utils/settings";

const router = Router();
router.use(requireAuth, requireManager);

router.get("/", async (req: AuthedRequest, res: Response) => {
  const settings = await getSettings();
  const now = localNow(settings);
  const workday = !settings.weekend_days.includes(now.weekday);
  const pastGrace =
    now.minutes > toMinutes(settings.work_start) + settings.grace_minutes;
  const pastEnd = now.minutes > toMinutes(settings.work_end);

  const [staffR, attR, leaveR, pendingR, notesR] = await Promise.all([
    supabase
      .from("profiles")
      .select("id")
      .in("employment_status", ["active", "probation"]),
    supabase
      .from("attendance")
      .select("user_id, status, check_out")
      .eq("work_date", now.date),
    supabase
      .from("leave_requests")
      .select("user_id")
      .eq("status", "approved")
      .lte("start_date", now.date)
      .gte("end_date", now.date),
    supabase
      .from("leave_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase
      .from("notifications")
      .select("*")
      .eq("user_id", req.user!.id)
      .eq("is_read", false)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);
  for (const r of [staffR, attR, leaveR, pendingR, notesR])
    if (r.error) throw r.error;

  const staff = new Set<string>(
    (staffR.data ?? []).map((s: { id: string }) => s.id),
  );
  const att = (attR.data ?? []).filter((a: { user_id: string }) =>
    staff.has(a.user_id),
  );
  const attended = new Set<string>(
    att.map((a: { user_id: string }) => a.user_id),
  );
  const onLeave = new Set<string>(
    (leaveR.data ?? [])
      .map((l: { user_id: string }) => l.user_id)
      .filter((id: string) => staff.has(id) && !attended.has(id)),
  );

  const total = staff.size;
  const present = att.length;
  const late = att.filter(
    (a: { status: string }) => a.status === "late",
  ).length;
  const expected = workday ? Math.max(0, total - onLeave.size) : 0;
  const notCheckedIn = workday ? Math.max(0, expected - present) : 0;
  const absent = workday && pastGrace ? notCheckedIn : 0;
  const missingCheckout =
    workday && pastEnd
      ? att.filter((a: { check_out: string | null }) => !a.check_out).length
      : 0;

  res.json({
    date: now.date,
    is_workday: workday,
    total_employees: total,
    present,
    on_time: present - late,
    late,
    on_leave: workday ? onLeave.size : 0,
    not_checked_in: notCheckedIn,
    absent,
    attendance_rate:
      expected > 0 ? Math.round((present / expected) * 100) : null,
    alerts: {
      pending_leave_requests: pendingR.count ?? 0,
      missing_checkout: missingCheckout,
      unread_notifications: notesR.data ?? [],
    },
  });
});

export default router;
