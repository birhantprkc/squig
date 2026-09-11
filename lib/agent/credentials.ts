export const KEY_STORAGE = "squig:agent-key"
export const canvasStorage = (id: string) => `squig:canvas-key:${id}`

export function keyKind(key: string): "workspace" | "canvas" | null {
  if (key.length === 53 && /^sq_canvas_[A-Za-z0-9_-]{43}$/.test(key))
    return "canvas"
  if (key.length === 46 && /^sq_[A-Za-z0-9_-]{43}$/.test(key))
    return "workspace"
  return null
}

type KeyStorage = Pick<Storage, "getItem">

export function workspaceKey(storage: KeyStorage): string | null {
  const key = storage.getItem(KEY_STORAGE)
  return key && keyKind(key) === "workspace" ? key : null
}

/** A supplied invitation must succeed on its own, even in an owner's browser. */
export function canvasConnection(
  id: string,
  fragment: string | undefined,
  storage: KeyStorage,
) {
  if (!id || id.length > 80 || /[^A-Za-z0-9_-]/.test(id))
    throw new Error("Invalid canvas invitation.")
  if (fragment !== undefined) {
    if (keyKind(fragment) !== "canvas")
      throw new Error("Invalid canvas invitation. Open the full editable link.")
    return { key: fragment, canvasKey: fragment }
  }
  const saved = storage.getItem(canvasStorage(id))
  if (saved) {
    if (keyKind(saved) !== "canvas")
      throw new Error("Invalid saved canvas key. Open a new invitation link.")
    return { key: saved, canvasKey: saved }
  }
  return { key: workspaceKey(storage), canvasKey: null }
}
