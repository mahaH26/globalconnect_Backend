import { Router, Response } from "express";
import { z } from "zod";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { supabase } from "../config/supabase";
import { requireAuth, requireManager, AuthedRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth, requireManager);

type Cell = string | number;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const format = z.enum(["json", "xlsx", "pdf"]).default("json");

const clock = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Bahrain",
      })
    : "--:--";

const deptName = (p: any) => {
  const d = Array.isArray(p.departments) ? p.departments[0] : p.departments;
  return d?.name ?? "-";
};

async function send(
  res: Response,
  fmt: "json" | "xlsx" | "pdf",
  title: string,
  fileBase: string,
  columns: string[],
  rows: Cell[][],
) {
  if (fmt === "xlsx") {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(title.slice(0, 31).replace(/[\\/?*[\]:]/g, " "));
    ws.addRow(columns).font = { bold: true };
    rows.forEach((r) => ws.addRow(r));
    ws.columns.forEach((c) => (c.width = 18));
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileBase}.xlsx"`,
    );
    await wb.xlsx.write(res);
    return res.end();
  }

  if (fmt === "pdf") {
    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: 40,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileBase}.pdf"`,
    );
    doc.pipe(res);

    const colW = 762 / columns.length;
    const drawRow = (cells: Cell[], bold = false) => {
      if (doc.y > 530) doc.addPage();
      const y = doc.y;
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8);
      cells.forEach((c, i) =>
        doc.text(String(c), 40 + i * colW, y, {
          width: colW - 6,
          lineBreak: false,
        }),
      );
      doc.y = y + 16;
    };

    doc.font("Helvetica-Bold").fontSize(15).text("Global Connect", 40, 40);
    doc
      .font("Helvetica")
      .fontSize(11)
      .text(title, 40, doc.y + 2);
    doc.moveDown();
    drawRow(columns, true);
    rows.forEach((r) => drawRow(r));
    doc.moveDown();
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .text(`Total records: ${rows.length}`, 40);
    doc.end();
    return;
  }

  res.json({ title, columns, rows, total: rows.length });
}

const TITLES = {
  attendance: "Attendance report",
  late: "Late-arrival report",
  absence: "Absence report",
  overtime: "Overtime report",
};

const ATTENDANCE_COLUMNS = [
  "Employee",
  "Department",
  "Date",
  "Status",
  "Check in",
  "Check out",
  "Overtime (min)",
  "Early checkout",
];

const attendanceQuery = z.object({
  type: z
    .enum(["attendance", "late", "absence", "overtime"])
    .default("attendance"),
  from: date,
  to: date,
  user_id: z.string().uuid().optional(),
  department_id: z.string().uuid().optional(),
  format,
});

router.get("/attendance", async (req: AuthedRequest, res: Response) => {
  const parsed = attendanceQuery.safeParse(req.query);
  if (!parsed.success || parsed.data.to < parsed.data.from)
    return res
      .status(400)
      .json({ error: "Valid from and to dates are required" });
  const { type, from, to, user_id, department_id, format: fmt } = parsed.data;

  let pq = supabase.from("profiles").select("id, full_name, departments(name)");
  if (user_id) pq = pq.eq("id", user_id);
  if (department_id) pq = pq.eq("department_id", department_id);
  const { data: people, error: pErr } = await pq;
  if (pErr) return res.status(500).json({ error: pErr.message });

  const byId = new Map<string, { name: string; dept: string }>();
  for (const p of (people ?? []) as any[])
    byId.set(p.id, { name: p.full_name, dept: deptName(p) });

  let records: any[] = [];
  if (byId.size) {
    let q = supabase
      .from("attendance")
      .select(
        "user_id, work_date, status, check_in, check_out, early_checkout, overtime_minutes",
      )
      .in("user_id", [...byId.keys()])
      .gte("work_date", from)
      .lte("work_date", to)
      .order("work_date", { ascending: true })
      .limit(5000);
    if (type === "late") q = q.eq("status", "late");
    if (type === "absence") q = q.eq("status", "absent");
    if (type === "overtime") q = q.gt("overtime_minutes", 0);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    records = data ?? [];
  }

  const rows: Cell[][] = records.map((r) => {
    const p = byId.get(r.user_id);
    return [
      p?.name ?? "Unknown",
      p?.dept ?? "-",
      String(r.work_date),
      r.status,
      clock(r.check_in),
      clock(r.check_out),
      r.overtime_minutes ?? 0,
      r.early_checkout ? "Yes" : "No",
    ];
  });

  await send(
    res,
    fmt,
    `${TITLES[type]} (${from} to ${to})`,
    `${type}-report`,
    ATTENDANCE_COLUMNS,
    rows,
  );
});

