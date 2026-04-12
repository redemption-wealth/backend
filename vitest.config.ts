import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sharedAlias = {
  "@": path.resolve(__dirname, "./src"),
};

export default defineConfig({
  resolve: { alias: sharedAlias },
  test: {
    projects: [
      {
        resolve: { alias: sharedAlias },
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
          testTimeout: 10_000,
          setupFiles: ["./tests/setup.unit.ts"],
        },
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          globalSetup: "./tests/global-setup.ts",
          setupFiles: ["./tests/setup.integration.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          sequence: { concurrent: false },
        },
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: "e2e",
          include: ["tests/e2e/**/*.test.ts"],
          environment: "node",
          globalSetup: "./tests/global-setup.ts",
          setupFiles: ["./tests/setup.integration.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          sequence: { concurrent: false },
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/**/*.d.ts"],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
    env: {
      ADMIN_JWT_SECRET: "test-secret-min-32-chars-for-vitest-testing",
      NODE_ENV: "test",
      PRIVY_APP_ID: "test-privy-app-id",
      PRIVY_APP_SECRET: "test-privy-app-secret",
    },
  },
});
