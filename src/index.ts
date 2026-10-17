import app from "./app";

const port = Number(process.env.PORT) || 4002;
app.listen(port, "0.0.0.0", () => console.log(`API running on port ${port}`));
