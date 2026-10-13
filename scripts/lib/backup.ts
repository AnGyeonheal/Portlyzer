import {
  appendFileSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readSync, rmdirSync, statSync, unlinkSync, writeFileSync, createReadStream, createWriteStream,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { postgresBinary, postgresEnvironment, restoreTarget, runPostgres } from "./postgres";

const magic = Buffer.from("PORTLYZER-BACKUP-1\n");
const headerLength = magic.length + 16 + 12;

export function backupSecret(create = false) {
  if (process.env.BACKUP_PASSPHRASE) {
    if (process.env.BACKUP_PASSPHRASE.length < 32) throw new Error("BACKUP_PASSPHRASE must contain at least 32 characters.");
    return process.env.BACKUP_PASSPHRASE;
  }
  const file = resolve(process.env.BACKUP_KEY_FILE || ".local-state/backup.key");
  if (!existsSync(file) && create) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, randomBytes(48).toString("hex"), { flag: "wx", mode: 0o600 });
    console.info("Created a private backup key. Store BACKUP_KEY_FILE (default .local-state/backup.key) offline, separately from backups.");
  }
  if (!existsSync(file)) throw new Error("Backup key missing. Restore the original BACKUP_KEY_FILE or set the original BACKUP_PASSPHRASE.");
  const secret = readFileSync(file, "utf8").trim();
  if (secret.length < 32 || secret.length > 1024) throw new Error("Invalid backup key file.");
  return secret;
}

export async function backupDatabase(connection: URL, output: string, secret: string) {
  if (secret.length < 32) throw new Error("A backup secret of at least 32 characters is required.");
  const file = resolve(output);
  if (existsSync(file)) throw new Error("Backup output already exists; overwriting is forbidden.");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const partial = `${file}.partial-${randomUUID()}`;
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", scryptSync(secret, salt, 32), iv);
  const header = Buffer.concat([magic, salt, iv]);
  cipher.setAAD(header);
  const outputStream = createWriteStream(partial, { flags: "wx", mode: 0o600 });
  outputStream.write(header);
  const child = spawn(postgresBinary("pg_dump"), ["--format=custom", "--no-owner", "--no-privileges"], {
    env: postgresEnvironment(connection), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  child.stderr.resume();
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new Error("pg_dump could not start. Check PG_BIN.")));
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`pg_dump failed (exit ${code}). Check connectivity and database permissions.`)));
  });
  const writing = pipeline(child.stdout, cipher, outputStream);
  try {
    await Promise.all([writing, completed]);
    appendFileSync(partial, cipher.getAuthTag());
    copyFileSync(partial, file, constants.COPYFILE_EXCL);
    const descriptor = openSync(file, "r+");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    return { file, bytes: statSync(file).size, format: "PORTLYZER-BACKUP-1" };
  } catch (error) {
    if (child.exitCode === null) child.kill();
    outputStream.destroy();
    await Promise.allSettled([writing, completed]);
    throw error;
  } finally {
    if (child.exitCode === null) child.kill();
    outputStream.destroy();
    if (existsSync(partial)) unlinkSync(partial);
  }
}

async function decryptArchive(file: string, output: string, secret: string) {
  const size = statSync(file).size;
  if (size <= headerLength + 16) throw new Error("Backup is truncated or is not a Portlyzer encrypted archive.");
  const descriptor = openSync(file, "r");
  const header = Buffer.alloc(headerLength);
  const tag = Buffer.alloc(16);
  try {
    readSync(descriptor, header, 0, headerLength, 0);
    readSync(descriptor, tag, 0, 16, size - 16);
  } finally { closeSync(descriptor); }
  if (!header.subarray(0, magic.length).equals(magic)) throw new Error("Unsupported backup format.");
  const salt = header.subarray(magic.length, magic.length + 16);
  const iv = header.subarray(magic.length + 16);
  const decipher = createDecipheriv("aes-256-gcm", scryptSync(secret, salt, 32), iv);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  try {
    await pipeline(createReadStream(file, { start: headerLength, end: size - 17 }), decipher,
      createWriteStream(output, { flags: "wx", mode: 0o600 }));
  } catch {
    throw new Error("Backup authentication/decryption failed. Check the original key and archive integrity. No database was created.");
  }
}

export async function restoreDatabase(connection: URL, file: string, database: string, secret: string) {
  const target = restoreTarget(connection, database);
  const directory = mkdtempSync(join(tmpdir(), "portlyzer-restore-"));
  const archive = join(directory, "verified.dump");
  let created = false;
  try {
    await decryptArchive(resolve(file), archive, secret);
    runPostgres("pg_restore", ["--list", archive], connection);
    runPostgres("createdb", ["--maintenance-db=postgres", "--template=template0", database], connection, "postgres");
    created = true;
    runPostgres("pg_restore", ["--dbname", database, "--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction", archive], target);
    const counts = runPostgres("psql", ["--no-psqlrc", "--no-align", "--tuples-only", "--set=ON_ERROR_STOP=1", "--command",
      `SELECT json_build_object('users', (SELECT count(*) FROM "User"), 'transactions', (SELECT count(*) FROM "Transaction"), 'originals', (SELECT count(*) FROM "OriginalTransaction"), 'revisions', (SELECT count(*) FROM "TransactionRevision"));`], target);
    return { database, counts: JSON.parse(counts) as Record<string, number> };
  } catch (error) {
    if (created) throw new Error(`Restore verification failed. The newly created database ${database} was retained for inspection. ${error instanceof Error ? error.message : "Unknown restore error."}`);
    throw error;
  } finally {
    if (existsSync(archive)) unlinkSync(archive);
    rmdirSync(directory);
  }
}
