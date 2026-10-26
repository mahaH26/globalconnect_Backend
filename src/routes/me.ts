import { Router, Response } from "express";
import { createHash } from "crypto";
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
  const updates: Record<string, string | null> = {};

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

  if (req.body?.avatar_url !== undefined) {
    if (req.body.avatar_url === null || req.body.avatar_url === "") {
      updates.avatar_url = null;
    } else {
      const url = String(req.body.avatar_url);
      const prefix = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/`;
      if (!url.startsWith(prefix)) {
        return res.status(400).json({ error: "Invalid image address." });
      }
      updates.avatar_url = url;
    }
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

  if (updates.full_name) {
    await supabase.auth.admin.updateUserById(req.user!.id, {
      user_metadata: {
        full_name: updates.full_name,
        display_name: updates.full_name,
      },
    });
  }

  res.json(data);
});

router.post("/avatar-signature", async (req: AuthedRequest, res: Response) => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    return res.status(500).json({ error: "Image upload is not configured." });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `global-connect/avatars/${req.user!.id}`;
  const toSign = `overwrite=true&public_id=${publicId}&timestamp=${timestamp}`;
  const signature = createHash("sha1")
    .update(toSign + apiSecret)
    .digest("hex");

  res.json({
    cloud_name: cloudName,
    api_key: apiKey,
    timestamp,
    public_id: publicId,
    overwrite: "true",
    signature,
  });
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
