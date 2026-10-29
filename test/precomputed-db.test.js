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
  await db.exec(await readFile(new URL("../supabase/migrations/20261018184716_record_detail_documents.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../supabase/migrations/20261018185139_record_publish_safe_updates.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../supabase/migrations/20261022094010_optimize_snapshot_publication.sql", import.meta.url), "utf8"));
  const keySetMigration = await readFile(new URL("../supabase/migrations/20261029084849_materialize_snapshot_record_keys.sql", import.meta.url), "utf8");
  await db.exec(keySetMigration);
  await db.exec(keySetMigration);
  const budgetMigration = await readFile(new URL("../supabase/migrations/20261029085858_budget_snapshot_publication.sql", import.meta.url), "utf8");
  await db.exec(budgetMigration);
  await db.exec(budgetMigration);
  const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
  const publicationSettings = await scalar("select proconfig from pg_proc where oid = 'public.publish_public_snapshot(bigint,date,jsonb)'::regprocedure");
  assert.ok(publicationSettings.includes("statement_timeout=30s"), "Background publication gets its own bounded API timeout");
  assert.ok(publicationSettings.includes("work_mem=16MB"), "The multi-megabyte record map fits in working memory");
  const sessionSettings = () => scalar("select jsonb_build_array(current_setting('statement_timeout'),current_setting('work_mem'))");
  const beforeSettings = await sessionSettings();
  const revision = () => scalar("select revision from public.public_snapshots where id = 'overview'");
  const publish = (rev, records = { "warning:one": { record: { id: "one" } } }) => scalar("select public.publish_public_snapshot($1, '2026-10-18', $2)",
    [rev, { stats: { report: { totals: { sightings: 2 } } },
      overview: { report: { totals: { sightings: 2 } } }, locations: {},
      records }]);
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
  assert.deepEqual(await sessionSettings(), beforeSettings, "Publication settings do not change other requests");
  assert.equal((await scalar("select public.read_public_snapshot('record','warning:one')")).record.id, "one");
  assert.equal(await scalar("select public.read_public_snapshot('record','warning:missing')"), null);
  assert.equal((await scalar("select public.read_public_snapshot()" )).report.totals.sightings, 2);
  const recordVersion = await scalar("select xmin::text from public.public_record_snapshots where record_key = 'warning:one'");
  assert.equal(await publish(before), true);
  assert.equal(await scalar("select xmin::text from public.public_record_snapshots where record_key = 'warning:one'"), recordVersion,
    "Identical record documents are not rewritten");
  await assert.rejects(publish(before, null), /Invalid public snapshot/);
  assert.equal((await scalar("select public.read_public_snapshot('record','warning:one')")).record.id, "one",
    "Invalid payloads retain the published documents");
  assert.equal(await publish(before, { "warning:two": { record: { id: "two" } } }), true);
  assert.equal(await scalar("select public.read_public_snapshot('record','warning:one')"), null,
    "Records absent from the new snapshot are removed");
  assert.equal((await scalar("select public.read_public_snapshot('record','warning:two')")).record.id, "two");
  await publish(before);
  await db.exec("update public.tumedved_logs set status = 'rejected' where id = 'two'");
  assert.equal(await scalar("select public.read_public_snapshot()"), null, "Old rejected content cannot be served");
  assert.equal(await scalar("select public.read_public_snapshot('record','warning:one')"), null, "Details follow the same revision guard");
  assert.equal(await publish(before, {}), false, "A concurrent edit prevents publishing stale content");
  assert.equal(await scalar("select count(*)::int from public.public_record_snapshots"), 1,
    "A stale publisher cannot remove the saved record documents");
  await db.exec("update public.tumedved_logs set status = 'approved' where id = 'two'");

  await t.test("large record maps retain unchanged rows and atomically replace removed records", async () => {
    const current = await revision();
    const records = Object.fromEntries(Array.from({ length: 1800 }, (_, i) =>
      [`warning:large-${i}`, { record: { id: `large-${i}`, note: "Medveď v okolí obce. ".repeat(200) } }]));
    assert.equal(await publish(current, records), true);
    const unchangedVersion = await scalar("select xmin::text from public.public_record_snapshots where record_key = 'warning:large-1'");
    delete records["warning:large-0"];
    records["warning:large-1799"].record.note = "Aktualizované hlásenie";
    records["warning:new"] = { record: { id: "new" } };
    const started = performance.now();
    assert.equal(await publish(current, records), true);
    t.diagnostic(`Republished 1800 records (${Math.round(JSON.stringify(records).length / 1024)} KiB) in ${Math.round(performance.now() - started)} ms`);
    assert.equal(await scalar("select count(*)::int from public.public_record_snapshots"), 1800);
    assert.equal(await scalar("select xmin::text from public.public_record_snapshots where record_key = 'warning:large-1'"), unchangedVersion);
    assert.equal(await scalar("select public.read_public_snapshot('record','warning:large-0')"), null);
    assert.equal((await scalar("select public.read_public_snapshot('record','warning:large-1799')")).record.note, "Aktualizované hlásenie");
    assert.equal((await scalar("select public.read_public_snapshot('record','warning:new')")).record.id, "new");
    assert.equal(await publish(current, {}), true, "An empty key set removes all previous documents");
    assert.equal(await scalar("select count(*)::int from public.public_record_snapshots"), 0);
  });

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
  await assert.rejects(db.query("select * from public.public_record_snapshots"), /permission denied/);
  await assert.rejects(db.query("select public.apply_sighting_bucket_plan('[]')"), /permission denied/);
  await assert.rejects(db.query("select public.read_public_snapshot()"), /permission denied/);
  await assert.rejects(publish(rev), /permission denied/);
});
