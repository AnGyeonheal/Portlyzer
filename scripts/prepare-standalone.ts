import { cpSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function prepareStandalone(root = process.cwd()) {
  const standalone = join(root, ".next", "standalone");
  const marker = join(standalone, ".portlyzer-ready.json");
  if (existsSync(marker)) unlinkSync(marker);
  if (!existsSync(join(standalone, "server.js"))) throw new Error("Next standalone output is missing.");
  for (const entry of readdirSync(standalone, { withFileTypes: true })) {
    if (entry.isFile() && /^\.env(?:\.|$)/.test(entry.name)) unlinkSync(join(standalone, entry.name));
    if ([".local-db", ".local-state", ".local-tools", ".backups", ".e2e-state", ".git"].includes(entry.name)) {
      throw new Error("Private local state was included in standalone output. Check file-tracing exclusions.");
    }
  }
  cpSync(join(root, "public"), join(standalone, "public"), { recursive: true });
  cpSync(join(root, ".next", "static"), join(standalone, ".next", "static"), { recursive: true });
  const buildId = readFileSync(join(root, ".next", "BUILD_ID"), "utf8").trim();
  writeFileSync(marker, JSON.stringify({ buildId, preparedAt: new Date().toISOString() }));
  return buildId;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    prepareStandalone();
    console.info("Standalone prepared: public/static assets included; local environment files excluded.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Standalone preparation failed.");
    process.exitCode = 1;
  }
}
