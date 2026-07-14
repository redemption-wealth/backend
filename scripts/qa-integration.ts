/* eslint-disable @typescript-eslint/no-explicit-any */
// QA end-to-end integration harness. Exercises the REAL Hono app via
// app.request(...) so routing + requireUser (dev-bypass) + requireManager
// (Better-Auth) + handlers + real Prisma all run. Env is set by the runner:
//   NODE_ENV=development DEV_AUTH_BYPASS=true DEMO_INSTANT_CONFIRM=true
//
// This is a VERIFICATION harness: it writes only local DB test rows + a
// deposit fixture (documented) and toggles wpConversion settings. It does NOT
// touch feature code.
import "dotenv/config";
import app from "../src/app.js";
import { prisma } from "../src/db.js";
import { adminAdjust } from "../src/services/wp.js";
import bcryptjs from "bcryptjs";
import { randomBytes } from "node:crypto";

const RUN = `qa${Date.now()}`;
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

// ── Deposit fixture: insert a CONFIRMED Redemption row for an email so the
//    email-keyed hasDeposited gate flips (same approach as scripts/wp-smoke.ts).
const fixtureMerchants: string[] = [];
async function seedConfirmedDeposit(email: string, wealth = 1000) {
  const mname = `${RUN}-dep-${fixtureMerchants.length}`;
  fixtureMerchants.push(mname);
  const merchant = await prisma.merchant.create({ data: { name: mname } });
  const voucher = await prisma.voucher.create({
    data: {
      merchantId: merchant.id, title: `${mname}-v`, basePrice: 1, totalStock: 1,
      remainingStock: 1, appFeeSnapshot: 0, gasFeeSnapshot: 0,
      startDate: new Date("2020-01-01"), expiryDate: new Date("2030-01-01"),
    },
  });
  const slot = await prisma.redemptionSlot.create({ data: { voucherId: voucher.id, slotIndex: 0 } });
  await prisma.redemption.create({
    data: {
      userEmail: email, voucherId: voucher.id, merchantId: merchant.id, slotId: slot.id,
      wealthAmount: wealth, priceIdrAtRedeem: 1, wealthPriceIdrAtRedeem: 1,
      appFeeAmount: 0, gasFeeAmount: 0, idempotencyKey: `${mname}-${Date.now()}`,
      status: "CONFIRMED", confirmedAt: new Date(),
    },
  });
}

async function createManager(email: string, password: string) {
  const user = await prisma.user.create({ data: { name: "QA Manager", email } });
  await prisma.admin.create({ data: { userId: user.id, role: "MANAGER", isActive: true } });
  await prisma.account.create({
    data: {
      id: `credential-${user.id}`, accountId: user.id, providerId: "credential",
      userId: user.id, password: await bcryptjs.hash(password, 10),
    },
  });
  return user.id;
}

