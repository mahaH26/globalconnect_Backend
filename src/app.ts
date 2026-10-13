import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import auth from "./routes/auth";
import attendanceSummary from "./routes/attendanceSummary";
import attendance from "./routes/attendance";
import leave from "./routes/leave";
import me from "./routes/me";
import employees from "./routes/employees";
import settings from "./routes/settings";
import dashboard from "./routes/dashboard";
import progression from "./routes/progression";
import notifications from "./routes/notifications";
import chat from "./routes/chat";
const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/auth", auth);
app.use("/attendance", attendanceSummary);
app.use("/attendance", attendance);
app.use("/leave", leave);
app.use("/me", me);
app.use("/employees", employees);
app.use("/settings", settings);
app.use("/dashboard", dashboard);
app.use("/progression", progression);
app.use("/notifications", notifications);
app.use("/chat", chat);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

export default app;
