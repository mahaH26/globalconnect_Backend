import { supabase } from "../config/supabase";

export interface Settings {
  work_start: string;
  work_end: string;
  grace_minutes: number;
  weekend_days: number[];
  points_on_time: number;
  points_late: number;
  utc_offset_minutes: number;
}

export async function getSettings(): Promise<Settings> {
  const { data, error } = await supabase
    .from("settings")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw error;
  return data as Settings;
}

export function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export function fmtMinutes(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

export function localNow(s: Settings) {
  const d = new Date(Date.now() + s.utc_offset_minutes * 60000);
  return {
    date: d.toISOString().slice(0, 10),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}

export function countWorkingDays(
  start: string,
  end: string,
  weekend: number[],
): number {
  let count = 0;
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (d <= last) {
    if (!weekend.includes(d.getUTCDay())) count++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}
