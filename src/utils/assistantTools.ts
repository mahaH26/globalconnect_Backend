import { supabase } from "../config/supabase";
import { getSettings, localNow, toMinutes } from "./settings";
import { eachDate, weekdayOf, lastDayOfMonth } from "./dates";
import { getProgress } from "./progression";

export type ToolCtx = {
  userId: string;
  role: "employee" | "admin";
  name: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// Profile fields the assistant may show (allow-list: nothing else ever leaves)
const PROFILE_FIELDS = [
  "id",
  "full_name",
  "role",
  "employment_status",
  "position",
  "phone",
  "joining_date",
  "attendance_points",
  "level_since",
];

/* ---------------------------- tool definitions --------------------------- */
const fn = (
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
) => ({
  type: "function",
  function: {
    name,
    description,
    parameters: { type: "object", properties, required },
  },
});

const month = { type: "string", description: "YYYY-MM, default this month" };
const statusEnum = {
  type: "string",
  enum: ["pending", "approved", "rejected"],
};
const empId = { type: "string", description: "employee id from find_employee" };

const employeeTools = [
  fn(
    "my_attendance_summary",
    "Monthly attendance for the current user: expected working days, present, late, absent, leave days, early check-outs, overtime minutes, points, attendance rate.",
    { month },
  ),
  fn(
    "my_leave_balance",
    "Leave balance of the current user per leave type: allowance, approved, pending, remaining. Optional year.",
    { year: { type: "number" } },
  ),
  fn("my_leave_requests", "Leave requests of the current user, newest first.", {
    status: statusEnum,
  }),
  fn(
    "my_progression",
    "Current level, points, months in level, next level requirements and promotion eligibility.",
  ),
  fn("my_profile", "Basic profile of the current user."),
  fn(
    "company_policies",
    "Work hours, grace period, weekend days, attendance points and yearly leave allowances.",
  ),
];

const adminTools = [
  fn(
    "find_employee",
    "Search employees by name. Returns id, name, position, status. Use this first to get an employee_id.",
    { name: { type: "string" } },
    ["name"],
  ),
  fn(
    "employee_profile",
    "Profile of one employee (position, phone, joining date, status, points, department, level).",
    { employee_id: empId },
    ["employee_id"],
  ),
  fn(
    "employee_attendance_summary",
    "Monthly attendance summary of one employee.",
    { employee_id: empId, month },
    ["employee_id"],
  ),
  fn(
    "employee_leave_balance",
    "Leave balance of one employee.",
    { employee_id: empId, year: { type: "number" } },
    ["employee_id"],
  ),
  fn(
    "employee_leave_requests",
    "Leave requests of one employee.",
    { employee_id: empId, status: statusEnum },
    ["employee_id"],
  ),
  fn(
    "employee_progression",
    "Level, points and promotion eligibility of one employee.",
    { employee_id: empId },
    ["employee_id"],
  ),
  fn("pending_leave_requests", "All pending leave requests in the company."),
  fn("late_today", "Employees who checked in late today."),
];

const adminOnly = new Set(adminTools.map((t) => t.function.name));

export const toolsFor = (role: string) =>
  role === "admin" ? [...employeeTools, ...adminTools] : employeeTools;

/* ------------------------------- helpers -------------------------------- */
function pick(row: any, fields: string[]) {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f in row) out[f] = row[f];
  return out;
}

function checkId(id: unknown): string {
  if (typeof id !== "string" || !UUID.test(id))
    throw new Error("Invalid employee_id");
  return id;
}

async function audit(ctx: ToolCtx, action: string, target?: string) {
  const { error } = await supabase
    .from("assistant_audit")
    .insert({ admin_id: ctx.userId, action, target_user_id: target ?? null });
  if (error) console.error("audit log failed:", error.message);
}

async function nameMap(ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name")
    .in("id", ids);
  return new Map((data ?? []).map((p: any) => [p.id, p.full_name as string]));
}

