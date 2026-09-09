import { NeonDbError } from "@neondatabase/serverless"

const diagnostics = {
  AGENT_STORAGE_UNCONFIGURED: "Agent storage is not configured. Operator: set DATABASE_URL for this deployment, run pnpm db:migrate, then pnpm db:check. See /docs/self-hosting.",
  AGENT_STORAGE_SCHEMA: "Agent storage needs a database migration. Operator: run pnpm db:migrate against this deployment’s DATABASE_URL, then pnpm db:check. See /docs/self-hosting.",
  AGENT_STORAGE_UNAVAILABLE: "Agent storage is unavailable. Operator: check this deployment’s DATABASE_URL, database availability and network access, then run pnpm db:check. See /docs/self-hosting.",
  AGENT_STORAGE_PERMISSIONS: "Agent storage permissions are incomplete. Operator: grant the database role access to the agent tables, then run pnpm db:check. See /docs/self-hosting.",
}
export type StorageCode = keyof typeof diagnostics
export class StorageError extends Error {
  readonly status = 503
  code: StorageCode
  constructor(code: StorageCode) {
    super(diagnostics[code])
    this.code = code
  }
}

/** Use SQLSTATE, never a database message that may contain credentials or data. */
export function storageFailure(error: unknown): StorageError | null {
  if (error instanceof StorageError) return error
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined
  if (code === "42P01" || code === "42703" || code === "42P10") return new StorageError("AGENT_STORAGE_SCHEMA")
  if (code === "42501") return new StorageError("AGENT_STORAGE_PERMISSIONS")
  // Older installations required review_hash before canvas invitations existed.
  if (code === "23502" && "table" in (error as object) && "column" in (error as object) &&
      (error as { table: string }).table === "agent_documents" &&
      (error as { column: string }).column === "review_hash")
    return new StorageError("AGENT_STORAGE_SCHEMA")
  if ((error instanceof NeonDbError && !code) || (typeof code === "string" &&
      (code.startsWith("08") || ["28P01", "28000", "3D000", "53300", "57P01", "57P02", "57P03", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"].includes(code))))
    return new StorageError("AGENT_STORAGE_UNAVAILABLE")
  return null
}
