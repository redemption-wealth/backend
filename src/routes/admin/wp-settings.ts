import { Hono } from "hono";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { requireManager, type AuthEnv } from "../../middleware/auth.js";
import { wpSettingsSchema } from "../../schemas/wp-admin.js";

const adminWpSettings = new Hono<AuthEnv>();
adminWpSettings.use("*", requireManager);

const DEFAULTS = {
  wpMonthlyCapWp: 1_000_000,
  wpConversionEnabled: false,
  wpConversionRate: 1000,
  wpConvertMinWp: 1000,
  wpConvertMaxWpPerMonth: 100_000,
  wpConversionMonthlyBudgetWealth: new Prisma.Decimal(10_000),
  wpReferrerBonusWp: 50,
  wpRefereeWelcomeWp: 50,
};

const SETTINGS_SELECT = {
  wpMonthlyCapWp: true,
  wpConversionEnabled: true,
  wpConversionRate: true,
  wpConvertMinWp: true,
  wpConvertMaxWpPerMonth: true,
  wpConversionMonthlyBudgetWealth: true,
  wpReferrerBonusWp: true,
  wpRefereeWelcomeWp: true,
} as const;

type SettingsRow = {
  wpMonthlyCapWp: number;
  wpConversionEnabled: boolean;
  wpConversionRate: number;
  wpConvertMinWp: number;
  wpConvertMaxWpPerMonth: number;
  wpConversionMonthlyBudgetWealth: Prisma.Decimal;
  wpReferrerBonusWp: number;
  wpRefereeWelcomeWp: number;
};

function shape(s: SettingsRow | null) {
  return {
    wpMonthlyCapWp: s?.wpMonthlyCapWp ?? DEFAULTS.wpMonthlyCapWp,
    wpConversionEnabled: s?.wpConversionEnabled ?? DEFAULTS.wpConversionEnabled,
    wpConversionRate: s?.wpConversionRate ?? DEFAULTS.wpConversionRate,
    wpConvertMinWp: s?.wpConvertMinWp ?? DEFAULTS.wpConvertMinWp,
    wpConvertMaxWpPerMonth:
      s?.wpConvertMaxWpPerMonth ?? DEFAULTS.wpConvertMaxWpPerMonth,
    wpConversionMonthlyBudgetWealth:
      s?.wpConversionMonthlyBudgetWealth ??
      DEFAULTS.wpConversionMonthlyBudgetWealth,
    wpReferrerBonusWp: s?.wpReferrerBonusWp ?? DEFAULTS.wpReferrerBonusWp,
    wpRefereeWelcomeWp: s?.wpRefereeWelcomeWp ?? DEFAULTS.wpRefereeWelcomeWp,
  };
}

// GET /api/admin/wp-settings — WP cockpit settings (monthly cap + conversion).
adminWpSettings.get("/", async (c) => {
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: SETTINGS_SELECT,
  });
  return c.json(shape(settings));
});

// PATCH /api/admin/wp-settings — update any subset of the WP cockpit settings.
adminWpSettings.patch("/", async (c) => {
  const parsed = wpSettingsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }
  const d = parsed.data;
  const data: Prisma.AppSettingsUncheckedCreateInput = { id: "singleton" };
  if (d.wpMonthlyCapWp !== undefined) data.wpMonthlyCapWp = d.wpMonthlyCapWp;
  if (d.wpConversionEnabled !== undefined) data.wpConversionEnabled = d.wpConversionEnabled;
  if (d.wpConversionRate !== undefined) data.wpConversionRate = d.wpConversionRate;
  if (d.wpConvertMinWp !== undefined) data.wpConvertMinWp = d.wpConvertMinWp;
  if (d.wpConvertMaxWpPerMonth !== undefined) data.wpConvertMaxWpPerMonth = d.wpConvertMaxWpPerMonth;
  if (d.wpConversionMonthlyBudgetWealth !== undefined) {
    data.wpConversionMonthlyBudgetWealth = new Prisma.Decimal(
      d.wpConversionMonthlyBudgetWealth
    );
  }
  if (d.wpReferrerBonusWp !== undefined) data.wpReferrerBonusWp = d.wpReferrerBonusWp;
  if (d.wpRefereeWelcomeWp !== undefined) data.wpRefereeWelcomeWp = d.wpRefereeWelcomeWp;

  const settings = await prisma.appSettings.upsert({
    where: { id: "singleton" },
    update: data,
    create: data,
    select: SETTINGS_SELECT,
  });
  return c.json(shape(settings));
});

export default adminWpSettings;
