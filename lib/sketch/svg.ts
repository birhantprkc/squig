// ---------------------------------------------------------------------------
// A drawing as SVG markup — the half of image export that runs anywhere.
//
// This is the same picture the canvas draws: nodePrims for the marks,
// primsToPaths for the rough.js strokes, one <g> per node in draw order. It
// takes no DOM, no store and no fonts, so an agent can look at what it made
// from node before anyone opens the app, and a test can check the markup
// without a browser. The app's export (lib/export-image) puts this inside a
// document with the page's font files inlined; here the faces are named and
// the viewer supplies them.
// ---------------------------------------------------------------------------

import type { ExportSurface } from "@/lib/export-image-document"
import { svgDocument } from "@/lib/export-image-document"
import { nodeVisualBounds } from "@/lib/canvas/line-routing"
import { INK } from "./kit"
import { nodePrims } from "./node-prims"
import { imagePlacement, mirrorBox, mirrorGlyphs, primsToPaths } from "./paths"
import { bgOf, FONT_STACK, paletteOf, type Look, type Palette } from "@/lib/theme"
import type { SquigNode } from "@/lib/types"

/** breathing room around the art, in world units — rough strokes overshoot */
export const EXPORT_PAD = 12

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/** `var(--sq-ink)` → `#2438FF`. Anything else passes through untouched. */
export function makeResolver(p: Palette): (paint: string) => string {
  const vars: Record<string, string> = {
    "--sq-bg": p.bg,
    "--sq-paper": p.paper,
    "--sq-ink": p.ink,
    "--sq-muted": p.muted,
    "--sq-faint": p.faint,
    "--sq-shade": p.shade,
    "--sq-shade-strong": p.shadeStrong,
    "--sq-grid": p.grid,
    "--sq-select": p.select,
  }
  return (paint) => paint.replace(/var\((--[\w-]+)\)/g, (whole, name: string) => vars[name] ?? whole)
}

/**
 * One node, as SVG markup.
 *
 * Deliberately a mirror of what SketchPrims renders — same paths, same
 * attributes, same order. It is duplicated rather than run through
 * react-dom/server because pulling a server renderer into the client bundle to
 * print thirty lines of markup is a poor trade.
 */
export function nodeMarkup(node: SquigNode, resolve: (paint: string) => string, font: string): string {
  const { paths, texts, crisp } = primsToPaths(nodePrims(node), node.seed)
  const out: string[] = []

  // A pasted picture is the one node that isn't made of marks, so it has to be
  // written out itself or the PNG comes back with an empty frame where the
  // screenshot was. Its pixels are already a data URL, which is both what
  // makes the SVG standalone and what keeps the canvas untainted when this is
  // rasterised — an external src would do neither.
  if (node.type === "image") {
    const mirror = mirrorBox(node.w, node.h, node.flipX, node.flipY)
    const p = imagePlacement(node)
    // the nested <svg> is the crop, exactly as the canvas draws it — a viewport
    // the size of the box, trimming a picture laid out larger than it
    out.push(
      `<svg x="0" y="0" width="${node.w}" height="${node.h}" overflow="hidden">` +
        `<g${mirror ? ` transform="${esc(mirror)}"` : ""}>` +
        `<image href="${esc(node.src)}" x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}"` +
        ` preserveAspectRatio="none"/>` +
        `</g></svg>`
    )
  }

  for (const p of paths) {
    out.push(
      `<path d="${esc(p.d)}" stroke="${resolve(p.stroke)}" stroke-width="${p.strokeWidth}" fill="${resolve(p.fill)}"` +
        `${p.dash ? ` stroke-dasharray="${p.dash}"` : ""} stroke-linecap="round" stroke-linejoin="round"/>`
    )
  }

  for (const c of crisp) {
    const paint = resolve(c.color)
    const bits = c.d
      .map(
        (d) =>
          `<path d="${esc(d)}" fill="${c.mode === "fill" ? paint : "none"}" stroke="${c.mode === "stroke" ? paint : "none"}"` +
          `${c.mode === "stroke" ? ` stroke-width="${c.strokeWidth}"` : ""} stroke-linecap="round" stroke-linejoin="round"/>`
      )
      .join("")
    out.push(`<g transform="${esc(c.transform)}">${bits}</g>`)
  }

  for (const t of texts) {
    const anchor = t.align === "center" ? "middle" : t.align === "right" ? "end" : "start"
    // a flipped text layer turns its words over about their own anchor, and
    // borrows the renderer's transform rather than working it out again
    const mirror = mirrorGlyphs(t)
    out.push(
      `<text x="${t.x}" y="${t.y}" font-size="${t.size}" font-family="${esc(font)}" font-weight="${t.bold ? 700 : 400}"` +
        `${t.italic ? ` font-style="italic"` : ""}${t.underline ? ` text-decoration="underline"` : ""}` +
        ` fill="${resolve(INK[t.color ?? "ink"])}" text-anchor="${anchor}"` +
        `${mirror ? ` transform="${esc(mirror)}"` : ""} xml:space="preserve">${esc(t.text)}</text>`
    )
  }

  return `<g transform="translate(${node.x} ${node.y})">${out.join("")}</g>`
}

/** The marks and the world box they cover, or null when there's nothing to draw. */
export function drawNodes(
  list: readonly SquigNode[],
  look: Look,
  font: string = FONT_STACK[look.font]
): { body: string; x: number; y: number; w: number; h: number; paper: string } | null {
  if (!list.length) return null
  const palette = paletteOf(look.theme)
  const resolve = makeResolver(palette)
  // routed connectors can bow or dogleg outside the endpoint box stored on
  // the node; measure the visible path so nothing crops a manual bend
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of list) {
    const b = nodeVisualBounds(n)
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w)
    maxY = Math.max(maxY, b.y + b.h)
  }
  return {
    body: list.map((n) => nodeMarkup(n, resolve, font)).join(""),
    x: minX - EXPORT_PAD,
    y: minY - EXPORT_PAD,
    w: Math.max(maxX - minX + EXPORT_PAD * 2, 1),
    h: Math.max(maxY - minY + EXPORT_PAD * 2, 1),
    paper: bgOf(palette, look.paper),
  }
}

/**
 * A standalone SVG of these nodes at life size, on the look's paper unless
 * asked for a transparent sheet. Empty input gives an empty string rather than
 * a blank picture, so a caller can tell the two apart.
 */
export function renderSvg(list: readonly SquigNode[], look: Look, surface: ExportSurface = "paper"): string {
  const d = drawNodes(list, look)
  if (!d) return ""
  return `<?xml version="1.0" encoding="UTF-8"?>\n${svgDocument({ ...d, css: "" }, d.w, d.h, surface)}`
}
