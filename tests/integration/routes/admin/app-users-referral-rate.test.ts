import { describe, it, expect, beforeEach } from "vitest";
import { testPrisma } from "../../../setup.integration.js";
import { createFixtures } from "../../../helpers/fixtures.js";
import { jsonPatch } from "../../../helpers/request.js";
import { createTestManagerToken } from "../../../helpers/admin-session.js";

/**
 * PATCH /api/admin/app-users/:id/referral-rate — managers set a user's referral
 * commission rate (KOLs get more). Real Hono app + real DB + real Better-Auth
 * manager session. Only Privy (user auth) is stubbed elsewhere; not used here.
 */
const fixtures = createFixtures(testPrisma);

let seq = 0;
async function createAppUser() {
  seq += 1;
  return testPrisma.appUser.create({
    data: { privyId: `privy-rate-${seq}`, email: `rate${seq}@test.local`, referralCode: `RATE${seq}` },
  });
}

let mgrToken: string;
beforeEach(async () => {
  await testPrisma.wpLedger.deleteMany();
  await testPrisma.appUser.deleteMany();
  const admin = await fixtures.createAdmin({ role: "manager" });
  mgrToken = await createTestManagerToken({ id: admin.id, email: admin.email });
});

describe("PATCH /api/admin/app-users/:id/referral-rate", () => {
  it("sets a KOL rate (40%)", async () => {
    const user = await createAppUser();

    const res = await jsonPatch(
      `/api/admin/app-users/${user.id}/referral-rate`,
      { referralRateBps: 4000 },
      mgrToken,
    );

    expect(res.status).toBe(200);
    expect((await res.json()).referralRateBps).toBe(4000);
    const fresh = await testPrisma.appUser.findUnique({ where: { id: user.id } });
    expect(fresh?.referralRateBps).toBe(4000);
    // Audit (Finding 7): who/when is recorded.
    expect(fresh?.referralRateUpdatedBy).toBeTruthy();
    expect(fresh?.referralRateUpdatedAt).toBeInstanceOf(Date);
  });

  it("accepts the boundary values 0 and 10000 (edge)", async () => {
    const user = await createAppUser();
    for (const bps of [0, 10000]) {
      const res = await jsonPatch(
        `/api/admin/app-users/${user.id}/referral-rate`,
        { referralRateBps: bps },
        mgrToken,
      );
      expect(res.status).toBe(200);
      expect((await res.json()).referralRateBps).toBe(bps);
    }
  });

  it("rejects an out-of-range rate (negative)", async () => {
    const user = await createAppUser();
    const res = await jsonPatch(
      `/api/admin/app-users/${user.id}/referral-rate`,
      { referralRateBps: 10001 },
      mgrToken,
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown user (edge)", async () => {
    const res = await jsonPatch(
      `/api/admin/app-users/does-not-exist/referral-rate`,
      { referralRateBps: 2000 },
      mgrToken,
    );
    expect(res.status).toBe(404);
  });

  it("rejects an unauthenticated caller (negative)", async () => {
    const user = await createAppUser();
    const res = await jsonPatch(`/api/admin/app-users/${user.id}/referral-rate`, {
      referralRateBps: 2000,
    });
    expect(res.status).toBe(401);
  });
});
