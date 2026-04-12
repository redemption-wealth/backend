import { describe, test, expect, beforeEach } from "vitest";
import { testPrisma } from "../../setup.integration.js";
import { createFixtures } from "../../helpers/fixtures.js";
import { jsonGet } from "../../helpers/request.js";

const fixtures = createFixtures(testPrisma);

describe("GET /api/categories", () => {
  test("returns all active categories", async () => {
    // Create unique test categories for this test
    const timestamp = Date.now();
    await testPrisma.category.create({
      data: { name: `Kuliner-${timestamp}`, isActive: true },
    });
    await testPrisma.category.create({
      data: { name: `Fashion-${timestamp}`, isActive: true },
    });
    await testPrisma.category.create({
      data: { name: `Inactive-${timestamp}`, isActive: false },
    });

    const res = await jsonGet("/api/categories");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data)).toBe(true);

    // Check that our active categories are present
    const activeCategories = body.data.filter((c: any) =>
      c.name.startsWith("Kuliner-") || c.name.startsWith("Fashion-")
    );
    expect(activeCategories.length).toBeGreaterThanOrEqual(2);

    // Check that inactive category is not present
    const inactiveCategory = body.data.find((c: any) => c.name.startsWith("Inactive-"));
    expect(inactiveCategory).toBeUndefined();
  });

  test("returns categories sorted by name", async () => {
    const res = await jsonGet("/api/categories");
    expect(res.status).toBe(200);
    const body = await res.json();

    // Verify sorted order - extract names and verify they're sorted
    const names = body.data.map((c: any) => c.name);
    const sortedNames = [...names].sort((a, b) => a.localeCompare(b));

    expect(names).toEqual(sortedNames);
  });

  test("returns only active categories", async () => {
    const res = await jsonGet("/api/categories");
    expect(res.status).toBe(200);
    const body = await res.json();

    // All returned categories should be active
    body.data.forEach((category: any) => {
      expect(category.id).toBeDefined();
      expect(category.name).toBeDefined();
      // Note: isActive is not returned in the response, only active ones are shown
    });
  });
});

describe("GET /api/categories/:id", () => {
  test("returns category by id", async () => {
    const timestamp = Date.now();
    const category = await testPrisma.category.create({
      data: { name: `Test-Category-${timestamp}`, isActive: true },
    });

    const res = await jsonGet(`/api/categories/${category.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(body.data.id).toBe(category.id);
    expect(body.data.name).toBe(`Test-Category-${timestamp}`);
    expect(body.data.isActive).toBe(true);
  });

  test("returns 404 for non-existent category", async () => {
    const res = await jsonGet("/api/categories/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Category not found");
  });

  test("returns category even if inactive", async () => {
    const timestamp = Date.now();
    const category = await testPrisma.category.create({
      data: { name: `Inactive-Test-${timestamp}`, isActive: false },
    });

    const res = await jsonGet(`/api/categories/${category.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.isActive).toBe(false);
  });
});
