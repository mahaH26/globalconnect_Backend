import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import attendance from "./routes/attendance";
import leave from "./routes/leave";
import me from "./routes/me";
import employees from "./routes/employees";
import settings from "./routes/settings";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/attendance", attendance);
app.use("/leave", leave);
app.use("/me", me);
app.use("/employees", employees);
app.use("/settings", settings);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

export default app;
