import "dotenv/config";
import { serve } from "@hono/node-server";
import app from "./app.js";

const port = parseInt(process.env.PORT || "3001");

console.log(`Backend API running on http://localhost:${port}`);

serve({ fetch: app.fetch, port });
