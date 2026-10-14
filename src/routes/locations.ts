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

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const querySchema = z.object({
  from: date.optional(),
  to: date.optional(),
  date: date.optional(),
  user_id: z.string().uuid().optional(),
});

router.get("/map", async (req: AuthedRequest, res: Response) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success)
    return res.status(400).json({ error: "Invalid filters" });
  const from = parsed.data.from ?? parsed.data.date;
  const to = parsed.data.to ?? parsed.data.date ?? from;
  if (!from || !to)
    return res.status(400).json({ error: "from and to dates are required" });
  if (to < from)
    return res
      .status(400)
      .json({ error: "End date must not be before start date" });

  const { data: offRows } = await supabase.from("office_locations").select("*");
  const offices = ((offRows ?? []) as any[])
    .map((o) => ({
      name: o.name ?? "Office",
      address: o.address ?? null,
      lat: num(o.latitude),
      lng: num(o.longitude),
      radius: num(o.radius_m),
    }))
    .filter((o) => o.lat !== null && o.lng !== null);

  let q = supabase
    .from("attendance")
    .select("*")
    .gte("work_date", from)
    .lte("work_date", to)
    .order("work_date", { ascending: false })
    .limit(2000);
  if (parsed.data.user_id) q = q.eq("user_id", parsed.data.user_id);
  const { data: att, error } = await q;
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
    const lat = num(a.check_in_lat);
    const lng = num(a.check_in_lng);
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
      id: a.id,
      user_id: a.user_id,
      name: p?.name ?? "Unknown",
      department: p?.dept ?? "-",
      work_date: String(a.work_date),
      status: a.status,
      check_in: clock(a.check_in),
      check_out: clock(a.check_out),
      lat,
      lng,
      distance_m: nearest,
      within_radius: within,
    });
  }

  res.json({
    from,
    to,
    offices,
    points,
    missing_coordinates: missing,
    total_records: (att ?? []).length,
  });
});

export default router;