/* Same logic as GET /attendance/me/summary in attendanceSummary.ts */
async function attendanceSummary(userId: string, monthArg?: string) {
  const settings = await getSettings();
  const now = localNow(settings);
  const m = monthArg && MONTH.test(monthArg) ? monthArg : now.date.slice(0, 7);
  const first = `${m}-01`;
  const last = lastDayOfMonth(m);
  const upTo = last < now.date ? last : now.date;

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
      .maybeSingle(),
  ]);
  for (const r of [attR, leaveR, ptsR])
    if (r.error) throw new Error("Could not load attendance");

  const rows = attR.data ?? [];
  const attended = new Set<string>(
    rows.filter((r: any) => r.check_in).map((r: any) => r.work_date),
  );

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
      if (leaveDates.has(d) && !attended.has(d)) continue;
      if (d === now.date && now.minutes <= cutoff && !attended.has(d)) continue;
      expected++;
      if (!attended.has(d)) absent++;
    }
  }

  const present = rows.filter((r: any) => r.status === "present").length;
  const late = rows.filter((r: any) => r.status === "late").length;
  return {
    month: m,
    expected_days: expected,
    present_on_time: present,
    late,
    absent,
    on_leave_days: [...leaveDates].filter((d) => d <= upTo).length,
    early_checkouts: rows.filter((r: any) => r.early_checkout).length,
    overtime_minutes: rows.reduce(
      (s: number, r: any) => s + (r.overtime_minutes || 0),
      0,
    ),
    points_this_month: rows.reduce(
      (s: number, r: any) => s + (r.points_awarded || 0),
      0,
    ),
    total_points: ptsR.data?.attendance_points ?? 0,
    attendance_rate_pct:
      expected > 0 ? Math.round(((present + late) / expected) * 100) : null,
  };
}

/* Same logic as getBalance in leave.ts */
async function leaveBalance(userId: string, year?: number) {
  const y = Number(year) || new Date().getFullYear();
  const { data: policies } = await supabase.from("leave_policies").select("*");
  const { data: reqs } = await supabase
    .from("leave_requests")
    .select("leave_type, days, status")
    .eq("user_id", userId)
    .in("status", ["approved", "pending"])
    .gte("start_date", `${y}-01-01`)
    .lte("start_date", `${y}-12-31`);

  return {
    year: y,
    balances: (policies ?? []).map((p: any) => {
      const mine = (reqs ?? []).filter(
        (r: any) => r.leave_type === p.leave_type,
      );
      const sum = (st: string) =>
        mine
          .filter((r: any) => r.status === st)
          .reduce((s: number, r: any) => s + r.days, 0);
      const approved = sum("approved");
      const pending = sum("pending");
      return {
        leave_type: p.leave_type,
        allowance: p.days_per_year,
        approved,
        pending,
        remaining:
          p.days_per_year === null
            ? "unlimited"
            : p.days_per_year - approved - pending,
      };
    }),
  };
}

