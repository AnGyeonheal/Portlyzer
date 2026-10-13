import { describe, expect, it } from "vitest";
import { databaseConnection, postgresEnvironment, restoreTarget } from "../../scripts/lib/postgres";

const connection = databaseConnection("postgresql://fixture:p%40ss%3Aword@127.0.0.1:5432/source?schema=public&sslmode=require");

describe("PostgreSQL operation boundaries", () => {
  it("passes passwords through the environment, not the command line", () => {
    expect(postgresEnvironment(connection)).toMatchObject({
      PGHOST: "127.0.0.1", PGPORT: "5432", PGUSER: "fixture", PGPASSWORD: "p@ss:word", PGDATABASE: "source", PGSSLMODE: "require",
    });
  });
  it.each(["source", "postgres", "template0", "template1", "", "../backup", "db;DROP", "a".repeat(64), "UPPER"])("rejects unsafe restore target %s", (name) => {
    expect(() => restoreTarget(connection, name)).toThrow();
  });
  it("only changes the database for an explicitly named new target", () => {
    const target = restoreTarget(connection, "portlyzer_restore_123");
    expect(target.pathname).toBe("/portlyzer_restore_123");
    expect(target.password).toBe(connection.password);
    expect(connection.pathname).toBe("/source");
  });
  it.each(["", "not-a-url", "https://fixture:secret@localhost/db", "postgresql://localhost/db",
    "postgresql://u:p@localhost/db?schema=other", "postgresql://u:p@localhost/db?options=unsafe"])("rejects unsupported connections without printing them", (value) => {
    expect(() => databaseConnection(value)).toThrow();
    try { databaseConnection(value); } catch (error) {
      if (value) expect(String(error)).not.toContain(value);
    }
  });
});
