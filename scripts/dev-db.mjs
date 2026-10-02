import EmbeddedPostgres from "embedded-postgres";

const PORT = 5438;
const DB_NAME = "star_billing_outreach";

const pg = new EmbeddedPostgres({
  databaseDir: ".pgdata",
  port: PORT,
  user: "postgres",
  password: "postgres",
  authMethod: "password",
  persistent: true,
});

try {
  await pg.initialise();
} catch (err) {
  // data directory already initialised — that's fine
  console.log("[dev-db] data dir already initialised (skipping initdb)");
}

await pg.start();
console.log(`[dev-db] PostgreSQL listening on localhost:${PORT}`);

try {
  await pg.createDatabase(DB_NAME);
  console.log(`[dev-db] database "${DB_NAME}" ready`);
} catch {
  console.log(`[dev-db] database "${DB_NAME}" already exists`);
}

process.on("SIGINT", async () => {
  await pg.stop();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await pg.stop();
  process.exit(0);
});

setInterval(() => {}, 1 << 30);