const PROGRESSION_COLUMNS = [
  "Employee",
  "Department",
  "Position",
  "Current level",
  "Points",
  "Months in company",
  "Next level",
  "Points needed",
  "Months needed",
  "Eligible",
  "Last promotion",
];

const progressionQuery = z.object({
  user_id: z.string().uuid().optional(),
  department_id: z.string().uuid().optional(),
  format,
});

function monthsSince(joining: string | null) {
  if (!joining) return 0;
  const j = new Date(joining);
  const n = new Date();
  let m =
    (n.getUTCFullYear() - j.getUTCFullYear()) * 12 +
    (n.getUTCMonth() - j.getUTCMonth());
  if (n.getUTCDate() < j.getUTCDate()) m--;
  return Math.max(0, m);
}

router.get("/progression", async (req: AuthedRequest, res: Response) => {
  const parsed = progressionQuery.safeParse(req.query);
  if (!parsed.success)
    return res.status(400).json({ error: "Invalid filters" });
  const { user_id, department_id, format: fmt } = parsed.data;

  const { data: levels, error: lErr } = await supabase
    .from("progression_levels")
    .select("id, level_no, name, min_points, min_months")
    .order("level_no");
  if (lErr) return res.status(500).json({ error: lErr.message });
  const byLevelId = new Map((levels ?? []).map((l: any) => [l.id, l]));
  const byLevelNo = new Map((levels ?? []).map((l: any) => [l.level_no, l]));

  let pq = supabase
    .from("profiles")
    .select(
      "id, full_name, position, joining_date, attendance_points, level_id, departments(name)",
    )
    .order("full_name");
  if (user_id) pq = pq.eq("id", user_id);
  if (department_id) pq = pq.eq("department_id", department_id);
  const { data: people, error: pErr } = await pq;
  if (pErr) return res.status(500).json({ error: pErr.message });

  const ids = (people ?? []).map((p: any) => p.id);
  const lastPromotion = new Map<string, string>();
  if (ids.length) {
    const { data: hist } = await supabase
      .from("progression")
      .select("user_id, effective_date")
      .in("user_id", ids)
      .order("effective_date", { ascending: false });
    for (const h of (hist ?? []) as any[])
      if (!lastPromotion.has(h.user_id))
        lastPromotion.set(h.user_id, String(h.effective_date));
  }

  const rows: Cell[][] = ((people ?? []) as any[]).map((p) => {
    const current: any = p.level_id ? byLevelId.get(p.level_id) : null;
    const next: any = byLevelNo.get((current?.level_no ?? 0) + 1) ?? null;
    const points = p.attendance_points ?? 0;
    const months = monthsSince(p.joining_date);
    const eligible = next
      ? points >= next.min_points && months >= next.min_months
        ? "Yes"
        : "No"
      : "Top level";
    return [
      p.full_name,
      deptName(p),
      p.position ?? "-",
      current?.name ?? "-",
      points,
      months,
      next?.name ?? "-",
      next?.min_points ?? "-",
      next?.min_months ?? "-",
      eligible,
      lastPromotion.get(p.id) ?? "-",
    ];
  });

  await send(
    res,
    fmt,
    "Employee progression report",
    "progression-report",
    PROGRESSION_COLUMNS,
    rows,
  );
});

export default router;
