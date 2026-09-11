import { db } from "./db"
import { StorageError, storageFailure } from "./storage"

export const requiredColumns = {
  agent_workspaces: "id, name, key_hash, created_at",
  agent_documents: "id, workspace_id, document, revision, review_hash, canvas_hash, approval, updated_at",
  agent_revisions: "document_id, revision, document, created_at",
  agent_comments: "id, document_id, text, author, node_id, variation_id, resolved, created_at",
  agent_limits: "key, bucket, count",
}
type Query = (sql: string) => Promise<Record<string, unknown>[]>

/** Read-only and deliberately uncached: run against the deployment's own role. */
export async function checkReadiness(query: Query = (sql) => db().query(sql)) {
  try {
    for (const [table, columns] of Object.entries(requiredColumns)) {
      await query(`SELECT ${columns} FROM ${table} LIMIT 0`)
      const [access] = await query(`SELECT has_table_privilege(current_user, '${table}', 'SELECT')
        AND has_table_privilege(current_user, '${table}', 'INSERT')
        AND has_table_privilege(current_user, '${table}', 'UPDATE')
        AND has_table_privilege(current_user, '${table}', 'DELETE') AS allowed`)
      if (!access?.allowed) throw new StorageError("AGENT_STORAGE_PERMISSIONS")
    }
    const [review] = await query(`SELECT attnotnull FROM pg_attribute
      WHERE attrelid = 'agent_documents'::regclass AND attname = 'review_hash' AND NOT attisdropped`)
    if (!review || review.attnotnull !== false) throw new StorageError("AGENT_STORAGE_SCHEMA")
    return { ready: true, checks: ["connection", "columns", "permissions", "nullable review_hash"] }
  } catch (error) {
    throw storageFailure(error) ?? error
  }
}
