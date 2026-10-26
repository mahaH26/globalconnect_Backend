import { Router, Response } from "express";
import { z } from "zod";
import { supabase } from "../config/supabase";
import { requireAuth, AuthedRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

const uuid = z.string().uuid();

async function isMember(conversationId: string, userId: string) {
  const { data } = await supabase
    .from("conversation_members")
    .select("user_id")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
}

router.get("/people", async (req: AuthedRequest, res: Response) => {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, role, avatar_url")
    .neq("id", req.user!.id)
    .order("full_name");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get("/conversations", async (req: AuthedRequest, res: Response) => {
  const me = req.user!;
  const { data: mine, error } = await supabase
    .from("conversation_members")
    .select("conversation_id, last_read_at")
    .eq("user_id", me.id);
  if (error) return res.status(500).json({ error: error.message });

  const ids = (mine ?? []).map((m) => m.conversation_id);
  if (!ids.length) return res.json([]);

  const [convs, members, msgs] = await Promise.all([
    supabase.from("conversations").select("id, type, name").in("id", ids),
    supabase
      .from("conversation_members")
      .select("conversation_id, user_id, profiles(full_name, avatar_url)")
      .in("conversation_id", ids),
    supabase
      .from("messages")
      .select("conversation_id, sender_id, body, created_at")
      .in("conversation_id", ids)
      .order("created_at", { ascending: false })
      .limit(2000),
  ]);
  if (convs.error) return res.status(500).json({ error: convs.error.message });

  const readAt = new Map(mine!.map((m) => [m.conversation_id, m.last_read_at]));

  const out = (convs.data ?? []).map((c) => {
    const mem = ((members.data ?? []) as any[]).filter(
      (m) => m.conversation_id === c.id,
    );
    const cm = (msgs.data ?? []).filter((m) => m.conversation_id === c.id);
    const last = cm[0];
    const since = readAt.get(c.id) ?? "";
    const other = mem.find((m) => m.user_id !== me.id);
    const otherProfile: any = Array.isArray(other?.profiles)
      ? other.profiles[0]
      : other?.profiles;
    return {
      id: c.id,
      type: c.type,
      name:
        c.type === "group" ? c.name : (otherProfile?.full_name ?? "Unknown"),
      avatar_url:
        c.type === "direct" ? (otherProfile?.avatar_url ?? null) : null,
      member_count: mem.length,
      last_message: last?.body ?? null,
      last_at: last?.created_at ?? null,
      unread: cm.filter((m) => m.sender_id !== me.id && m.created_at > since)
        .length,
    };
  });
  out.sort((a, b) => (b.last_at ?? "").localeCompare(a.last_at ?? ""));
  res.json(out);
});

const createSchema = z.object({
  user_ids: z.array(z.string().uuid()).min(1).max(50),
  name: z.string().trim().min(1).max(80).optional(),
});

router.post("/conversations", async (req: AuthedRequest, res: Response) => {
  const me = req.user!;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: "Pick at least one person" });

  const ids = [...new Set(parsed.data.user_ids)].filter((id) => id !== me.id);
  if (!ids.length)
    return res.status(400).json({ error: "Pick at least one other person" });

  const { data: found } = await supabase
    .from("profiles")
    .select("id")
    .in("id", ids);
  if ((found ?? []).length !== ids.length)
    return res.status(400).json({ error: "One or more users do not exist" });

  if (ids.length === 1 && !parsed.data.name) {
    const key = [me.id, ids[0]].sort().join(":");
    const { data: existing } = await supabase
      .from("conversations")
      .select("id, type, name")
      .eq("direct_key", key)
      .maybeSingle();
    if (existing) return res.json(existing);

    const { data: conv, error } = await supabase
      .from("conversations")
      .insert({ type: "direct", direct_key: key, created_by: me.id })
      .select("id, type, name")
      .single();
    if (error) return res.status(500).json({ error: error.message });

    const { error: mErr } = await supabase
      .from("conversation_members")
      .insert(
        [me.id, ids[0]].map((u) => ({ conversation_id: conv.id, user_id: u })),
      );
    if (mErr) return res.status(500).json({ error: mErr.message });
    return res.status(201).json(conv);
  }

  if (!parsed.data.name)
    return res.status(400).json({ error: "Group name is required" });

  const { data: conv, error } = await supabase
    .from("conversations")
    .insert({ type: "group", name: parsed.data.name, created_by: me.id })
    .select("id, type, name")
    .single();
  if (error) return res.status(500).json({ error: error.message });

  const { error: mErr } = await supabase
    .from("conversation_members")
    .insert(
      [me.id, ...ids].map((u) => ({ conversation_id: conv.id, user_id: u })),
    );
  if (mErr) return res.status(500).json({ error: mErr.message });
  res.status(201).json(conv);
});

router.get(
  "/conversations/:id/messages",
  async (req: AuthedRequest, res: Response) => {
    const me = req.user!;
    const id = uuid.safeParse(String(req.params.id));
    if (!id.success) return res.status(400).json({ error: "Invalid id" });
    if (!(await isMember(id.data, me.id)))
      return res
        .status(403)
        .json({ error: "You are not in this conversation" });

    const { data: conv } = await supabase
      .from("conversations")
      .select("id, type, name, created_by")
      .eq("id", id.data)
      .maybeSingle();

    const { data: msgs, error } = await supabase
      .from("messages")
      .select("id, sender_id, body, created_at")
      .eq("conversation_id", id.data)
      .order("created_at", { ascending: true })
      .limit(300);
    if (error) return res.status(500).json({ error: error.message });

    const { data: members } = await supabase
      .from("conversation_members")
      .select("user_id, profiles(full_name, avatar_url)")
      .eq("conversation_id", id.data);

    const names = new Map<string, string>();
    const avatars = new Map<string, string | null>();
    for (const m of (members ?? []) as any[]) {
      const p = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles;
      names.set(m.user_id, p?.full_name ?? "Unknown");
      avatars.set(m.user_id, p?.avatar_url ?? null);
    }

    await supabase
      .from("conversation_members")
      .update({ last_read_at: new Date().toISOString() })
      .eq("conversation_id", id.data)
      .eq("user_id", me.id);

    res.json({
      conversation: conv,
      members: [...names.entries()].map(([user_id, full_name]) => ({
        user_id,
        full_name,
        avatar_url: avatars.get(user_id) ?? null,
      })),
      messages: (msgs ?? []).map((m) => ({
        ...m,
        sender_name: names.get(m.sender_id) ?? "Former member",
      })),
    });
  },
);

router.post(
  "/conversations/:id/messages",
  async (req: AuthedRequest, res: Response) => {
    const me = req.user!;
    const id = uuid.safeParse(String(req.params.id));
    const body = z
      .object({ body: z.string().trim().min(1).max(2000) })
      .safeParse(req.body);
    if (!id.success || !body.success)
      return res
        .status(400)
        .json({ error: "Message must be 1 to 2000 characters" });
    if (!(await isMember(id.data, me.id)))
      return res
        .status(403)
        .json({ error: "You are not in this conversation" });

    const { data, error } = await supabase
      .from("messages")
      .insert({
        conversation_id: id.data,
        sender_id: me.id,
        body: body.data.body,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  },
);

router.post(
  "/conversations/:id/members",
  async (req: AuthedRequest, res: Response) => {
    const me = req.user!;
    const id = uuid.safeParse(String(req.params.id));
    const body = z
      .object({ user_ids: z.array(z.string().uuid()).min(1).max(50) })
      .safeParse(req.body);
    if (!id.success || !body.success)
      return res.status(400).json({ error: "Pick at least one person" });

    const { data: conv } = await supabase
      .from("conversations")
      .select("id, type, created_by")
      .eq("id", id.data)
      .maybeSingle();
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    if (conv.type !== "group")
      return res
        .status(400)
        .json({ error: "Only groups can have new members" });
    if (conv.created_by !== me.id && me.role !== "admin")
      return res
        .status(403)
        .json({ error: "Only the group creator or an admin can add people" });

    const { error } = await supabase.from("conversation_members").upsert(
      [...new Set(body.data.user_ids)].map((u) => ({
        conversation_id: id.data,
        user_id: u,
      })),
      { onConflict: "conversation_id,user_id", ignoreDuplicates: true },
    );
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  },
);

router.delete(
  "/conversations/:id/members/me",
  async (req: AuthedRequest, res: Response) => {
    const id = uuid.safeParse(String(req.params.id));
    if (!id.success) return res.status(400).json({ error: "Invalid id" });

    const { data: conv } = await supabase
      .from("conversations")
      .select("type")
      .eq("id", id.data)
      .maybeSingle();
    if (!conv || conv.type !== "group")
      return res.status(400).json({ error: "You can only leave groups" });

    const { error } = await supabase
      .from("conversation_members")
      .delete()
      .eq("conversation_id", id.data)
      .eq("user_id", req.user!.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  },
);

export default router;
