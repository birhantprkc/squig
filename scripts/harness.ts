// ---------------------------------------------------------------------------
// The tally every scripts/test-*.ts file keeps. No framework, no globals to
// learn: collect names, print the ones that broke, exit non-zero so the runner
// and CI notice.
// ---------------------------------------------------------------------------

let passed = 0
const failures: string[] = []

export function check(name: string, cond: boolean, detail = "") {
  if (cond) passed++
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`)
}

/** Print the tally and exit non-zero on any failure. `what` finishes the sentence: "geometry checks passed". */
export function report(what: string): void {
  if (failures.length) {
    console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`)
    for (const f of failures) console.error("  ✗ " + f)
    process.exit(1)
  }
  console.log(`✓ ${passed} ${what}`)
}
