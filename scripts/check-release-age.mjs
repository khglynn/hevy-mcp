// Proves the .npmrc `min-release-age` wait is honored by the installed npm.
// Resolves the newest hono the way `npm install` would and fails if that version was
// published less than 7 days ago (older npm ignores the setting and takes the newest).
import { execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const npm = (args, cwd) => execFileSync("npm", args, { cwd, encoding: "utf8" });
const dir = mkdtempSync(join(tmpdir(), "release-age-"));
copyFileSync(".npmrc", join(dir, ".npmrc"));
npm(["init", "-y"], dir);
const out = npm(["install", "hono@latest", "--dry-run"], dir);
const version = out.match(/^add hono (\S+)/m)?.[1];
if (!version) throw new Error(`could not read the resolved version from: ${out}`);
const times = JSON.parse(npm(["view", "hono", "time", "--json"], dir));
const ageDays = (Date.now() - new Date(times[version]).getTime()) / 864e5;
console.log(`npm ${npm(["-v"], dir).trim()} resolved hono@${version}, published ${ageDays.toFixed(1)} days ago`);
if (ageDays < 7) {
  console.error("FAIL: npm installed a version younger than 7 days; min-release-age is not being honored");
  process.exit(1);
}
