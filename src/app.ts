import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { requireAdmin, type AuthEnv } from "./middleware/auth.js";

// Public routes
import authRoutes from "./routes/auth.js";
import merchantRoutes from "./routes/merchants.js";
import voucherRoutes from "./routes/vouchers.js";
import redemptionRoutes from "./routes/redemptions.js";
import transactionRoutes from "./routes/transactions.js";
import priceRoutes from "./routes/price.js";
import webhookRoutes from "./routes/webhook.js";
import categoryRoutes from "./routes/categories.js";

// Admin routes (require admin JWT)
import adminMerchantRoutes from "./routes/admin/merchants.js";
import adminVoucherRoutes from "./routes/admin/vouchers.js";
import adminQrCodeRoutes from "./routes/admin/qr-codes.js";
import adminRedemptionRoutes from "./routes/admin/redemptions.js";
import adminAdminRoutes from "./routes/admin/admins.js";
import adminAnalyticsRoutes from "./routes/admin/analytics.js";
import adminFeeSettingsRoutes from "./routes/admin/fee-settings.js";
import adminSettingsRoutes from "./routes/admin/settings.js";
import adminUploadRoutes from "./routes/admin/upload.js";

const app = new Hono();

// --- Global middleware ---
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin) => {
      const allowed = (process.env.CORS_ORIGINS || "http://localhost:3000,http://localhost:5173").split(",");
      return allowed.includes(origin) ? origin : allowed[0];
    },
    credentials: true,
  })
);

// --- Health check ---
app.get("/api/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() })
);

// --- Public routes ---
app.route("/api/auth", authRoutes);
app.route("/api/merchants", merchantRoutes);
app.route("/api/vouchers", voucherRoutes);
app.route("/api/redemptions", redemptionRoutes);
app.route("/api/transactions", transactionRoutes);
app.route("/api/price", priceRoutes);
app.route("/api/webhook", webhookRoutes);
app.route("/api/categories", categoryRoutes);

// --- Admin routes (protected) ---
const admin = new Hono<AuthEnv>();
admin.use("*", requireAdmin);
admin.route("/merchants", adminMerchantRoutes);
admin.route("/vouchers", adminVoucherRoutes);
admin.route("/qr-codes", adminQrCodeRoutes);
admin.route("/redemptions", adminRedemptionRoutes);
admin.route("/admins", adminAdminRoutes);
admin.route("/analytics", adminAnalyticsRoutes);
admin.route("/fee-settings", adminFeeSettingsRoutes);
admin.route("/settings", adminSettingsRoutes);
admin.route("/upload", adminUploadRoutes);
app.route("/api/admin", admin);

// --- Error handler ---
app.onError((err, c) => {
  console.error(`[Error] ${err.message}`);
  if ("status" in err && typeof err.status === "number") {
    return c.json({ error: err.message }, err.status as 400);
  }
  return c.json({ error: "Internal Server Error" }, 500);
});

export default app;
