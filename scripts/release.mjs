import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const bump = process.argv[2] ?? "patch";
if (!["patch", "minor", "major"].includes(bump)) {
  console.error("Usage: npm run release -- [patch|minor|major]");
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const status = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
if (status.status !== 0) process.exit(status.status ?? 1);
if (status.stdout.trim()) {
  console.error("Working tree is not clean. Commit or stash changes first.");
  process.exit(1);
}

console.log("Running checks...");
run("npm", ["run", "check"]);
run("npm", ["test"]);

console.log(`Bumping ${bump} version and creating a Git tag...`);
run("npm", ["version", bump]);

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
console.log(`Pushing v${packageJson.version}; GitHub Actions will publish it.`);
run("git", ["push", "origin", "HEAD", "--follow-tags"]);
