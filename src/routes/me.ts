import { Router, Response } from "express";
import { supabase } from "../config/supabase";
import { requireAuth, AuthedRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

router.get("/", async (req: AuthedRequest, res: Response) => {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", req.user!.id)
    .single();
  if (error) throw error;
  res.json(data);
});

router.patch("/", async (req: AuthedRequest, res: Response) => {
  const updates: Record<string, string> = {};

  if (req.body?.full_name !== undefined) {
    const fullName = String(req.body.full_name).trim().replace(/\s+/g, " ");
    if (fullName.length < 2 || fullName.length > 60) {
      return res
        .status(400)
        .json({ error: "Name must be 2 to 60 characters." });
    }
    updates.full_name = fullName;
  }

  if (req.body?.email !== undefined) {
    const { data: me, error: meError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", req.user!.id)
      .single();
    if (meError) throw meError;
    if (me?.role !== "admin") {
      return res
        .status(403)
        .json({ error: "Only admins can change their email." });
    }

    const email = String(req.body.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }

    const { error: authError } = await supabase.auth.admin.updateUserById(
      req.user!.id,
      { email, email_confirm: true },
    );
    if (authError) return res.status(400).json({ error: authError.message });
    updates.email = email;
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: "Nothing to update." });
  }

  const { data, error } = await supabase
    .from("profiles")
    .update(updates)
    .eq("id", req.user!.id)
    .select()
    .single();
  if (error) throw error;
  res.json(data);
});

router.get("/progression", async (req: AuthedRequest, res: Response) => {
  const { data, error } = await supabase
    .from("progression")
    .select("*")
    .eq("user_id", req.user!.id)
    .order("effective_date", { ascending: false });
  if (error) throw error;
  res.json(data);
});

router.get("/notifications", async (req: AuthedRequest, res: Response) => {
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("user_id", req.user!.id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  res.json(data);
});

router.patch(
  "/notifications/:id/read",
  async (req: AuthedRequest, res: Response) => {
    const { error } = await supabase
      .from("notifications")
      .update({ is_read: true })
      .eq("id", req.params.id)
      .eq("user_id", req.user!.id);
    if (error) throw error;
    res.json({ ok: true });
  },
);

export default router;
