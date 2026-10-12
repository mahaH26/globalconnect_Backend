import { Router, Request, Response } from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { supabase } from "../config/supabase";

const router = Router();

// Separate client with the PUBLISHABLE key, used only to sign users in.
function authClient() {
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!key) throw new Error("SUPABASE_PUBLISHABLE_KEY is missing in .env");
  return createClient(process.env.SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function loadProfile(userId: string) {
  const { data: p } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  if (!p) return null;
  const [dep, lvl] = await Promise.all([
    p.department_id
      ? supabase
          .from("departments")
          .select("name")
          .eq("id", p.department_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    p.level_id
      ? supabase
          .from("progression_levels")
          .select("name, level_no")
          .eq("id", p.level_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  return {
    ...p,
    department_name: dep.data?.name ?? null,
    level: lvl.data ?? null,
  };
}

function session(s: {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
}) {
  return {
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: s.expires_at,
  };
}

router.post("/login", async (req: Request, res: Response) => {
  const parsed = z
    .object({ email: z.string().email(), password: z.string().min(1) })
    .safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: "email and password are required" });

  const { data, error } = await authClient().auth.signInWithPassword(
    parsed.data,
  );
  if (error || !data.session || !data.user) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const profile = await loadProfile(data.user.id);
  if (!profile)
    return res.status(403).json({ error: "No profile for this user" });
  if (["suspended", "terminated"].includes(profile.employment_status)) {
    return res.status(403).json({ error: "Account is disabled" });
  }
  res.json({ ...session(data.session), user: profile });
});

router.post("/refresh", async (req: Request, res: Response) => {
  const parsed = z
    .object({ refresh_token: z.string().min(1) })
    .safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: "refresh_token is required" });

  const { data, error } = await authClient().auth.refreshSession({
    refresh_token: parsed.data.refresh_token,
  });
  if (error || !data.session)
    return res
      .status(401)
      .json({ error: "Session expired, please log in again" });
  res.json(session(data.session));
});

export default router;
