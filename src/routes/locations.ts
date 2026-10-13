import { Router, Response } from "express";
import { z } from "zod";
import { supabase } from "../config/supabase";
import { requireAuth, requireManager, AuthedRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth, requireManager);

const num = (v: any) =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v))
    ? null
    : Number(v);
const pick = (row: any, keys: string[]) => {
  for (const k of keys) {
    const n = num(row[k]);
    if (n !== null) return n;
  }
  return null;
};

const IN_LAT = [
  "check_in_lat",
  "check_in_latitude",
  "in_lat",
  "in_latitude",
  "latitude",
  "lat",
];
const IN_LNG = [
  "check_in_lng",
  "check_in_lon",
  "check_in_longitude",
  "in_lng",
  "in_longitude",
  "longitude",
  "lng",
  "lon",
];
const OUT_LAT = [
  "check_out_lat",
  "check_out_latitude",
  "out_lat",
  "out_latitude",
];
const OUT_LNG = [
  "check_out_lng",
  "check_out_lon",
  "check_out_longitude",
  "out_lng",
  "out_longitude",
];
const OFFICE_RADIUS = [
  "radius_m",
  "radius",
  "allowed_radius_m",
  "allowed_radius",
];

function distanceM(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

const clock = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Bahrain",
      })
    : null;

router.get("/map", async (req: AuthedRequest, res: Response) => {
  const parsed = z
    .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
    .safeParse(req.query);
  if (!parsed.success)
    return res.status(400).json({ error: "date (YYYY-MM-DD) is required" });
  const date = parsed.data.date;

  const { data: offRows } = await supabase.from("office_locations").select("*");
  const offices = ((offRows ?? []) as any[])
    .map((o) => ({
      name: o.name ?? "Office",
      lat: pick(o, ["latitude", "lat"]),
      lng: pick(o, ["longitude", "lng", "lon"]),
      radius: pick(o, OFFICE_RADIUS),
    }))
    .filter((o) => o.lat !== null && o.lng !== null);

  const { data: att, error } = await supabase
    .from("attendance")
    .select("*")
    .eq("work_date", date);
  if (error) return res.status(500).json({ error: error.message });

  const ids = [...new Set((att ?? []).map((a: any) => a.user_id))];
  const names = new Map<string, { name: string; dept: string }>();
  if (ids.length) {
    const { data: people } = await supabase
      .from("profiles")
      .select("id, full_name, departments(name)")
      .in("id", ids);
    for (const p of (people ?? []) as any[]) {
      const d = Array.isArray(p.departments) ? p.departments[0] : p.departments;
      names.set(p.id, { name: p.full_name, dept: d?.name ?? "-" });
    }
  }

  let missing = 0;
  const points: any[] = [];
  for (const a of (att ?? []) as any[]) {
    const lat = pick(a, IN_LAT);
    const lng = pick(a, IN_LNG);
    if (lat === null || lng === null) {
      missing++;
      continue;
    }
    let nearest: number | null = null;
    let within: boolean | null = null;
    for (const o of offices) {
      const d = distanceM(lat, lng, o.lat!, o.lng!);
      if (nearest === null || d < nearest) {
        nearest = d;
        within = o.radius !== null ? d <= o.radius : null;
      }
    }
    const p = names.get(a.user_id);
    points.push({
      user_id: a.user_id,
      name: p?.name ?? "Unknown",
      department: p?.dept ?? "-",
      status: a.status,
      check_in: clock(a.check_in),
      check_out: clock(a.check_out),
      lat,
      lng,
      out_lat: pick(a, OUT_LAT),
      out_lng: pick(a, OUT_LNG),
      distance_m: nearest,
      within_radius: within,
    });
  }

  res.json({
    date,
    offices,
    points,
    missing_coordinates: missing,
    total_records: (att ?? []).length,
  });
});

export default router;
