// Seeds a dev user and a board so the app has something on first launch.
import { pool } from "../src/db.js";

const user = (
  await pool.query(
    `INSERT INTO users (apple_sub, handle, display_name) VALUES ('dev:alex','alex','Alex')
     ON CONFLICT (apple_sub) DO UPDATE SET handle = EXCLUDED.handle RETURNING *`
  )
).rows[0];

const board = (
  await pool.query(
    `INSERT INTO boards (owner_id, name, emoji, kind) VALUES ($1,'Dinners','🍝','shared') RETURNING *`,
    [user.id]
  )
).rows[0];

await pool.query(
  `INSERT INTO board_members (board_id, user_id, role) VALUES ($1,$2,'owner')
   ON CONFLICT DO NOTHING`,
  [board.id, user.id]
);

console.log(`seeded user ${user.handle} (${user.id}) and board ${board.name} (${board.id})`);
await pool.end();
