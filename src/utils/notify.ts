import { supabase } from "../config/supabase";

export async function notifyUser(
  userId: string,
  title: string,
  body: string,
  type = "general",
  relatedUserId?: string,
) {
  await supabase.from("notifications").insert({
    user_id: userId,
    title,
    body,
    type,
    related_user_id: relatedUserId ?? null,
  });
}

// Sends the same notification to every active admin (except the person it is about)
export async function notifyAdmins(
  title: string,
  body: string,
  type: string,
  relatedUserId?: string,
) {
  let q = supabase
    .from("profiles")
    .select("id")
    .eq("role", "admin")
    .in("employment_status", ["active", "probation"]);
  if (relatedUserId) q = q.neq("id", relatedUserId);
  const { data: admins } = await q;
  if (!admins?.length) return;
  await supabase.from("notifications").insert(
    admins.map((a: { id: string }) => ({
      user_id: a.id,
      title,
      body,
      type,
      related_user_id: relatedUserId ?? null,
    })),
  );
}
