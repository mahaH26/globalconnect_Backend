import { supabase } from "../config/supabase";
import { notifyAdmins } from "./notify";
import { monthsBetween } from "./dates";
import { getSettings, localNow } from "./settings";

export interface Level {
  id: string;
  level_no: number;
  name: string;
  min_points: number;
  min_months: number;
}
interface ProfileLite {
  attendance_points: number;
  level_id: string | null;
  level_since: string;
}

export function computeProgress(
  profile: ProfileLite,
  levels: Level[],
  today: string,
) {
  const sorted = [...levels].sort((a, b) => a.level_no - b.level_no);
  const idx = sorted.findIndex((l) => l.id === profile.level_id);
  const current = idx >= 0 ? sorted[idx] : null;
  const next = idx >= 0 ? (sorted[idx + 1] ?? null) : null;
  const months = monthsBetween(profile.level_since, today);
  const points = profile.attendance_points ?? 0;

  const eligible =
    !!next && points >= next.min_points && months >= next.min_months;
  return {
    current_level: current,
    next_level: next,
    points,
    months_in_level: months,
    level_since: profile.level_since,
    points_needed: next ? Math.max(0, next.min_points - points) : 0,
    months_needed: next ? Math.max(0, next.min_months - months) : 0,
    points_progress_pct:
      next && next.min_points > 0
        ? Math.min(100, Math.round((points / next.min_points) * 100))
        : 100,
    eligible,
  };
}

export async function getLevels(): Promise<Level[]> {
  const { data, error } = await supabase
    .from("progression_levels")
    .select("*")
    .order("level_no");
  if (error) throw error;
  return (data ?? []) as Level[];
}

export async function getProgress(userId: string) {
  const [levels, settings, p] = await Promise.all([
    getLevels(),
    getSettings(),
    supabase
      .from("profiles")
      .select("attendance_points, level_id, level_since")
      .eq("id", userId)
      .maybeSingle(),
  ]);
  if (p.error) throw p.error;
  if (!p.data) return null;
  return computeProgress(
    p.data as ProfileLite,
    levels,
    localNow(settings).date,
  );
}

export async function notifyIfEligible(userId: string) {
  const progress = await getProgress(userId);
  if (!progress || !progress.eligible || !progress.next_level) return;

  const { data: existing } = await supabase
    .from("notifications")
    .select("id")
    .eq("type", "eligible")
    .eq("related_user_id", userId)
    .gte("created_at", progress.level_since)
    .limit(1);
  if (existing?.length) return;

  const { data: who } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", userId)
    .single();
  await notifyAdmins(
    "Promotion eligibility",
    `${who?.full_name ?? "An employee"} is eligible for promotion to ${progress.next_level.name}.`,
    "eligible",
    userId,
  );
}
