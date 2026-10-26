import { Router, Response } from "express";
import { z } from "zod";
import { supabase } from "../config/supabase";
import { requireAuth, requireManager, AuthedRequest } from "../middleware/auth";
import { notifyUser } from "../utils/notify";

const router = Router();
router.use(requireAuth, requireManager);

const SELECT = "*, departments(name), progression_levels(name, level_no)";
const statusEnum = z.enum(["active", "probation", "suspended", "terminated"]);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

router.get("/", async (req: AuthedRequest, res: Response) => {
  let q = supabase.from("profiles").select(SELECT).order("full_name");
  const { department_id, status, search } = req.query;
  if (typeof department_id === "string")
    q = q.eq("department_id", department_id);
  if (typeof status === "string") q = q.eq("employment_status", status);
  if (typeof search === "string" && search)
    q = q.ilike("full_name", `%${search}%`);
  const { data, error } = await q;
  if (error) throw error;
  res.json(data);
});

const createSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  full_name: z.string().min(1),
  department_id: z.string().uuid().optional(),
  position: z.string().optional(),
  phone: z.string().optional(),
  joining_date: dateStr.optional(),
  last_working_date: dateStr.optional(),
  employment_status: statusEnum.optional(),
  role: z.enum(["employee", "admin"]).default("employee"),
});

router.post("/", async (req: AuthedRequest, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.issues[0].message });
  const { email, password, role, ...profile } = parsed.data;

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: profile.full_name,
      display_name: profile.full_name,
    },
  });
  if (error) return res.status(400).json({ error: error.message });

  const { error: upErr } = await supabase
    .from("profiles")
    .upsert(
      { id: data.user.id, email, ...profile, role },
      { onConflict: "id" },
    );
  if (upErr) {
    await supabase.auth.admin.deleteUser(data.user.id);
    return res.status(400).json({ error: upErr.message });
  }
  res.status(201).json({ id: data.user.id, email });
});

router.get("/:id", async (req: AuthedRequest, res: Response) => {
  const { data, error } = await supabase
    .from("profiles")
    .select(SELECT)
    .eq("id", req.params.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: "Employee not found" });
  res.json(data);
});

const updateSchema = z
  .object({
    full_name: z.string().min(1),
    department_id: z.string().uuid().nullable(),
    position: z.string().nullable(),
    phone: z.string().nullable(),
    joining_date: dateStr,
    last_working_date: dateStr.nullable(),
    employment_status: statusEnum,
    role: z.enum(["employee", "admin"]),
  })
  .partial();

async function setLoginEnabled(userId: string, enabled: boolean) {
  await supabase.auth.admin.updateUserById(userId, {
    ban_duration: enabled ? "none" : "876000h",
  });
}

router.patch("/:id", async (req: AuthedRequest, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.issues[0].message });
  const id = String(req.params.id);
  const changes = parsed.data;

  if (id === req.user!.id && (changes.role || changes.employment_status)) {
    return res
      .status(400)
      .json({ error: "You can't change your own role or status" });
  }

  const { data, error } = await supabase
    .from("profiles")
    .update(changes)
    .eq("id", id)
    .select(SELECT)
    .maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: "Employee not found" });

  if (changes.full_name) {
    await supabase.auth.admin.updateUserById(id, {
      user_metadata: {
        full_name: changes.full_name,
        display_name: changes.full_name,
      },
    });
  }

  if (changes.employment_status) {
    await setLoginEnabled(
      id,
      !["suspended", "terminated"].includes(changes.employment_status),
    );
  }
  res.json(data);
});

router.post("/:id/password", async (req: AuthedRequest, res: Response) => {
  const parsed = z.object({ password: z.string().min(8) }).safeParse(req.body);
  if (!parsed.success)
    return res
      .status(400)
      .json({ error: "Password must be at least 8 characters" });
  const { error } = await supabase.auth.admin.updateUserById(
    String(req.params.id),
    { password: parsed.data.password },
  );
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

router.delete("/:id", async (req: AuthedRequest, res: Response) => {
  const id = String(req.params.id);
  if (id === req.user!.id)
    return res.status(400).json({ error: "You can't remove yourself" });
  const { error } = await supabase
    .from("profiles")
    .update({ employment_status: "terminated" })
    .eq("id", id);
  if (error) throw error;
  await setLoginEnabled(id, false);
  res.json({ ok: true });
});

router.get("/:id/progression", async (req: AuthedRequest, res: Response) => {
  const { data, error } = await supabase
    .from("progression")
    .select("*")
    .eq("user_id", req.params.id)
    .order("effective_date", { ascending: false });
  if (error) throw error;
  res.json(data);
});

router.post("/:id/progression", async (req: AuthedRequest, res: Response) => {
  const parsed = z
    .object({ title: z.string().min(1), notes: z.string().optional() })
    .safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: "title is required" });
  const { data, error } = await supabase
    .from("progression")
    .insert({
      ...parsed.data,
      user_id: req.params.id,
      created_by: req.user!.id,
    })
    .select()
    .single();
  if (error) throw error;
  await notifyUser(
    String(req.params.id),
    "Progression update",
    parsed.data.title,
    "progression",
  );
  res.status(201).json(data);
});

export default router;
