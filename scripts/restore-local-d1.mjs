import { createHash } from "node:crypto";
import { access, cp, mkdir, open, readdir, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const sourceProjectDirectory = process.argv[2];
const targetProjectDirectory = path.resolve(process.argv[3] ?? process.cwd());

if (!sourceProjectDirectory) {
  throw new Error("Pass the extracted ayoub-main directory as the first argument.");
}

const stateRelativePath = path.join(
  ".wrangler",
  "state",
  "v3",
  "d1",
  "miniflare-D1DatabaseObject",
);
const sourceStateDirectory = path.resolve(sourceProjectDirectory, stateRelativePath);
const targetStateDirectory = path.resolve(targetProjectDirectory, stateRelativePath);
const targetParentDirectory = path.dirname(targetStateDirectory);
const lockPath = `${targetStateDirectory}.restore.lock`;
const requiredTables = [
  "admin_accounts",
  "admin_audit_logs",
  "admin_sessions",
  "content_assets",
  "content_overrides",
  "customer_complaints",
  "legal_page_versions",
  "legal_pages",
  "order_items",
  "order_policy_acceptances",
  "orders",
  "products",
  "rate_limits",
  "return_requests",
  "store_settings",
];
const contentOverrideColumns = [
  ["key", "TEXT", 1, 1],
  ["en", "TEXT", 1, 0],
  ["fr", "TEXT", 1, 0],
  ["ar", "TEXT", 1, 0],
  ["updated_at", "TEXT", 1, 0],
];

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function inspectDatabase(filePath) {
  const database = new DatabaseSync(filePath, { readOnly: true });

  try {
    const integrity = database.prepare("PRAGMA integrity_check").get();
    if (integrity?.integrity_check !== "ok") {
      throw new Error(`SQLite integrity check failed for ${filePath}.`);
    }

    const existingTables = new Set(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map(({ name }) => name),
    );
    const missingTables = requiredTables.filter((name) => !existingTables.has(name));
    if (missingTables.length > 0) {
      throw new Error(`The D1 database is missing expected tables (${missingTables.join(", ")}): ${filePath}`);
    }

    const table = database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'content_overrides'")
      .get();
    if (!table) {
      throw new Error(`The D1 database is missing content_overrides: ${filePath}`);
    }

    const columns = database
      .prepare("PRAGMA table_info(content_overrides)")
      .all()
      .map(({ name, type, notnull, pk }) => [name, type.toUpperCase(), notnull, pk]);
    if (JSON.stringify(columns) !== JSON.stringify(contentOverrideColumns)) {
      throw new Error(`content_overrides schema does not match the packaged schema: ${filePath}`);
    }

    const rows = database
      .prepare("SELECT key, en, fr, ar, updated_at FROM content_overrides ORDER BY key")
      .all();
    if (rows.length === 0) {
      throw new Error(`content_overrides has no existing data: ${filePath}`);
    }

    const dataHash = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    return { rowCount: rows.length, dataHash };
  } finally {
    database.close();
  }
}

async function findDatabaseFile(stateDirectory) {
  const files = await readdir(stateDirectory);
  const databases = files.filter((file) => /^[a-f0-9]{64}\.sqlite$/.test(file));
  if (databases.length !== 1) {
    throw new Error(`Expected one packaged D1 database in ${stateDirectory}; found ${databases.length}.`);
  }
  return databases[0];
}

const databaseFile = await findDatabaseFile(sourceStateDirectory);
const sourceDatabasePath = path.join(sourceStateDirectory, databaseFile);
const source = inspectDatabase(sourceDatabasePath);

await mkdir(targetParentDirectory, { recursive: true });
let lock;
try {
  lock = await open(lockPath, "wx");
} catch (error) {
  if (error.code === "EEXIST") {
    throw new Error(`Another local D1 restore is already running (${lockPath}).`);
  }
  throw error;
}

const stagingDirectory = `${targetStateDirectory}.restore-${process.pid}`;

try {
  if (await pathExists(targetStateDirectory)) {
    const targetDatabasePath = path.join(targetStateDirectory, databaseFile);
    if (!(await pathExists(targetDatabasePath))) {
      throw new Error(
        `Existing D1 state at ${targetStateDirectory} is preserved. Its expected database file is missing; inspect it before restoring.`,
      );
    }

    const existing = inspectDatabase(targetDatabasePath);
    console.log(
      `Preserved existing local D1 state (${existing.rowCount} content_overrides rows); no database files were replaced.`,
    );
  } else {
    await cp(sourceStateDirectory, stagingDirectory, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });

    const stagedDatabasePath = path.join(stagingDirectory, databaseFile);
    const restored = inspectDatabase(stagedDatabasePath);
    if (restored.dataHash !== source.dataHash) {
      throw new Error("The staged D1 database does not match the packaged content_overrides data.");
    }

    if (await pathExists(targetStateDirectory)) {
      throw new Error(
        `D1 state appeared during restore at ${targetStateDirectory}; the packaged database was not installed.`,
      );
    }
    await rename(stagingDirectory, targetStateDirectory);
    console.log(
      `Restored packaged local D1 state (${restored.rowCount} content_overrides rows) without applying schema-only migrations.`,
    );
  }
} finally {
  if (await pathExists(stagingDirectory)) {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
  await lock.close();
  await unlink(lockPath);
}
