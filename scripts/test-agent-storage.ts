import { isDeepStrictEqual } from "node:util"
import { spawnSync } from "node:child_process"
import { neonConfig } from "@neondatabase/serverless"
import { check, report } from "./harness.ts"
import { db } from "../lib/agent/db.ts"
import { failure } from "../lib/agent/http.ts"
import { StorageError, storageFailure } from "../lib/agent/storage.ts"
import { checkReadiness, requiredColumns } from "../lib/agent/readiness.ts"
import { prepareCanvas, applyPreparedImages } from "../lib/agent/prepare-canvas.ts"
import { emptyDocument, validateDocument, AgentError } from "../lib/agent/engine.ts"
import { POST as rest, GET as get } from "../app/api/v1/[...path]/route.ts"
import { POST as mcp } from "../app/mcp/route.ts"

const savedEnv = process.env.DATABASE_URL
const savedFetch = neonConfig.fetchFunction
const savedLog = console.error
const logs: string[] = []
console.error = (...args) => { logs.push(args.join(" ")) }
const context = (path: string) => ({ params: Promise.resolve({ path: path.split("/") }) })
const request = (path: string, data?: unknown, key = "sq_test") => new Request(`http://localhost/api/v1/${path}`, {
  method: data === undefined ? "GET" : "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  ...(data === undefined ? {} : { body: JSON.stringify(data) }),
})
async function diagnostic(response: Response, code: string) {
  const data = await response.json()
  check(`${code} returns a no-store 503`, response.status === 503 && response.headers.get("Cache-Control") === "no-store")
  check(`${code} has actionable operator guidance`, data.code === code && data.error.includes("Operator:") && data.error.includes("pnpm db:check"))
  check(`${code} contains no database secrets`, !JSON.stringify(data).includes("private-secret"))
}
try {
  delete process.env.DATABASE_URL
  await diagnostic(await rest(request("workspaces", { name: "Test" }), context("workspaces")), "AGENT_STORAGE_UNCONFIGURED")
  await diagnostic(await get(request("documents"), context("documents")), "AGENT_STORAGE_UNCONFIGURED")
  await diagnostic(await mcp(request("mcp", {})), "AGENT_STORAGE_UNCONFIGURED")
  const unauthorized = await get(new Request("http://localhost/api/v1/documents"), context("documents"))
  check("missing credentials remain a 401", unauthorized.status === 401)
  const invalid = await rest(request("workspaces", { name: "" }), context("workspaces"))
  check("invalid input remains a 400", invalid.status === 400)
  process.env.DATABASE_URL = "not-a-connection-string-private-secret"
  try { db(); check("invalid connection refused", false) } catch (error) {
    check("invalid connection has sanitized guidance", storageFailure(error)?.code === "AGENT_STORAGE_UNAVAILABLE")
  }

  process.env.DATABASE_URL = "postgresql://test:private-secret@db.example.invalid/test"
  for (const [code, expected, extra] of [
    ["42P01", "AGENT_STORAGE_SCHEMA", {}],
    ["42703", "AGENT_STORAGE_SCHEMA", {}],
    ["23502", "AGENT_STORAGE_SCHEMA", { table: "agent_documents", column: "review_hash" }],
    ["42501", "AGENT_STORAGE_PERMISSIONS", {}],
    ["28P01", "AGENT_STORAGE_UNAVAILABLE", {}],
  ] as const) {
    neonConfig.fetchFunction = async () => Response.json({ code, message: "private-secret SQL details", ...extra }, { status: 400 })
    await diagnostic(await rest(request("workspaces", { name: "Test" }), context("workspaces")), expected)
    await diagnostic(await mcp(request("mcp", {})), expected)
  }
  neonConfig.fetchFunction = async () => { throw new Error("network private-secret") }
  await diagnostic(await get(request("documents"), context("documents")), "AGENT_STORAGE_UNAVAILABLE")
  let calls = 0
  neonConfig.fetchFunction = async (_url: string, options?: RequestInit) => {
    calls++
    check("database requests have a timeout", options?.signal instanceof AbortSignal)
    const query = JSON.parse(String(options?.body)).query as string
    return Response.json(query.includes("agent_limits")
      ? { fields: [{ name: "count", dataTypeID: 23 }], rows: [["1"]] }
      : { fields: [], rows: [] })
  }
  const healthy = await rest(request("workspaces", { name: "Test" }), context("workspaces"))
  check("configured workspace creation still succeeds", healthy.status === 201 && (await healthy.json()).key.startsWith("sq_") && calls === 2)
  check("conflicts remain 409", failure(new AgentError(409, "Revision conflict")).status === 409)
  check("unrelated constraints are not mislabeled as rollout failures", storageFailure({ code: "23502", table: "elsewhere", column: "name" }) === null)
  check("unexpected error details stay private", !(await failure(new Error("private-secret")).text()).includes("private-secret"))
  check("server logs contain no driver secrets", logs.every((line) => !line.includes("private-secret")))

  const queries: string[] = []
  const readyQuery = async (sql: string) => {
    queries.push(sql)
    return sql.includes("has_table_privilege") ? [{ allowed: true }] : sql.includes("pg_attribute") ? [{ attnotnull: false }] : []
  }
  check("complete schema is ready", (await checkReadiness(readyQuery)).ready)
  check("preflight executes only reads", queries.every((sql) => sql.startsWith("SELECT ")))
  check("preflight checks all five tables", Object.keys(requiredColumns).every((table) => queries.some((sql) => sql.includes(`FROM ${table} LIMIT 0`))))
  for (const table of Object.keys(requiredColumns)) {
    try {
      await checkReadiness(async (sql) => {
        if (sql.includes(`FROM ${table} LIMIT 0`)) throw { code: "42P01" }
        return readyQuery(sql)
      })
      check(`${table} required`, false)
    } catch (error) { check(`${table} missing requires migration`, storageFailure(error)?.code === "AGENT_STORAGE_SCHEMA") }
  }
  for (const [needle, result, code] of [
    ["has_table_privilege", [{ allowed: false }], "AGENT_STORAGE_PERMISSIONS"],
    ["pg_attribute", [{ attnotnull: true }], "AGENT_STORAGE_SCHEMA"],
  ] as const) {
    try {
      await checkReadiness(async (sql) => sql.includes(needle) ? [...result] : readyQuery(sql))
      check(`${needle} failure refused`, false)
    } catch (error) { check(`${needle} failure diagnosed`, storageFailure(error)?.code === code) }
  }
  const cli = spawnSync(process.execPath, ["--experimental-strip-types", "--import", "./scripts/register-loader.mjs", "scripts/agent/check.ts"], {
    encoding: "utf8", env: { ...process.env, DATABASE_URL: "" },
  })
  check("preflight exits nonzero without configuration", cli.status === 1 && cli.stderr.includes("AGENT_STORAGE_UNCONFIGURED") && cli.stderr.includes('"ready":false'))
  const hosted = spawnSync("pnpm", ["build:hosted"], {
    encoding: "utf8", env: { ...process.env, DATABASE_URL: "" },
  })
  check("hosted build stops before compiling without storage", hosted.status !== 0 && !hosted.stdout.includes("> next build"))

  const original = emptyDocument("Legacy SVG")
  original.nodes.logo = { id: "logo", type: "image", x: 10, y: 20, w: 200, h: 100, seed: 1,
    src: "data:image/svg+xml;base64,legacy", naturalW: 400, naturalH: 200, crop: { x: 0.1, y: 0.2, w: 0.8, h: 0.7 } }
  original.order = ["logo"]
  const before = structuredClone(original)
  const raster = "data:image/png;base64,iVBORw0KGgo="
  const prepared = await prepareCanvas(original, async () => raster)
  check("sharing converts legacy SVG without changing local file", isDeepStrictEqual(original, before) && prepared.nodes.logo.type === "image" && prepared.nodes.logo.src === raster)
  check("conversion preserves all image geometry and crop", isDeepStrictEqual(prepared.nodes.logo, { ...original.nodes.logo, src: raster }))
  check("prepared canvas passes agent validation", !!validateDocument(prepared))
  let rasterCalls = 0
  await prepareCanvas(prepared, async () => { rasterCalls++; return raster })
  check("raster images are not re-encoded", rasterCalls === 0)
  try { await prepareCanvas(original, async () => { throw new Error("decode failed") }); check("broken SVG refused", false) }
  catch (error) { check("broken SVG offers an actionable fix", (error as Error).message.includes("Replace it with a PNG")) }
  check("failed conversion preserves original", isDeepStrictEqual(original, before))
  const edited = { logo: { ...original.nodes.logo, x: 500 } }
  check("successful conversion preserves in-flight moves", applyPreparedImages(edited, original, prepared).logo.x === 500)
  const replacement = { logo: { ...original.nodes.logo, src: "data:image/png;base64,replacement" } }
  check("successful conversion preserves in-flight replacement", isDeepStrictEqual(applyPreparedImages(replacement, original, prepared), replacement))
  check("typed storage diagnostics retain 503", new StorageError("AGENT_STORAGE_SCHEMA").status === 503)
} finally {
  if (savedEnv === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = savedEnv
  neonConfig.fetchFunction = savedFetch
  console.error = savedLog
}
report("agent rollout checks passed")
