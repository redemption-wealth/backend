/* eslint-disable @typescript-eslint/no-explicit-any */
// QA harness for the Wave-4 back-office-gap admin endpoints. Exercises the REAL
// Hono app via app.request(...) so routing + requireAdmin/requireManager
// (Better-Auth session) + handlers + real Prisma all run.
//   NODE_ENV=development DEV_AUTH_BYPASS=true DEMO_INSTANT_CONFIRM=true
// VERIFICATION only: writes local DB test rows (documented) + toggles nothing.
import "dotenv/config";
import app from "../src/app.js";
import { prisma } from "../src/db.js";
import { adminAdjust } from "../src/services/wp.js";
import bcryptjs from "bcryptjs";

const RUN = `qaW4${Date.now()}`;
const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  :: " + detail : ""}`);
}
const captured: Record<string, any> = {};

type Res = { status: number; body: any };
async function req(
  path: string,
  opts: { method?: string; user?: { id: string; email?: string }; token?: string; body?: any } = {}
): Promise<Res> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.user) {
    headers["x-dev-user-id"] = opts.user.id;
    if (opts.user.email) headers["x-dev-user-email"] = opts.user.email;
  }
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const res = await app.request(`http://local${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: any = null;
  const txt = await res.text();
  try { body = txt ? JSON.parse(txt) : null; } catch { body = txt; }
  return { status: res.status, body };
}

async function createManager(email: string, password: string) {
  const user = await prisma.user.create({ data: { name: "QA W4 Manager", email } });
  await prisma.admin.create({ data: { userId: user.id, role: "MANAGER", isActive: true } });
  await prisma.account.create({
    data: {
      id: `credential-${user.id}`, accountId: user.id, providerId: "credential",
      userId: user.id, password: await bcryptjs.hash(password, 10),
    },
  });
  return user.id;
}

// provision an AppUser via dev-bypass so it has a privyId (can checkin later),
// then return its DB id.
async function provisionAppUser(u: { id: string; email: string }): Promise<string> {
  await req("/api/users/me", { user: u });
  const row = await prisma.appUser.findUnique({ where: { privyId: u.id }, select: { id: true } });
  return row!.id;
}

async function main() {
  // ── Manager login (Better-Auth session bearer) ──
  const mgrEmail = `${RUN}-mgr@qa.local`;
  const mgrPass = "QaPassw0rd!";
  await createManager(mgrEmail, mgrPass);
  let r = await req("/api/auth/sign-in/email", { method: "POST", body: { email: mgrEmail, password: mgrPass } });
  const token = r.body?.token;
  check("AUTH manager login → session token (role MANAGER)",
    r.status === 200 && !!token && r.body?.user?.role === "MANAGER",
    `status=${r.status} role=${r.body?.user?.role}`);

  // ═══ 1. GET /api/admin/app-users (+ /:id) — tiers + enrichment ═══
  const gold = { id: `${RUN}-gold`, email: `${RUN}-gold@dev.local` };
  const silver = { id: `${RUN}-silver`, email: `${RUN}-silver@dev.local` };
  const bronze = { id: `${RUN}-bronze`, email: `${RUN}-bronze@dev.local` };
  const goldId = await provisionAppUser(gold);
  const silverId = await provisionAppUser(silver);
  const bronzeId = await provisionAppUser(bronze);
  await adminAdjust(goldId, 100000, "QA W4 gold");   // >= Gold 100000
  await adminAdjust(silverId, 25000, "QA W4 silver"); // >= Silver 25000
  await adminAdjust(bronzeId, 100, "QA W4 bronze");   // Bronze

  r = await req(`/api/admin/app-users?search=${gold.email}`, { token });
  captured.appUsersList = r.body;
  const goldItem = (r.body?.items ?? []).find((x: any) => x.id === goldId);
  check("1 app-users list: totalEarnedWp + tier Gold + lastActiveAt string",
    r.status === 200 && goldItem?.totalEarnedWp === 100000 && goldItem?.tier === "Gold" &&
      typeof goldItem?.lastActiveAt === "string",
    `earned=${goldItem?.totalEarnedWp} tier=${goldItem?.tier} lastActive=${goldItem?.lastActiveAt}`);

  const rs = await req(`/api/admin/app-users?search=${silver.email}`, { token });
  const silverItem = (rs.body?.items ?? []).find((x: any) => x.id === silverId);
  const rb = await req(`/api/admin/app-users?search=${bronze.email}`, { token });
  const bronzeItem = (rb.body?.items ?? []).find((x: any) => x.id === bronzeId);
  check("1b tier thresholds: Silver@25000, Bronze@100",
    silverItem?.tier === "Silver" && silverItem?.totalEarnedWp === 25000 &&
      bronzeItem?.tier === "Bronze" && bronzeItem?.totalEarnedWp === 100,
    `silver=${silverItem?.tier}(${silverItem?.totalEarnedWp}) bronze=${bronzeItem?.tier}(${bronzeItem?.totalEarnedWp})`);

  r = await req(`/api/admin/app-users/${goldId}`, { token });
  captured.appUserDetail = r.body;
  check("1c app-users/:id detail: fraudReviewStatus present + tier Gold + ledger[]",
    r.status === 200 && r.body?.fraudReviewStatus === "NONE" && r.body?.tier === "Gold" &&
      Array.isArray(r.body?.ledger) && typeof r.body?.totalEarnedWp === "number",
    `fraud=${r.body?.fraudReviewStatus} tier=${r.body?.tier} ledgerN=${r.body?.ledger?.length}`);

  r = await req(`/api/admin/app-users/does-not-exist-xyz`, { token });
  check("1d app-users/:id unknown → 404", r.status === 404, `status=${r.status}`);

  // ═══ 2. GET /api/admin/wp-fraud + PATCH review round-trip ═══
  // Dedicated fraud user with a huge lifetime balance to guarantee top-earner slot.
  const fraudU = { id: `${RUN}-fraud`, email: `${RUN}-fraud@dev.local` };
  const fraudId = await provisionAppUser(fraudU);
  await adminAdjust(fraudId, 9_000_000, "QA W4 fraud whale");

  r = await req("/api/admin/wp-fraud?limit=50", { token });
  captured.fraudReport = r.body;
  const topRow = (r.body?.topEarners ?? []).find((x: any) => x.appUserId === fraudId);
  const summaryOk = r.body?.summary && typeof r.body.summary.topEarnerWp === "number" &&
    typeof r.body.summary.fastest24hWp === "number" && typeof r.body.summary.reviewingCount === "number" &&
    typeof r.body.summary.flaggedCount === "number" && typeof r.body.summary.clearedCount === "number";
  check("2 wp-fraud: topEarners row has reason/fraudReviewStatus/wpIn24h/lastActiveAt + summary{}",
    r.status === 200 && Array.isArray(r.body?.fastEarners) && !!topRow &&
      typeof topRow.reason === "string" && topRow.fraudReviewStatus === "NONE" &&
      typeof topRow.wpIn24h === "number" && ("lastActiveAt" in topRow) && summaryOk,
    `found=${!!topRow} reason=${topRow?.reason} wpIn24h=${topRow?.wpIn24h} summaryOk=${summaryOk}`);
  const flaggedBefore = r.body?.summary?.flaggedCount ?? 0;

  r = await req(`/api/admin/wp-fraud/${fraudId}/review`, { method: "PATCH", token, body: { status: "FLAGGED" } });
  check("2b PATCH review {FLAGGED} → 200 {appUserId,fraudReviewStatus}",
    r.status === 200 && r.body?.appUserId === fraudId && r.body?.fraudReviewStatus === "FLAGGED",
    `status=${r.status} fraud=${r.body?.fraudReviewStatus}`);

  r = await req("/api/admin/wp-fraud?limit=50", { token });
  const topRow2 = (r.body?.topEarners ?? []).find((x: any) => x.appUserId === fraudId);
  const flaggedAfter = r.body?.summary?.flaggedCount ?? 0;
  check("2c re-GET: row fraudReviewStatus FLAGGED + summary.flaggedCount incremented",
    topRow2?.fraudReviewStatus === "FLAGGED" && flaggedAfter === flaggedBefore + 1,
    `rowStatus=${topRow2?.fraudReviewStatus} flagged ${flaggedBefore}→${flaggedAfter}`);

  r = await req(`/api/admin/wp-fraud/${fraudId}/review`, { method: "PATCH", token, body: { status: "BOGUS" } });
  check("2d bad status → 400", r.status === 400, `status=${r.status}`);
  r = await req(`/api/admin/wp-fraud/nope-unknown-id/review`, { method: "PATCH", token, body: { status: "CLEARED" } });
  check("2e unknown user → 404", r.status === 404, `status=${r.status}`);

  // flag must NOT block earning: checkin the flagged user via dev-bypass
  const balBeforeCheckin = (await req("/api/wp/balance", { user: fraudU })).body?.balance;
  r = await req("/api/quests/checkin", { method: "POST", user: fraudU });
  const balAfterCheckin = (await req("/api/wp/balance", { user: fraudU })).body?.balance;
  check("2f FLAGGED user can still earn (checkin credits)",
    r.status === 200 && r.body?.reward >= 1 && balAfterCheckin === balBeforeCheckin + r.body?.reward,
    `reward=${r.body?.reward} bal ${balBeforeCheckin}→${balAfterCheckin}`);

  // ═══ 3. GET /api/admin/analytics/kpi-trends?period=monthly ═══
  r = await req("/api/admin/analytics/kpi-trends?period=monthly", { token });
  captured.kpiTrends = r.body;
  const d = r.body?.data;
  check("3 kpi-trends: data{period,redemptions,confirmedRedemptions,wealthVolume}",
    r.status === 200 && d?.period === "monthly" &&
      typeof d?.redemptions?.current === "number" && typeof d?.redemptions?.previous === "number" &&
      ("deltaPct" in (d?.redemptions ?? {})) &&
      typeof d?.confirmedRedemptions?.current === "number" &&
      typeof d?.wealthVolume?.current === "string" && typeof d?.wealthVolume?.previous === "string",
    `period=${d?.period} red.current=${d?.redemptions?.current} vol.current=${d?.wealthVolume?.current}(${typeof d?.wealthVolume?.current})`);

  // ═══ 4. GET /api/admin/analytics/redemption-sources ═══
  // Fixture: merchant WITH category + a CONFIRMED redemption so a real category surfaces.
  const catMerchant = await prisma.merchant.create({ data: { name: `${RUN}-catM`, category: "Kuliner" } });
  const catVoucher = await prisma.voucher.create({
    data: {
      merchantId: catMerchant.id, title: `${RUN}-catV`, basePrice: 1, totalStock: 1,
      remainingStock: 1, appFeeSnapshot: 0, gasFeeSnapshot: 0,
      startDate: new Date("2020-01-01"), expiryDate: new Date("2030-01-01"),
    },
  });
  const catSlot = await prisma.redemptionSlot.create({ data: { voucherId: catVoucher.id, slotIndex: 0 } });
  await prisma.redemption.create({
    data: {
      userEmail: `${RUN}-cat@dev.local`, voucherId: catVoucher.id, merchantId: catMerchant.id, slotId: catSlot.id,
      wealthAmount: 500, priceIdrAtRedeem: 1, wealthPriceIdrAtRedeem: 1,
      appFeeAmount: 0, gasFeeAmount: 0, idempotencyKey: `${RUN}-cat-${Date.now()}`,
      status: "CONFIRMED", confirmedAt: new Date(),
    },
  });
  r = await req("/api/admin/analytics/redemption-sources", { token });
  captured.redemptionSources = r.body;
  const arr = r.body?.data ?? [];
  const shapeOk = Array.isArray(arr) && arr.every((x: any) =>
    typeof x.categoryName === "string" && typeof x.count === "number" && typeof x.percentage === "number");
  const hasKuliner = arr.some((x: any) => x.categoryName === "Kuliner");
  const nullCat = arr.filter((x: any) => x.categoryName == null).length;
  check("4 redemption-sources: data[] of {categoryName,count,percentage} incl 'Kuliner'",
    r.status === 200 && shapeOk && hasKuliner,
    `n=${arr.length} hasKuliner=${hasKuliner} nullCategoryRows=${nullCat} shapeOk=${shapeOk}`);

  // ═══ 5. GET /api/admin/search?q= ═══
  const searchMerchant = await prisma.merchant.create({ data: { name: `${RUN}-ZebraShop`, category: "Retail" } });
  r = await req(`/api/admin/search?q=${RUN}-Zebra`, { token });
  captured.search = r.body;
  const foundM = (r.body?.merchants ?? []).find((m: any) => m.id === searchMerchant.id);
  check("5 search: merchants[] matches created merchant + users[]/vouchers[] arrays",
    r.status === 200 && !!foundM && Array.isArray(r.body?.users) && Array.isArray(r.body?.vouchers) &&
      typeof foundM.name === "string" && ("isActive" in foundM),
    `foundMerchant=${!!foundM} nMerch=${r.body?.merchants?.length}`);
  // user match by unique email token
  r = await req(`/api/admin/search?q=${RUN}-gold`, { token });
  const foundU = (r.body?.users ?? []).find((u: any) => u.email === gold.email);
  check("5b search matches app user by email",
    r.status === 200 && !!foundU && typeof foundU.email === "string" && ("username" in foundU),
    `foundUser=${!!foundU} nUsers=${r.body?.users?.length}`);

  // ═══ 6. GET /api/admin/notifications ═══
  // Fixtures: a PENDING wpRedemption + a PENDING wpConversion.
  const reward = await prisma.wpReward.create({
    data: { title: `${RUN}-rw`, category: "VOUCHER", wpCost: 100, stock: 50, isActive: true },
  });
  await prisma.wpRedemption.create({ data: { appUserId: goldId, rewardId: reward.id, wpSpent: 100, status: "PENDING" } });
  await prisma.wpConversion.create({
    data: { appUserId: goldId, wpBurned: 1000, wealthAmount: "1.0", rate: 1000, toAddress: "0x" + "a".repeat(40), status: "PENDING" },
  });
  r = await req("/api/admin/notifications", { token });
  captured.notifications = r.body;
  const items = r.body?.items ?? [];
  const hasRed = items.some((i: any) => i.type === "wp_redemption_pending");
  const hasConv = items.some((i: any) => i.type === "wp_conversion_pending");
  const itemShapeOk = items.every((i: any) =>
    typeof i.id === "string" && typeof i.type === "string" && typeof i.title === "string" &&
    typeof i.detail === "string" && typeof i.href === "string" && typeof i.createdAt === "string");
  check("6 notifications: {count,items[]} incl pending redemption + conversion, count===items.length",
    r.status === 200 && typeof r.body?.count === "number" && r.body.count === items.length &&
      hasRed && hasConv && itemShapeOk,
    `count=${r.body?.count} hasRed=${hasRed} hasConv=${hasConv} shapeOk=${itemShapeOk}`);

  // ── Dump captured shapes for contract review ──
  console.log("\n===CAPTURED_W4===");
  console.log(JSON.stringify({
    appUserItem0: captured.appUsersList?.items?.[0],
    appUserDetail: { ...captured.appUserDetail, ledger: `[${captured.appUserDetail?.ledger?.length} entries]` },
    fraudTop0: captured.fraudReport?.topEarners?.[0],
    fraudSummary: captured.fraudReport?.summary,
    kpiTrends: captured.kpiTrends,
    redemptionSources: captured.redemptionSources,
    searchMerchant0: captured.search?.merchants?.[0],
    notificationItem0: captured.notifications?.items?.[0],
    notificationCount: captured.notifications?.count,
  }, null, 2));
  console.log("===END_W4===\n");

  const passed = results.filter((x) => x.pass).length;
  console.log(`\n═══ W4: ${passed}/${results.length} checks passed ═══`);
  const fails = results.filter((x) => !x.pass);
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log(`  - ${f.name} :: ${f.detail}`)); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error("HARNESS ERROR:", e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); process.exit(process.exitCode ?? 0); });
