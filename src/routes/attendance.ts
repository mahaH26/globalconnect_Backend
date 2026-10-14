import { Router, Response } from "express";
import { z } from "zod";
import { supabase } from "../config/supabase";
import { requireAuth, requireManager, AuthedRequest } from "../middleware/auth";
import { distanceMeters } from "../utils/distance";
import {
  getSettings,
  localNow,
  toMinutes,
  fmtMinutes,
} from "../utils/settings";
import { notifyAdmins, notifyUser } from "../utils/notify";

const router = Router();
router.use(requireAuth);

const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

async function nearestOffice(lat: number, lng: number) {
  const { data: offices } = await supabase.from("office_locations").select("*");
  if (!offices?.length) return null;
  let best = { office: offices[0], distance: Infinity };
  for (const o of offices) {
    const d = distanceMeters(lat, lng, o.latitude, o.longitude);
    if (d < best.distance) best = { office: o, distance: d };
  }
  return best;
}

async function addPoints(userId: string, points: number) {
  const { data } = await supabase
    .from("profiles")
    .select("attendance_points")
    .eq("id", userId)
    .single();
  await supabase
    .from("profiles")
    .update({ attendance_points: (data?.attendance_points ?? 0) + points })
    .eq("id", userId);
}

async function notifyOutside(
  user: { id: string; full_name: string },
  action: "check in" | "check out",
  distance: number,
  allowed: number,
) {
  const m = Math.round(distance);
  await notifyAdmins(
    "Location verification issue",
    `${user.full_name} ${action === "check in" ? "checked in" : "checked out"} outside the office location, ${m} m away (allowed ${allowed} m).`,
    "location",
    user.id,
  );
  await notifyUser(
    user.id,
    "Outside office location",
    `You ${action === "check in" ? "checked in" : "checked out"} ${m} m from the office. Your admin has been notified.`,
    "location",
  );
}

router.post("/check-in", async (req: AuthedRequest, res: Response) => {
  const parsed = locationSchema.safeParse(req.body);
  if (!parsed.success)
    return res
      .status(400)
      .json({ error: "latitude and longitude are required" });
  const { latitude, longitude } = parsed.data;
  const user = req.user!;

  const near = await nearestOffice(latitude, longitude);
  const distance = near ? near.distance : null;
  const outside = near ? near.distance > near.office.radius_m : false;

  const settings = await getSettings();
  const now = localNow(settings);
  const late =
    now.minutes > toMinutes(settings.work_start) + settings.grace_minutes;
  const points = late ? settings.points_late : settings.points_on_time;

  const { data, error } = await supabase
    .from("attendance")
    .insert({
      user_id: user.id,
      work_date: now.date,
      check_in: new Date().toISOString(),
      check_in_lat: latitude,
      check_in_lng: longitude,
      distance_m: distance,
      location_verified: !outside,
      status: late ? "late" : "present",
      points_awarded: points,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505")
      return res.status(409).json({ error: "Already checked in today" });
    throw error;
  }

  await addPoints(user.id, points);
  if (outside && near)
    await notifyOutside(user, "check in", near.distance, near.office.radius_m);
  if (late) {
    await notifyAdmins(
      "Late arrival",
      `${user.full_name} checked in late at ${fmtMinutes(now.minutes)}.`,
      "late",
      user.id,
    );
  }
  res.status(201).json({
    ...data,
    outside_office: outside,
    distance_m: distance === null ? null : Math.round(distance),
  });
});

router.post("/check-out", async (req: AuthedRequest, res: Response) => {
  const parsed = locationSchema.safeParse(req.body);
  if (!parsed.success)
    return res
      .status(400)
      .json({ error: "latitude and longitude are required" });
  const { latitude, longitude } = parsed.data;
  const user = req.user!;

  const near = await nearestOffice(latitude, longitude);
  const outside = near ? near.distance > near.office.radius_m : false;

  const settings = await getSettings();
  const now = localNow(settings);
  const { data: row } = await supabase
    .from("attendance")
    .select("*")
    .eq("user_id", user.id)
    .eq("work_date", now.date)
    .maybeSingle();

  if (!row || !row.check_in)
    return res.status(400).json({ error: "No check-in found for today" });
  if (row.check_out)
    return res.status(409).json({ error: "Already checked out today" });

  const end = toMinutes(settings.work_end);
  const { data, error } = await supabase
    .from("attendance")
    .update({
      check_out: new Date().toISOString(),
      check_out_lat: latitude,
      check_out_lng: longitude,
      early_checkout: now.minutes < end,
      overtime_minutes: Math.max(0, now.minutes - end),
    })
    .eq("id", row.id)
    .select()
    .single();
  if (error) throw error;

  if (outside && near)
    await notifyOutside(user, "check out", near.distance, near.office.radius_m);
  res.json({
    ...data,
    outside_office: outside,
    distance_m: near ? Math.round(near.distance) : null,
  });
});

router.get("/today", async (req: AuthedRequest, res: Response) => {
  const settings = await getSettings();
  const { date } = localNow(settings);
  const { data, error } = await supabase
    .from("attendance")
    .select("*")
    .eq("user_id", req.user!.id)
    .eq("work_date", date)
    .maybeSingle();
  if (error) throw error;
  res.json(data ?? null);
});

router.get("/me", async (req: AuthedRequest, res: Response) => {
  let q = supabase
    .from("attendance")
    .select("*")
    .eq("user_id", req.user!.id)
    .order("work_date", { ascending: false })
    .limit(100);
  if (typeof req.query.from === "string")
    q = q.gte("work_date", req.query.from);
  if (typeof req.query.to === "string") q = q.lte("work_date", req.query.to);
  const { data, error } = await q;
  if (error) throw error;
  res.json(data);
});

router.get("/", requireManager, async (req: AuthedRequest, res: Response) => {
  let q = supabase
    .from("attendance")
    .select(
      "*, profiles!inner(full_name, position, department_id, departments(name))",
    )
    .order("work_date", { ascending: false })
    .limit(500);
  const { date, from, to, user_id, department_id, status } = req.query;
  if (typeof date === "string") q = q.eq("work_date", date);
  if (typeof from === "string") q = q.gte("work_date", from);
  if (typeof to === "string") q = q.lte("work_date", to);
  if (typeof user_id === "string") q = q.eq("user_id", user_id);
  if (typeof status === "string") q = q.eq("status", status);
  if (typeof department_id === "string")
    q = q.eq("profiles.department_id", department_id);
  const { data, error } = await q;
  if (error) throw error;
  res.json(data);
});

export default router;