async function main() {
  // ═══ USER-SIDE (dev-bypass) ═══
  const u1 = { id: `${RUN}-u1`, email: `${RUN}-u1@dev.local` };
  const u2 = { id: `${RUN}-u2`, email: `${RUN}-u2@dev.local` };

  // 1. GET /api/users/me → provisions user, returns {user} w/ referralCode
  let r = await req("/api/users/me", { user: u1 });
  captured.usersMe = r.body;
  const u1Referral = r.body?.user?.referralCode;
  check("1 users/me provisions user + referralCode",
    r.status === 200 && !!r.body?.user?.referralCode && r.body.user.hasDeposited === false,
    `status=${r.status} referral=${u1Referral} hasDeposited=${r.body?.user?.hasDeposited}`);

  // 2. GET /api/quests → balance + checkin + quests (incl milestone progress/target)
  r = await req("/api/quests", { user: u1 });
  captured.quests = r.body;
  const milestone = (r.body?.quests ?? []).find((q: any) => q.key === "redeem-3-times");
  check("2 quests returns balance+checkin+quests",
    r.status === 200 && typeof r.body?.balance === "number" && !!r.body?.checkin && Array.isArray(r.body?.quests),
    `status=${r.status} balance=${r.body?.balance} nQuests=${r.body?.quests?.length}`);
  check("2b milestone quest exposes progress/target",
    milestone && typeof milestone.progress === "number" && typeof milestone.target === "number",
    `redeem-3-times progress=${milestone?.progress} target=${milestone?.target}`);

  // 3. checkin twice
  r = await req("/api/quests/checkin", { method: "POST", user: u1 });
  const firstCheckin = r.body;
  check("3 checkin credits + streak",
    r.status === 200 && r.body?.alreadyCheckedIn === false && r.body?.reward >= 1 && r.body?.streak >= 1,
    `reward=${r.body?.reward} streak=${r.body?.streak} balance=${r.body?.balance}`);
  r = await req("/api/quests/checkin", { method: "POST", user: u1 });
  check("3b second checkin same day → alreadyCheckedIn",
    r.status === 200 && r.body?.alreadyCheckedIn === true && r.body?.reward === 0,
    `alreadyCheckedIn=${r.body?.alreadyCheckedIn} reward=${r.body?.reward}`);

  // 4. claim a claimable quest twice
  r = await req("/api/quests/social-follow-x/claim", { method: "POST", user: u1 });
  const claimReward = r.body?.reward;
  check("4 claim quest credits",
    r.status === 200 && r.body?.alreadyClaimed === false && r.body?.reward > 0,
    `reward=${r.body?.reward} balance=${r.body?.balance}`);
  r = await req("/api/quests/social-follow-x/claim", { method: "POST", user: u1 });
  check("4b re-claim → alreadyClaimed",
    r.status === 200 && r.body?.alreadyClaimed === true,
    `alreadyClaimed=${r.body?.alreadyClaimed}`);

  // 5. referral + attribution via sync
  r = await req("/api/referral", { user: u1 });
  captured.referral = r.body;
  check("5 referral returns code+stats+friends",
    r.status === 200 && r.body?.referralCode === u1Referral && !!r.body?.stats && Array.isArray(r.body?.friends),
    `code=${r.body?.referralCode} friendsJoined=${r.body?.stats?.friendsJoined}`);
  // provision u2 with u1's referralCode
  r = await req("/api/quests/sync", { method: "POST", user: u2, body: { referralCode: u1Referral } });
  check("5b u2 sync with referralCode provisions u2",
    r.status === 200 && !!r.body?.appUser?.referralCode,
    `status=${r.status} u2code=${r.body?.appUser?.referralCode}`);
  // verify attribution in DB (referredById set-once) + via u1 referral friends
  const u2row = await prisma.appUser.findUnique({ where: { privyId: u2.id }, select: { id: true, referredById: true } });
  const u1row = await prisma.appUser.findUnique({ where: { privyId: u1.id }, select: { id: true } });
  check("5c u2.referredById == u1",
    !!u2row?.referredById && u2row.referredById === u1row?.id,
    `u2.referredById=${u2row?.referredById} u1.id=${u1row?.id}`);
  r = await req("/api/referral", { user: u1 });
  check("5d u1 referral friends now shows 1 (unqualified)",
    r.body?.stats?.friendsJoined === 1 && r.body?.friends?.[0]?.qualified === false,
    `friendsJoined=${r.body?.stats?.friendsJoined} qualified=${r.body?.friends?.[0]?.qualified}`);

  // 6. Deposit gate
  r = await req("/api/wp/balance", { user: u1 });
  check("6 wp/balance hasDeposited:false before deposit",
    r.status === 200 && r.body?.hasDeposited === false,
    `hasDeposited=${r.body?.hasDeposited} balance=${r.body?.balance}`);
  await seedConfirmedDeposit(u1.email, 1000); // FIXTURE: CONFIRMED Redemption row via Prisma
  r = await req("/api/quests/sync", { method: "POST", user: u1 });
  check("6b after deposit fixture + re-sync → hasDeposited flips (sync body)",
    r.status === 200 && r.body?.appUser?.hasDeposited === true,
    `hasDeposited=${r.body?.appUser?.hasDeposited}`);
  r = await req("/api/wp/balance", { user: u1 });
  check("6c wp/balance hasDeposited:true",
    r.body?.hasDeposited === true, `hasDeposited=${r.body?.hasDeposited}`);

  // 7. rewards catalog + redeem
  r = await req("/api/rewards", { user: u1 });
  captured.rewards = r.body;
  const rewards = r.body?.rewards ?? [];
  check("7 rewards catalog returned", r.status === 200 && rewards.length > 0, `n=${rewards.length}`);
  const reward = rewards.slice().sort((a: any, b: any) => a.wpCost - b.wpCost)[0];
  // Grant enough WP via ADMIN_ADJUST fixture (not subject to monthly cap)
  await adminAdjust(u1row!.id, 50000, "QA grant");
  const stockBefore = reward.stock;
  const balBefore = (await req("/api/wp/balance", { user: u1 })).body.balance;
  r = await req(`/api/rewards/${reward.id}/redeem`, { method: "POST", user: u1 });
  const redemptionId = r.body?.redemption?.id;
  check("7b redeem affordable reward → 201 PENDING",
    r.status === 201 && r.body?.redemption?.status === "PENDING" && r.body?.redemption?.wpSpent === reward.wpCost,
    `status=${r.status} redStatus=${r.body?.redemption?.status} wpSpent=${r.body?.redemption?.wpSpent}`);
  const balAfter = (await req("/api/wp/balance", { user: u1 })).body.balance;
  const rewardAfter = await prisma.wpReward.findUnique({ where: { id: reward.id }, select: { stock: true } });
  check("7c WP spent + stock decremented",
    balAfter === balBefore - reward.wpCost && (stockBefore === null || rewardAfter?.stock === stockBefore - 1),
    `balΔ=${balBefore - balAfter} stock ${stockBefore}→${rewardAfter?.stock}`);

  // 8. wp/redemptions — appears, note null while PENDING
  r = await req("/api/wp/redemptions", { user: u1 });
  captured.wpRedemptions = r.body;
  const myRed = (r.body?.redemptions ?? []).find((x: any) => x.id === redemptionId);
  check("8 wp/redemptions shows redemption, fulfillmentNote null while PENDING",
    r.status === 200 && !!myRed && myRed.status === "PENDING" && myRed.fulfillmentNote === null,
    `status=${myRed?.status} note=${JSON.stringify(myRed?.fulfillmentNote)}`);

  // 9. ledger — signs
  r = await req("/api/wp/ledger", { user: u1 });
  captured.ledger = r.body;
  const entries = r.body?.entries ?? [];
  const checkinE = entries.find((e: any) => e.type === "CHECKIN");
  const taskE = entries.find((e: any) => e.type === "TASK");
  const spendE = entries.find((e: any) => e.type === "REDEEM_SPEND");
  check("9 ledger has CHECKIN(+)/TASK(+)/REDEEM_SPEND(-) with correct signs",
    r.status === 200 && checkinE?.amount > 0 && taskE?.amount > 0 && spendE?.amount < 0,
    `checkin=${checkinE?.amount} task=${taskE?.amount} spend=${spendE?.amount}`);

  // ═══ ADMIN (real HTTP manager login via Better-Auth) ═══
  const mgrEmail = `${RUN}-mgr@qa.local`;
  const mgrPass = "QaPassw0rd!";
  await createManager(mgrEmail, mgrPass);
  r = await req("/api/auth/sign-in/email", { method: "POST", body: { email: mgrEmail, password: mgrPass } });
  const token = r.body?.token;
  check("A0 manager HTTP login returns session token",
    r.status === 200 && !!token && r.body?.user?.role === "MANAGER",
    `status=${r.status} role=${r.body?.user?.role} tokenLen=${token?.length}`);

  // d. wp-settings round-trip + ENABLE conversion (do it via admin PATCH)
  r = await req("/api/admin/wp-settings", { token });
  const settingsBefore = r.body;
  check("D wp-settings GET round-trips",
    r.status === 200 && typeof r.body?.wpMonthlyCapWp === "number",
    `cap=${r.body?.wpMonthlyCapWp} convEnabled=${r.body?.wpConversionEnabled}`);
  r = await req("/api/admin/wp-settings", { method: "PATCH", token, body: {
    wpMonthlyCapWp: 2_000_000, wpConversionEnabled: true, wpConversionRate: 1000,
    wpConvertMinWp: 1000, wpConvertMaxWpPerMonth: 100000, wpConversionMonthlyBudgetWealth: 100000,
  }});
  check("D2 wp-settings PATCH persists cap + conversion knobs",
    r.status === 200 && r.body?.wpMonthlyCapWp === 2_000_000 && r.body?.wpConversionEnabled === true && r.body?.wpConvertMinWp === 1000,
    `cap=${r.body?.wpMonthlyCapWp} enabled=${r.body?.wpConversionEnabled} min=${r.body?.wpConvertMinWp}`);

  // 10. conversion (user)
  r = await req("/api/wp/convert-info", { user: u1 });
  captured.convertInfo = r.body;
  check("10 convert-info enabled + limits",
    r.status === 200 && r.body?.enabled === true && r.body?.rate === 1000 && r.body?.minWp === 1000 && typeof r.body?.remainingWpThisMonth === "number",
    `enabled=${r.body?.enabled} rate=${r.body?.rate} min=${r.body?.minWp} remaining=${r.body?.remainingWpThisMonth}`);
  const toAddr = "0x" + "a".repeat(40);
  const convBalBefore = (await req("/api/wp/balance", { user: u1 })).body.balance;
  r = await req("/api/wp/convert", { method: "POST", user: u1, body: { wpAmount: 5000, toAddress: toAddr } });
  const convId = r.body?.conversion?.id;
  captured.convertResp = r.body;
  check("10b convert → 201 PENDING (WP burned)",
    r.status === 201 && r.body?.conversion?.status === "PENDING" && r.body?.conversion?.wpBurned === 5000,
    `status=${r.status} convStatus=${r.body?.conversion?.status} wealthAmount=${r.body?.conversion?.wealthAmount}(${typeof r.body?.conversion?.wealthAmount})`);
  const convBalAfter = (await req("/api/wp/balance", { user: u1 })).body.balance;
  const spendLedger = (await req("/api/wp/ledger", { user: u1 })).body.entries.find((e: any) => e.type === "CONVERT_SPEND");
  check("10c WP burned via CONVERT_SPEND",
    convBalAfter === convBalBefore - 5000 && spendLedger?.amount === -5000,
    `balΔ=${convBalBefore - convBalAfter} ledger=${spendLedger?.amount}`);
  // guard: below-min → 400
  r = await req("/api/wp/convert", { method: "POST", user: u1, body: { wpAmount: 500, toAddress: toAddr } });
  check("10d convert below-min → 400", r.status === 400, `status=${r.status} err=${r.body?.error}`);
  // guard: disabled → 409 (toggle off, try, toggle back)
  await req("/api/admin/wp-settings", { method: "PATCH", token, body: { wpConversionEnabled: false } });
  r = await req("/api/wp/convert", { method: "POST", user: u1, body: { wpAmount: 2000, toAddress: toAddr } });
  check("10e convert disabled → 409", r.status === 409, `status=${r.status} err=${r.body?.error}`);
  await req("/api/admin/wp-settings", { method: "PATCH", token, body: { wpConversionEnabled: true } });
  // guard: not-enough-WP → 400 (fresh deposited user, 0 balance)
  const u3 = { id: `${RUN}-u3`, email: `${RUN}-u3@dev.local` };
  await req("/api/users/me", { user: u3 });
  await seedConfirmedDeposit(u3.email, 1000);
  await req("/api/quests/sync", { method: "POST", user: u3 });
  r = await req("/api/wp/convert", { method: "POST", user: u3, body: { wpAmount: 1000, toAddress: toAddr } });
  check("10f convert not-enough-WP → 400", r.status === 400 && /cukup/i.test(r.body?.error ?? ""), `status=${r.status} err=${r.body?.error}`);

  // 11. PATCH users/me + username collision 409
  const uname = `${RUN}user`;
  r = await req("/api/users/me", { method: "PATCH", user: u1, body: { name: "Wisnu QA", username: uname, phone: "0812345678" } });
  check("11 PATCH users/me updates profile",
    r.status === 200 && r.body?.user?.name === "Wisnu QA" && r.body?.user?.username === uname && r.body?.user?.phone === "0812345678",
    `name=${r.body?.user?.name} username=${r.body?.user?.username}`);
  r = await req("/api/users/me", { method: "PATCH", user: u2, body: { username: uname } });
  check("11b second user same username → 409 'Username sudah dipakai'",
    r.status === 409 && /sudah dipakai/i.test(r.body?.error ?? ""), `status=${r.status} err=${r.body?.error}`);

  // ═══ CROSS-ROLE ═══
  // a. redeem → fulfill → user sees note
  r = await req(`/api/admin/wp-redemptions/${redemptionId}`, { method: "PATCH", token, body: { status: "FULFILLED", fulfillmentNote: "KODE-TEST-123" } });
  check("Aa admin fulfill redemption",
    r.status === 200 && r.body?.redemption?.status === "FULFILLED" && r.body?.redemption?.fulfillmentNote === "KODE-TEST-123",
    `status=${r.body?.redemption?.status} note=${r.body?.redemption?.fulfillmentNote}`);
  r = await req("/api/wp/redemptions", { user: u1 });
  const fulfilledRow = (r.body?.redemptions ?? []).find((x: any) => x.id === redemptionId);
  check("Aa2 user sees FULFILLED + note",
    fulfilledRow?.status === "FULFILLED" && fulfilledRow?.fulfillmentNote === "KODE-TEST-123",
    `status=${fulfilledRow?.status} note=${fulfilledRow?.fulfillmentNote}`);

  // b. convert → approve → user sees FULFILLED; also reject→refund on a 2nd conversion
  r = await req("/api/admin/wp-conversions?status=PENDING", { token });
  captured.adminConversions = r.body;
  const listed = (r.body?.conversions ?? []).find((x: any) => x.id === convId);
  check("Ab admin lists pending conversion",
    r.status === 200 && !!listed && listed.status === "PENDING",
    `found=${!!listed} wealthAmount=${listed?.wealthAmount}(${typeof listed?.wealthAmount})`);
  r = await req(`/api/admin/wp-conversions/${convId}`, { method: "PATCH", token, body: { status: "FULFILLED", txHash: "0xfeedface" } });
  check("Ab2 admin fulfill conversion w/ txHash",
    r.status === 200 && r.body?.conversion?.status === "FULFILLED" && r.body?.conversion?.txHash === "0xfeedface",
    `status=${r.body?.conversion?.status} txHash=${r.body?.conversion?.txHash}`);
  r = await req("/api/wp/conversions", { user: u1 });
  captured.userConversions = r.body;
  const uConv = (r.body?.conversions ?? []).find((x: any) => x.id === convId);
  check("Ab3 user sees FULFILLED + txHash",
    uConv?.status === "FULFILLED" && uConv?.txHash === "0xfeedface",
    `status=${uConv?.status} txHash=${uConv?.txHash} wealthAmount=${uConv?.wealthAmount}(${typeof uConv?.wealthAmount})`);
  // reject → refund on a 2nd conversion
  const balPreConv2 = (await req("/api/wp/balance", { user: u1 })).body.balance;
  r = await req("/api/wp/convert", { method: "POST", user: u1, body: { wpAmount: 3000, toAddress: toAddr } });
  const conv2Id = r.body?.conversion?.id;
  const balMidConv2 = (await req("/api/wp/balance", { user: u1 })).body.balance;
  r = await req(`/api/admin/wp-conversions/${conv2Id}`, { method: "PATCH", token, body: { status: "REJECTED", note: "alamat salah" } });
  const balPostConv2 = (await req("/api/wp/balance", { user: u1 })).body.balance;
  const refundLedger = (await req("/api/wp/ledger", { user: u1 })).body.entries.find((e: any) => e.type === "CONVERT_REFUND");
  check("Ab4 reject conversion refunds WP (CONVERT_REFUND)",
    r.status === 200 && r.body?.conversion?.status === "REJECTED" && balMidConv2 === balPreConv2 - 3000 && balPostConv2 === balPreConv2 && refundLedger?.amount === 3000,
    `pre=${balPreConv2} mid=${balMidConv2} post=${balPostConv2} refundLedger=${refundLedger?.amount}`);

  // c. wp-overview reflects pending counts
  r = await req("/api/admin/wp-overview", { token });
  captured.overview = r.body;
  check("Ac wp-overview returns coherent counts",
    r.status === 200 && typeof r.body?.pendingRedemptions === "number" && typeof r.body?.pendingConversions === "number" && typeof r.body?.totalWpOutstanding === "number" && r.body?.monthlyCapWp > 0,
    `pendRed=${r.body?.pendingRedemptions} pendConv=${r.body?.pendingConversions} outstanding=${r.body?.totalWpOutstanding} cap=${r.body?.monthlyCapWp}`);

  // Restore prior settings (leave conversion state documented)
  await req("/api/admin/wp-settings", { method: "PATCH", token, body: {
    wpMonthlyCapWp: settingsBefore.wpMonthlyCapWp,
    wpConversionEnabled: settingsBefore.wpConversionEnabled,
    wpConversionRate: settingsBefore.wpConversionRate,
    wpConvertMinWp: settingsBefore.wpConvertMinWp,
    wpConvertMaxWpPerMonth: settingsBefore.wpConvertMaxWpPerMonth,
    wpConversionMonthlyBudgetWealth: settingsBefore.wpConversionMonthlyBudgetWealth,
  }});

  // ── Dump captured shapes for contract check ──
  console.log("\n===CAPTURED_SHAPES===");
  console.log(JSON.stringify({
    usersMe: captured.usersMe,
    convertInfo: captured.convertInfo,
    userConversion0: captured.userConversions?.conversions?.[0],
    wpRedemption0: captured.wpRedemptions?.redemptions?.[0],
    questMilestone: (captured.quests?.quests ?? []).find((q: any) => q.key === "redeem-3-times"),
    questSocial: (captured.quests?.quests ?? []).find((q: any) => q.key === "social-follow-x"),
    ledger0: captured.ledger?.entries?.[0],
    overview: captured.overview,
    adminConversion0: captured.adminConversions?.conversions?.[0],
  }, null, 2));
  console.log("===END_CAPTURED===\n");

  const passed = results.filter((x) => x.pass).length;
  console.log(`\n═══ ${passed}/${results.length} checks passed ═══`);
  const fails = results.filter((x) => !x.pass);
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log(`  - ${f.name} :: ${f.detail}`)); }
}

main()
  .catch((e) => { console.error("HARNESS ERROR:", e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); process.exit(process.exitCode ?? 0); });
