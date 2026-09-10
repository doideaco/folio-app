// Applies src/schema.sql (idempotent) to the configured database.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "../src/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "..", "src", "schema.sql");

const sql = await readFile(schemaPath, "utf8");
await pool.query(sql);
console.log("migrated: schema applied");
await pool.end();
