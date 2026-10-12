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
