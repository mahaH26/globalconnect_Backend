import { Router, Response } from "express";
import { supabase } from "../config/supabase";
import { requireAuth, AuthedRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

// GET /notifications            -> latest 50
// GET /notifications?unread=true -> unread only
router.get("/", async (req: AuthedRequest, res: Response) => {
  let q = supabase
    .from("notifications")
    .select("*")
    .eq("user_id", req.user!.id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (req.query.unread === "true") q = q.eq("is_read", false);
  const { data, error } = await q;
  if (error) throw error;
  res.json(data);
});

// Badge number
router.get("/unread-count", async (req: AuthedRequest, res: Response) => {
  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", req.user!.id)
    .eq("is_read", false);
  if (error) throw error;
  res.json({ count: count ?? 0 });
});

router.patch("/read-all", async (req: AuthedRequest, res: Response) => {
  const { error } = await supabase
    .from("notifications")
    .update({ is_read: true })
    .eq("user_id", req.user!.id)
    .eq("is_read", false);
  if (error) throw error;
  res.json({ ok: true });
});

router.patch("/:id/read", async (req: AuthedRequest, res: Response) => {
  const { error } = await supabase
    .from("notifications")
    .update({ is_read: true })
    .eq("id", String(req.params.id))
    .eq("user_id", req.user!.id);
  if (error) throw error;
  res.json({ ok: true });
});

// DELETE /notifications  -> clear all of your notifications
router.delete("/", async (req: AuthedRequest, res: Response) => {
  const { error } = await supabase
    .from("notifications")
    .delete()
    .eq("user_id", req.user!.id);
  if (error) throw error;
  res.json({ ok: true });
});

// DELETE /notifications/:id  -> delete one of your notifications
router.delete("/:id", async (req: AuthedRequest, res: Response) => {
  const { error } = await supabase
    .from("notifications")
    .delete()
    .eq("id", String(req.params.id))
    .eq("user_id", req.user!.id);
  if (error) throw error;
  res.json({ ok: true });
});

export default router;
