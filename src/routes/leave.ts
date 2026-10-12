import { Router, Response } from "express";
import { z } from "zod";
import { supabase } from "../config/supabase";
import { requireAuth, requireManager, AuthedRequest } from "../middleware/auth";
import { getSettings, countWorkingDays } from "../utils/settings";
import { notifyUser, notifyAdmins } from "../utils/notify";

const router = Router();
router.use(requireAuth);

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const createSchema = z.object({
  leave_type: z.enum(["annual", "sick", "emergency", "unpaid"]),
  start_date: date,
  end_date: date,
  reason: z.string().max(500).optional(),
});

// Balance per type for a year: allowance, approved, pending, remaining
async function getBalance(userId: string, year: number) {
  const { data: policies } = await supabase.from("leave_policies").select("*");
  const { data: reqs } = await supabase
    .from("leave_requests")
    .select("leave_type, days, status")
    .eq("user_id", userId)
    .in("status", ["approved", "pending"])
    .gte("start_date", `${year}-01-01`)
    .lte("start_date", `${year}-12-31`);

  return (policies ?? []).map(
    (p: { leave_type: string; days_per_year: number | null }) => {
      const mine = (reqs ?? []).filter(
        (r: { leave_type: string }) => r.leave_type === p.leave_type,
      );
      const approved = mine
        .filter((r: { status: string }) => r.status === "approved")
        .reduce((s: number, r: { days: number }) => s + r.days, 0);
      const pending = mine
        .filter((r: { status: string }) => r.status === "pending")
        .reduce((s: number, r: { days: number }) => s + r.days, 0);
      return {
        leave_type: p.leave_type,
        allowance: p.days_per_year,
        approved,
        pending,
        remaining:
          p.days_per_year === null
            ? null
            : p.days_per_year - approved - pending,
      };
    },
  );
}

router.get("/balance", async (req: AuthedRequest, res: Response) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  res.json(await getBalance(req.user!.id, year));
});

router.post("/", async (req: AuthedRequest, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.issues[0].message });
  const body = parsed.data;
  if (body.end_date < body.start_date) {
    return res
      .status(400)
      .json({ error: "end_date must be on or after start_date" });
  }

  const settings = await getSettings();
  const days = countWorkingDays(
    body.start_date,
    body.end_date,
    settings.weekend_days,
  );
  if (days < 1)
    return res
      .status(400)
      .json({ error: "The selected dates are all weekend days" });

  const year = Number(body.start_date.slice(0, 4));
  const balance = (await getBalance(req.user!.id, year)).find(
    (b) => b.leave_type === body.leave_type,
  );
  if (balance && balance.remaining !== null && days > balance.remaining) {
    return res.status(400).json({
      error: `Not enough ${body.leave_type} leave. Requested ${days}, remaining ${balance.remaining}.`,
    });
  }

  const { data, error } = await supabase
    .from("leave_requests")
    .insert({ ...body, days, user_id: req.user!.id })
    .select()
    .single();
  if (error) throw error;

  await notifyAdmins(
    "Leave request received",
    `${req.user!.full_name} requested ${days} day(s) of ${body.leave_type} leave (${body.start_date} to ${body.end_date}).`,
    "leave_request",
    req.user!.id,
  );
  res.status(201).json(data);
});

router.get("/me", async (req: AuthedRequest, res: Response) => {
  const { data, error } = await supabase
    .from("leave_requests")
    .select("*")
    .eq("user_id", req.user!.id)
    .order("created_at", { ascending: false });
  if (error) throw error;
  res.json(data);
});

// Admin: all requests. Filters: status, user_id
router.get("/", requireManager, async (req: AuthedRequest, res: Response) => {
  let q = supabase
    .from("leave_requests")
    .select(
      "*, profiles!leave_requests_user_id_fkey(full_name, department_id, departments(name))",
    )
    .order("created_at", { ascending: false });
  if (typeof req.query.status === "string")
    q = q.eq("status", req.query.status);
  if (typeof req.query.user_id === "string")
    q = q.eq("user_id", req.query.user_id);
  const { data, error } = await q;
  if (error) throw error;
  res.json(data);
});

// Admin: leave balance for one employee
router.get(
  "/balance/:userId",
  requireManager,
  async (req: AuthedRequest, res: Response) => {
    const year = Number(req.query.year) || new Date().getFullYear();
    res.json(await getBalance(String(req.params.userId), year));
  },
);

router.patch(
  "/:id/review",
  requireManager,
  async (req: AuthedRequest, res: Response) => {
    const parsed = z
      .object({ status: z.enum(["approved", "rejected"]) })
      .safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: "status must be 'approved' or 'rejected'" });

    const id = String(req.params.id);
    const { data: lr } = await supabase
      .from("leave_requests")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (!lr) return res.status(404).json({ error: "Leave request not found" });
    if (lr.status !== "pending")
      return res.status(409).json({ error: "Already reviewed" });

    const { data, error } = await supabase
      .from("leave_requests")
      .update({
        status: parsed.data.status,
        reviewed_by: req.user!.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;

    await notifyUser(
      lr.user_id,
      `Leave request ${parsed.data.status}`,
      `Your ${lr.leave_type} leave (${lr.start_date} to ${lr.end_date}) was ${parsed.data.status}.`,
      "leave_review",
    );
    res.json(data);
  },
);

export default router;
