import { Router, Response } from "express";
import { z } from "zod";
import { supabase } from "../config/supabase";
import { requireAuth, requireManager, AuthedRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

// Everyone logged in can read the company configuration
router.get("/", async (_req: AuthedRequest, res: Response) => {
  const [settings, offices, departments, policies, levels] = await Promise.all([
    supabase.from("settings").select("*").eq("id", 1).single(),
    supabase.from("office_locations").select("*").order("name"),
    supabase.from("departments").select("*").order("name"),
    supabase.from("leave_policies").select("*"),
    supabase.from("progression_levels").select("*").order("level_no"),
  ]);
  res.json({
    settings: settings.data,
    offices: offices.data,
    departments: departments.data,
    leave_policies: policies.data,
    levels: levels.data,
  });
});

// ---- everything below is admin only ----
const time = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Use HH:MM");
const settingsSchema = z
  .object({
    work_start: time,
    work_end: time,
    grace_minutes: z.number().int().min(0).max(120),
    weekend_days: z.array(z.number().int().min(0).max(6)),
    points_on_time: z.number().int().min(0),
    points_late: z.number().int().min(0),
  })
  .partial();

router.patch("/", requireManager, async (req: AuthedRequest, res: Response) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.issues[0].message });
  const { data, error } = await supabase
    .from("settings")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", 1)
    .select()
    .single();
  if (error) throw error;
  res.json(data);
});

// Departments
router.post(
  "/departments",
  requireManager,
  async (req: AuthedRequest, res: Response) => {
    const parsed = z.object({ name: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: "name is required" });
    const { data, error } = await supabase
      .from("departments")
      .insert(parsed.data)
      .select()
      .single();
    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(data);
  },
);
router.patch(
  "/departments/:id",
  requireManager,
  async (req: AuthedRequest, res: Response) => {
    const parsed = z.object({ name: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: "name is required" });
    const { data, error } = await supabase
      .from("departments")
      .update(parsed.data)
      .eq("id", req.params.id)
      .select()
      .single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  },
);
router.delete(
  "/departments/:id",
  requireManager,
  async (req: AuthedRequest, res: Response) => {
    const { error } = await supabase
      .from("departments")
      .delete()
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  },
);

// Office locations (check-in point + radius)
const officeSchema = z.object({
  name: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radius_m: z.number().int().min(10).max(5000),
});
router.post(
  "/offices",
  requireManager,
  async (req: AuthedRequest, res: Response) => {
    const parsed = officeSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.issues[0].message });
    const { data, error } = await supabase
      .from("office_locations")
      .insert(parsed.data)
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  },
);
router.patch(
  "/offices/:id",
  requireManager,
  async (req: AuthedRequest, res: Response) => {
    const parsed = officeSchema.partial().safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.issues[0].message });
    const { data, error } = await supabase
      .from("office_locations")
      .update(parsed.data)
      .eq("id", req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  },
);
router.delete(
  "/offices/:id",
  requireManager,
  async (req: AuthedRequest, res: Response) => {
    const { error } = await supabase
      .from("office_locations")
      .delete()
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  },
);

// Leave allowances
router.patch(
  "/leave-policies/:type",
  requireManager,
  async (req: AuthedRequest, res: Response) => {
    const parsed = z
      .object({ days_per_year: z.number().int().min(0).nullable() })
      .safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: "days_per_year must be a number or null" });
    const { data, error } = await supabase
      .from("leave_policies")
      .update(parsed.data)
      .eq("leave_type", req.params.type)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  },
);

// Progression levels (company-defined rules)
const levelSchema = z.object({
  level_no: z.number().int().min(1),
  name: z.string().min(1),
  min_points: z.number().int().min(0),
  min_months: z.number().int().min(0),
});
router.post(
  "/levels",
  requireManager,
  async (req: AuthedRequest, res: Response) => {
    const parsed = levelSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.issues[0].message });
    const { data, error } = await supabase
      .from("progression_levels")
      .insert(parsed.data)
      .select()
      .single();
    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(data);
  },
);
router.patch(
  "/levels/:id",
  requireManager,
  async (req: AuthedRequest, res: Response) => {
    const parsed = levelSchema.partial().safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.issues[0].message });
    const { data, error } = await supabase
      .from("progression_levels")
      .update(parsed.data)
      .eq("id", req.params.id)
      .select()
      .single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  },
);

export default router;
