import { Router, Response } from "express";
import { z } from "zod";
import { supabase } from "../config/supabase";
import { requireAuth, requireManager, AuthedRequest } from "../middleware/auth";
import { getSettings, localNow } from "../utils/settings";
import { notifyUser, notifyAdmins } from "../utils/notify";
import { computeProgress, getLevels, getProgress } from "../utils/progression";

const router = Router();
router.use(requireAuth);

async function overview(userId: string) {
  const [progress, history, milestones] = await Promise.all([
    getProgress(userId),
    supabase
      .from("progression")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false }),
    supabase
      .from("milestones")
      .select("*")
      .eq("user_id", userId)
      .order("achieved_on", { ascending: false }),
  ]);
  if (history.error) throw history.error;
  if (milestones.error) throw milestones.error;
  return { progress, history: history.data, milestones: milestones.data };
}

// My progress: level, points, eligibility, history, milestones
router.get("/me", async (req: AuthedRequest, res: Response) => {
  res.json(await overview(req.user!.id));
});

// ---- admin only ----

// Everyone, with progress (for the Progression screen)
router.get(
  "/employees",
  requireManager,
  async (req: AuthedRequest, res: Response) => {
    const [levels, settings, staff] = await Promise.all([
      getLevels(),
      getSettings(),
      supabase
        .from("profiles")
        .select(
          "id, full_name, position, attendance_points, level_id, level_since",
        )
        .in("employment_status", ["active", "probation"])
        .order("full_name"),
    ]);
    if (staff.error) throw staff.error;
    const today = localNow(settings).date;
    const rows = (staff.data ?? []).map(
      (p: {
        id: string;
        full_name: string;
        position: string | null;
        attendance_points: number;
        level_id: string | null;
        level_since: string;
      }) => ({
        id: p.id,
        full_name: p.full_name,
        position: p.position,
        ...computeProgress(p, levels, today),
      }),
    );
    const eligibleOnly = req.query.eligible === "true";
    res.json(eligibleOnly ? rows.filter((r) => r.eligible) : rows);
  },
);

router.get(
  "/employees/:id",
  requireManager,
  async (req: AuthedRequest, res: Response) => {
    const result = await overview(String(req.params.id));
    if (!result.progress)
      return res.status(404).json({ error: "Employee not found" });
    res.json(result);
  },
);

// Promote to the next level (must be eligible unless force=true)
router.post(
  "/promote/:id",
  requireManager,
  async (req: AuthedRequest, res: Response) => {
    const parsed = z
      .object({
        force: z.boolean().optional(),
        notes: z.string().max(500).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });
    const id = String(req.params.id);

    const progress = await getProgress(id);
    if (!progress) return res.status(404).json({ error: "Employee not found" });
    if (!progress.next_level)
      return res.status(409).json({ error: "Already at the highest level" });
    if (!progress.eligible && !parsed.data.force) {
      return res
        .status(409)
        .json({ error: "Employee is not eligible yet", progress });
    }

    const settings = await getSettings();
    const today = localNow(settings).date;
    const next = progress.next_level;

    const { error } = await supabase
      .from("profiles")
      .update({ level_id: next.id, level_since: today })
      .eq("id", id);
    if (error) throw error;

    const { data: entry, error: hErr } = await supabase
      .from("progression")
      .insert({
        user_id: id,
        kind: "promotion",
        title: `Promoted to ${next.name}`,
        notes: parsed.data.notes ?? null,
        from_level_id: progress.current_level?.id ?? null,
        to_level_id: next.id,
        effective_date: today,
        created_by: req.user!.id,
      })
      .select()
      .single();
    if (hErr) throw hErr;

    await notifyUser(
      id,
      "You have been promoted",
      `Congratulations! You are now ${next.name}.`,
      "promotion",
    );
    res.status(201).json(entry);
  },
);

// Record a milestone
router.post(
  "/milestones/:id",
  requireManager,
  async (req: AuthedRequest, res: Response) => {
    const parsed = z
      .object({
        title: z.string().min(1).max(120),
        description: z.string().max(500).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: "title is required" });
    const id = String(req.params.id);

    const { data: who } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", id)
      .maybeSingle();
    if (!who) return res.status(404).json({ error: "Employee not found" });

    const { data, error } = await supabase
      .from("milestones")
      .insert({
        user_id: id,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        created_by: req.user!.id,
      })
      .select()
      .single();
    if (error) throw error;

    await supabase.from("progression").insert({
      user_id: id,
      kind: "milestone",
      title: parsed.data.title,
      notes: parsed.data.description ?? null,
      created_by: req.user!.id,
    });
    await notifyUser(id, "Milestone reached", parsed.data.title, "milestone");
    await notifyAdmins(
      "Milestone reached",
      `${who.full_name}: ${parsed.data.title}`,
      "milestone",
      id,
    );
    res.status(201).json(data);
  },
);

export default router;
