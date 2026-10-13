import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([".next/**", ".local-tools/**", ".local-db/**", ".local-state/**", ".backups/**", ".e2e-state/**", "coverage/**", "playwright-report/**", "test-results/**", "next-env.d.ts"]),
]);
