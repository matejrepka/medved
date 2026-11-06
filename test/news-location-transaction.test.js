import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("location replacement is private, ordered, repeatable and rolls back failed inserts", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  for (const name of ["supabase-schema.sql", "migration-006-news-incidents.sql"]) {
    await db.exec(await readFile(new URL(`../docs/${name}`, import.meta.url), "utf8"));
  }
  const migration = await readFile(new URL("../supabase/migrations/20261106205315_atomic_news_warning_locations.sql", import.meta.url), "utf8");
  await db.exec(migration);
  await db.exec("insert into public.news_logs(id,title) values ('one','Medveď'), ('other','Other record')");
  const replace = locations => db.query("select public.replace_news_warning_locations('one', $1::jsonb)", [JSON.stringify(locations)]);
  const read = async () => (await db.query("select position,place,lat,lng from public.news_warning_locations where news_id='one' order by position")).rows;
  const places = [{ place: "Brezno", lat: 48.8, lng: 19.6 }, { place: "Žilina", lat: null, lng: null }];
  await replace(places);
  assert.deepEqual((await read()).map(row => row.place), ["Brezno", "Žilina"]);
  await db.exec(migration);
  assert.equal((await read()).length, 2, "Reapplying the migration retains the existing locations");
  await replace([...places].reverse());
  const reversed = await read();
  assert.deepEqual(reversed.map(row => row.place), ["Žilina", "Brezno"], "Reordering cannot hit transient unique-name conflicts");
  for (const invalid of [
    [{ place: "Duplicate" }, { place: "duplicate" }], [{ place: "New", lat: "invalid", lng: 19 }],
    [{ place: "" }], [{ place: "Unpaired coordinate", lat: 48.8 }],
    Array.from({ length: 13 }, (_, id) => ({ place: `Place ${id}` })), {},
  ]) {
    await assert.rejects(replace(invalid));
    assert.deepEqual(await read(), reversed, "A failed replacement must roll back the deletion");
  }
  await assert.rejects(db.query("select public.replace_news_warning_locations('missing','[]')"), /not found/);
  assert.equal((await db.query("select count(*)::int as total from public.news_logs")).rows[0].total, 2);
  await replace([]);
  assert.deepEqual(await read(), []);
  await replace(places);
  const privileges = (await db.query(`select
    has_function_privilege('anon','public.replace_news_warning_locations(text,jsonb)','EXECUTE') as anon,
    has_function_privilege('authenticated','public.replace_news_warning_locations(text,jsonb)','EXECUTE') as authenticated,
    has_function_privilege('service_role','public.replace_news_warning_locations(text,jsonb)','EXECUTE') as service,
    (select prosecdef from pg_proc where oid='public.replace_news_warning_locations(text,jsonb)'::regprocedure) as definer`)).rows[0];
  assert.deepEqual(privileges, { anon: false, authenticated: false, service: true, definer: false });
  await db.exec("set role anon");
  await assert.rejects(replace([]), /permission denied/);
});
