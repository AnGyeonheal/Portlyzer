import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { prepareStandalone } from "../../scripts/prepare-standalone";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "portlyzer-package-test-"));
  roots.push(root);
  for (const path of ["public", ".next/static", ".next/standalone"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, ".next", "BUILD_ID"), "fixture-build");
  writeFileSync(join(root, ".next", "standalone", "server.js"), "// fixture");
  writeFileSync(join(root, ".env"), "SECRET=fixture-only");
  writeFileSync(join(root, ".next", "standalone", ".env"), "SECRET=fixture-only");
  writeFileSync(join(root, "public", "sample.txt"), "public fixture");
  writeFileSync(join(root, ".next", "static", "chunk.js"), "// static fixture");
  return root;
}

describe("deployable standalone packaging", () => {
  it("includes browser assets and removes only generated environment copies", () => {
    const root = fixture();
    expect(prepareStandalone(root)).toBe("fixture-build");
    const standalone = join(root, ".next", "standalone");
    expect(existsSync(join(standalone, ".env"))).toBe(false);
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("SECRET=fixture-only");
    expect(readFileSync(join(standalone, "public", "sample.txt"), "utf8")).toBe("public fixture");
    expect(readFileSync(join(standalone, ".next", "static", "chunk.js"), "utf8")).toBe("// static fixture");
    expect(JSON.parse(readFileSync(join(standalone, ".portlyzer-ready.json"), "utf8")).buildId).toBe("fixture-build");
  });
  it("refuses to mark a package containing private local state as ready", () => {
    const root = fixture();
    const standalone = join(root, ".next", "standalone");
    mkdirSync(join(standalone, ".backups"));
    expect(() => prepareStandalone(root)).toThrow("Private local state");
    expect(existsSync(join(standalone, ".portlyzer-ready.json"))).toBe(false);
  });
});
