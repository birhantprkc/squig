// Shared helper for defs that build themselves out of other defs. The type-only
// registry import keeps this out of the import cycle (registry imports every
// defs file, and every defs file imports this).

import type { Prim } from "@/lib/sketch/kit"
import { place } from "@/lib/sketch/kit"
import type { ComponentDef, Props } from "./registry"

/** Compose a child def at an offset. */
export function sub(def: ComponentDef, props: Props, x: number, y: number, w: number, h: number): Prim[] {
  return place(def.render({ ...def.defaults, ...props }, w, h), x, y)
}
