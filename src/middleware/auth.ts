import { Request, Response, NextFunction } from "express";
import { supabase } from "../config/supabase";

export interface AuthedRequest extends Request {
  user?: { id: string; role: string; full_name: string };
}

export async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing token" });
  }

  const { data, error } = await supabase.auth.getUser(header.slice(7));
  if (error || !data.user) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, role, full_name, employment_status")
    .eq("id", data.user.id)
    .maybeSingle();

  if (!profile)
    return res.status(403).json({ error: "No profile for this user" });
  if (["suspended", "terminated"].includes(profile.employment_status)) {
    return res.status(403).json({ error: "Account is disabled" });
  }

  req.user = {
    id: profile.id,
    role: profile.role,
    full_name: profile.full_name,
  };
  next();
}

export function requireManager(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Admins only" });
  }
  next();
}
