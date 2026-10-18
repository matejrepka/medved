import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("snapshot publication and manual buckets are transactional and private", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  for (const name of ["supabase-schema.sql", "migration-006-news-incidents.sql",
    "migration-007-email-notifications.sql", "migration-009-email-digests.sql",
    "migration-011-public-snapshots-buckets.sql"]) {
    await db.exec(await readFile(new URL(`../docs/${name}`, import.meta.url), "utf8"));
  }
  const migration = await readFile(new URL("../docs/migration-011-public-snapshots-buckets.sql", import.meta.url), "utf8");
  await db.exec(migration); // Safe to apply again without erasing links/history.
  const optimization = await readFile(new URL("../supabase/migrations/20261018172624_cache_unchanged_sightings.sql", import.meta.url), "utf8");
  await db.exec(optimization);
  await db.exec(optimization);
  const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
  const revision = () => scalar("select revision from public.public_snapshots where id = 'overview'");
  const publish = rev => scalar("select public.publish_public_snapshot($1, '2026-10-18', $2)",
    [rev, { stats: { report: { totals: { sightings: 2 } } },
      overview: { report: { totals: { sightings: 2 } } }, locations: {} }]);
  const apply = plan => scalar("select public.apply_sighting_bucket_plan($1)", [plan]);

  await db.exec(`insert into public.tumedved_logs(id,location) values ('one','Brezno'),('two','Brezno');
    insert into public.bear_reports(id,location,status) values (42,'Brezno','approved'),(43,'Brezno','pending');`);
  const before = await revision();
  const timestamp = await scalar("select updated_at::text from public.tumedved_logs where id = 'one'");
  await db.exec("insert into public.tumedved_logs(id,location) values ('one','Brezno') on conflict(id) do update set location=excluded.location, scraped_at=now()+interval '1 day', updated_at=now()+interval '1 day'");
  assert.equal(await revision(), before, "An identical import does not invalidate the snapshot");
  assert.equal(await scalar("select updated_at::text from public.tumedved_logs where id = 'one'"), timestamp,
    "Identical imports do not rewrite row timestamps");
  await db.exec("delete from public.news_logs where id = 'not-present'");
  assert.equal(await revision(), before, "An empty write does not invalidate the snapshot");
  assert.equal(await publish(before), true);
  assert.equal((await scalar("select public.read_public_snapshot()" )).report.totals.sightings, 2);
  await db.exec("update public.tumedved_logs set status = 'rejected' where id = 'two'");
  assert.equal(await scalar("select public.read_public_snapshot()"), null, "Old rejected content cannot be served");
  assert.equal(await publish(before), false, "A concurrent edit prevents publishing stale content");
  await db.exec("update public.tumedved_logs set status = 'approved' where id = 'two'");

  const id = "10000000-0000-4000-8000-000000000001";
  const plan = [{ id, primaryKey: "sighting:one", memberKeys: ["sighting:one", "report:42"] }];
  await apply(plan);
  assert.equal(await scalar("select count(*)::int from public.sighting_bucket_members"), 2);
  assert.equal(await scalar("select count(*)::int from public.tumedved_logs"), 2, "Grouping retains original sightings");
  await assert.rejects(apply([{ ...plan[0], memberKeys: ["sighting:one", "report:43"] }]), /Missing approved report/);
  assert.equal(await scalar("select count(*)::int from public.sighting_bucket_members"), 2, "Invalid plans roll back removals");
  await assert.rejects(apply([{ primaryKey: "sighting:two", memberKeys: ["sighting:two", "report:42"] }]), /duplicate key/);
  assert.equal(await scalar("select count(*)::int from public.sighting_buckets"), 1, "Duplicate membership rolls back the whole plan");
  await db.exec("update public.bear_reports set status = 'rejected' where id = 42");
  const rev = await revision();
  assert.equal(await publish(rev), true);
  await db.exec("delete from public.bear_reports where id = 42");
  assert.equal(await scalar("select count(*)::int from public.sighting_bucket_members"), 1, "Deleted members cascade");
  assert.equal(await scalar("select public.read_public_snapshot()"), null);
  const disabled = (await db.query("select tgenabled from pg_trigger where tgname in ('bear_reports_email_notification','tumedved_logs_email_notification','news_logs_email_notification')")).rows;
  assert.equal(disabled.length, 3);
  assert.ok(disabled.every(row => row.tgenabled === "D"), "Paused emails do not enqueue more work");
  await db.exec("set role anon");
  await assert.rejects(db.query("select * from public.public_snapshots"), /permission denied/);
  await assert.rejects(db.query("select public.apply_sighting_bucket_plan('[]')"), /permission denied/);
  await assert.rejects(db.query("select public.read_public_snapshot()"), /permission denied/);
});
