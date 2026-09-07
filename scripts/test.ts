// ---------------------------------------------------------------------------
// Runs every scripts/test-*.ts in its own process, so a suite that leans on
// globals or a store singleton can't leak into the next one.
//
//   node --experimental-strip-types --import ./scripts/register-loader.mjs \
//        scripts/test.ts [name ...]
//
// Names are substrings: `pnpm test geometry undo` runs those two.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const wanted = process.argv.slice(2)

const suites = readdirSync(here)
  .filter((name) => name.startsWith("test-") && name.endsWith(".ts"))
  .sort()
  .filter((name) => wanted.length === 0 || wanted.some((w) => name.includes(w)))

if (!suites.length) {
  console.error(`✗ no suite matches ${wanted.join(", ")}`)
  process.exit(1)
}

const failed: string[] = []
for (const name of suites) {
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--import", "./scripts/register-loader.mjs", join("scripts", name)],
    { cwd: root, stdio: "inherit" },
  )
  if (run.status !== 0) failed.push(name)
}

if (failed.length) {
  console.error(`\n✗ ${failed.length} of ${suites.length} suites failed: ${failed.join(", ")}`)
  process.exit(1)
}
console.log(`\n✓ ${suites.length} suites passed`)
