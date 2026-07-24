import { describe, it, expect, beforeEach } from "vitest";
import { testPrisma } from "../../../setup.integration.js";
import { createFixtures } from "../../../helpers/fixtures.js";
import { jsonPost, jsonPatch } from "../../../helpers/request.js";
import { createTestManagerToken } from "../../../helpers/admin-session.js";

/**
 * Admin can create/edit TIERED milestone quests (milestoneBaseWp + milestoneLadder).
 * Real Hono app + real DB + real manager session. This is the back-office → backend
 * contract for Phase 3 tiered quests.
 */
const fixtures = createFixtures(testPrisma);

let mgr: string;
beforeEach(async () => {
  await testPrisma.questCompletion.deleteMany();
  await testPrisma.quest.deleteMany();
  const admin = await fixtures.createAdmin({ role: "manager" });
  mgr = await createTestManagerToken({ id: admin.id, email: admin.email });
});

describe("POST/PATCH /api/admin/quests (tiered milestone fields)", () => {
  it("creates a tiered REDEEM quest with base + ladder", async () => {
    const res = await jsonPost(
      "/api/admin/quests",
      {
        key: "redeem-milestone",
        title: "Tukar voucher",
        category: "REDEEM",
        rewardWp: 0,
        cadence: "ONCE",
        milestoneBaseWp: 20,
        milestoneLadder: "1,3,5,10",
      },
      mgr,
    );
    expect(res.status).toBe(201);
    const { quest } = await res.json();
    expect(quest.milestoneBaseWp).toBe(20);
    expect(quest.milestoneLadder).toBe("1,3,5,10");
  });

  it("normalises an empty ladder to null (edge)", async () => {
    const res = await jsonPost(
      "/api/admin/quests",
      {
        key: "invite-milestone",
        title: "Undang teman",
        category: "INVITE",
        rewardWp: 0,
        cadence: "ONCE",
        milestoneBaseWp: 50,
        milestoneLadder: "",
      },
      mgr,
    );
    expect(res.status).toBe(201);
    expect((await res.json()).quest.milestoneLadder).toBeNull();
  });

  it("rejects a non-positive milestoneBaseWp (negative)", async () => {
    const res = await jsonPost(
      "/api/admin/quests",
      {
        key: "bad-tier",
        title: "Bad",
        category: "REDEEM",
        rewardWp: 0,
        cadence: "ONCE",
        milestoneBaseWp: 0,
      },
      mgr,
    );
    expect(res.status).toBe(400);
  });

  it("edits an existing quest's base + ladder", async () => {
    const created = await testPrisma.quest.create({
      data: {
        key: "edit-tier",
        title: "Edit",
        category: "REDEEM",
        rewardWp: 0,
        cadence: "ONCE",
      },
    });
    const res = await jsonPatch(
      `/api/admin/quests/${created.id}`,
      { milestoneBaseWp: 30, milestoneLadder: "1,5,10" },
      mgr,
    );
    expect(res.status).toBe(200);
    const { quest } = await res.json();
    expect(quest.milestoneBaseWp).toBe(30);
    expect(quest.milestoneLadder).toBe("1,5,10");
  });
});
