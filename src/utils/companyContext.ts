// src/utils/companyContext.ts
import { supabase } from "../config/supabase";
import { getSettings, toMinutes, fmtMinutes } from "./settings";
import { getLevels } from "./progression";

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// "08:00:00" -> "08:00"
const hhmm = (t: string) => String(t).slice(0, 5);

async function buildContext(): Promise<string> {
  const [settings, levels, policiesRes, deptsRes] = await Promise.all([
    getSettings(),
    getLevels(),
    supabase.from("leave_policies").select("leave_type, days_per_year"),
    supabase.from("departments").select("name").order("name"),
  ]);

  if (policiesRes.error) throw policiesRes.error;
  if (deptsRes.error) throw deptsRes.error;

  const lateAfter = fmtMinutes(
    toMinutes(settings.work_start) + settings.grace_minutes,
  );

  const leaves = (policiesRes.data ?? [])
    .map((p: any) =>
      p.days_per_year === null
        ? `- ${p.leave_type}: unlimited`
        : `- ${p.leave_type}: ${p.days_per_year} days per year`,
    )
    .join("\n");

  const departments = (deptsRes.data ?? []).map((d: any) => d.name).join(", ");

  const levelLines = levels
    .map(
      (l) =>
        `- Level ${l.level_no} (${l.name}): needs ${l.min_points} points and ${l.min_months} months in the previous level`,
    )
    .join("\n");

  const weekend = settings.weekend_days.map((d) => DAY_NAMES[d]).join(", ");

  return `
COMPANY POLICIES (current, set by the admin; this is the source of truth):

Work hours: ${hhmm(settings.work_start)} to ${hhmm(settings.work_end)}
Grace period: ${settings.grace_minutes} minutes
Late rule: a check-in after ${lateAfter} counts as late
Weekend days (non-working): ${weekend}

Attendance points:
- On-time check-in: ${settings.points_on_time} points
- Late check-in: ${settings.points_late} points

Yearly leave allowances:
${leaves || "- (none configured)"}

Departments: ${departments || "(none configured)"}

Progression levels (promotion needs both enough points and enough months):
${levelLines || "- (none configured)"}
`.trim();
}

// Short cache so the database isn't queried on every chat message.
// Admin changes show up in Noor's answers within about a minute.
let cache: { text: string; at: number } | null = null;
const CACHE_MS = 60_000;

export async function getCompanyContext(): Promise<string> {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    cache = { text: await buildContext(), at: Date.now() };
  }
  return cache.text;
}