async function leaveRequests(userId: string, status?: string) {
  let q = supabase
    .from("leave_requests")
    .select(
      "id, leave_type, start_date, end_date, days, status, reason, created_at",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw new Error("Could not load leave requests");
  return data ?? [];
}

async function progression(userId: string) {
  const p = await getProgress(userId);
  if (!p) throw new Error("Employee not found");
  return {
    current_level: p.current_level?.name ?? null,
    next_level: p.next_level?.name ?? null,
    points: p.points,
    months_in_level: p.months_in_level,
    points_needed_for_next: p.points_needed,
    months_needed_for_next: p.months_needed,
    eligible_for_promotion: p.eligible,
  };
}

async function fullProfile(userId: string) {
  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  if (!data) throw new Error("Employee not found");
  const [dep, lvl] = await Promise.all([
    data.department_id
      ? supabase
          .from("departments")
          .select("name")
          .eq("id", data.department_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    data.level_id
      ? supabase
          .from("progression_levels")
          .select("name")
          .eq("id", data.level_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  return {
    ...pick(data, PROFILE_FIELDS),
    department: (dep.data as any)?.name ?? null,
    level: (lvl.data as any)?.name ?? null,
  };
}

/* ------------------------------ tool runner ------------------------------ */
export async function runTool(
  name: string,
  args: any,
  ctx: ToolCtx,
): Promise<unknown> {
  // Hard permission check, independent of which tools the AI was shown
  if (adminOnly.has(name) && ctx.role !== "admin")
    throw new Error("Not allowed");

  switch (name) {
    /* ---- employee tools: ALWAYS use ctx.userId, never an id from the AI ---- */
    case "my_attendance_summary":
      return attendanceSummary(ctx.userId, args?.month);
    case "my_leave_balance":
      return leaveBalance(ctx.userId, args?.year);
    case "my_leave_requests":
      return leaveRequests(ctx.userId, args?.status);
    case "my_progression":
      return progression(ctx.userId);
    case "my_profile":
      return fullProfile(ctx.userId);

    case "company_policies": {
      const s = await getSettings();
      const { data: policies } = await supabase
        .from("leave_policies")
        .select("*");
      const days = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ];
      return {
        work_start: s.work_start,
        work_end: s.work_end,
        grace_minutes: s.grace_minutes,
        weekend: s.weekend_days.map((d) => days[d]),
        points_for_on_time_checkin: s.points_on_time,
        points_for_late_checkin: s.points_late,
        yearly_leave_allowance: (policies ?? []).map((p: any) => ({
          leave_type: p.leave_type,
          days_per_year: p.days_per_year ?? "unlimited",
        })),
      };
    }

    /* ------------------------------ admin tools ----------------------------- */
    case "find_employee": {
      const term = String(args?.name ?? "")
        .trim()
        .slice(0, 60)
        .replace(/[%,()]/g, "");
      if (!term) throw new Error("name is required");
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name, position, employment_status")
        .ilike("full_name", `%${term}%`)
        .limit(10);
      return data ?? [];
    }
    case "employee_profile": {
      const id = checkId(args?.employee_id);
      await audit(ctx, name, id);
      return fullProfile(id);
    }
    case "employee_attendance_summary": {
      const id = checkId(args?.employee_id);
      await audit(ctx, name, id);
      return attendanceSummary(id, args?.month);
    }
    case "employee_leave_balance": {
      const id = checkId(args?.employee_id);
      await audit(ctx, name, id);
      return leaveBalance(id, args?.year);
    }
    case "employee_leave_requests": {
      const id = checkId(args?.employee_id);
      await audit(ctx, name, id);
      return leaveRequests(id, args?.status);
    }
    case "employee_progression": {
      const id = checkId(args?.employee_id);
      await audit(ctx, name, id);
      return progression(id);
    }
    case "pending_leave_requests": {
      await audit(ctx, name);
      const { data, error } = await supabase
        .from("leave_requests")
        .select("id, user_id, leave_type, start_date, end_date, days, reason")
        .eq("status", "pending")
        .order("start_date", { ascending: true })
        .limit(50);
      if (error) throw new Error("Could not load leave requests");
      const names = await nameMap([
        ...new Set((data ?? []).map((r: any) => r.user_id)),
      ]);
      return (data ?? []).map(({ user_id, ...r }: any) => ({
        employee: names.get(user_id) ?? "Unknown",
        ...r,
      }));
    }
    case "late_today": {
      await audit(ctx, name);
      const today = localNow(await getSettings()).date;
      const { data, error } = await supabase
        .from("attendance")
        .select("user_id, check_in")
        .eq("work_date", today)
        .eq("status", "late");
      if (error) throw new Error("Could not load attendance");
      const names = await nameMap([
        ...new Set((data ?? []).map((r: any) => r.user_id)),
      ]);
      return (data ?? []).map((r: any) => ({
        employee: names.get(r.user_id) ?? "Unknown",
        check_in: r.check_in,
      }));
    }
  }
  throw new Error("Unknown tool");
}
