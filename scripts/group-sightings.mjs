import "dotenv/config";
import { readFile } from "node:fs/promises";
import { saveSightingBucketPlan } from "../src/db/sighting-buckets.js";
import { precomputePublic } from "./precompute-public.mjs";

const planPath = process.argv.find(arg => arg.startsWith("--plan="))?.slice(7);
if (!planPath) throw new Error("Usage: npm run group:sightings -- --plan=path/to/plan.json [--apply]");
const groups = JSON.parse(await readFile(planPath, "utf8"));
if (!Array.isArray(groups)) throw new Error("The plan must be a JSON array of buckets");
const seen = new Set();
for (const group of groups) {
  if (!Array.isArray(group.memberKeys) || group.memberKeys.some(key => typeof key !== "string")) {
    throw new Error("Each bucket needs memberKeys, e.g. sighting:tm-123 or report:42");
  }
  if (group.memberKeys.length && !group.memberKeys.includes(group.primaryKey)) {
    throw new Error("primaryKey must be one of memberKeys");
  }
  for (const key of group.memberKeys) {
    if (seen.has(key)) throw new Error(`Record appears twice: ${key}`);
    seen.add(key);
  }
}
console.log(JSON.stringify({ mode: process.argv.includes("--apply") ? "apply" : "preview", groups }, null, 2));
if (process.argv.includes("--apply")) {
  await saveSightingBucketPlan(groups);
  await precomputePublic({ force: true });
  console.log("Bucket links and public snapshot saved. Original records were retained.");
}
