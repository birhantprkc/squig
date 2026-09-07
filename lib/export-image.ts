"use client"

// ---------------------------------------------------------------------------
// Getting a sketch out of squig: onto the clipboard with ⌘⇧C, or onto disk as
// a PNG or an SVG. All three draw the same marks — the selection when there is
// one, the whole canvas when there isn't — so the menu can never act on
// something different from what the keystroke would have taken. A copied
// selection leaves the paper out, which makes the PNG transparent around the
// marks; a whole-canvas copy and saved files keep the document's paper.
//
// The picture is re-rendered from the same prims the canvas draws, into a
// standalone SVG document. Standalone is the whole difficulty: an <img>
// loading an SVG gets none of the page around it, and neither does a file
// somebody opens next week, so two things the on-screen canvas takes for
// granted have to be packed into the document itself —
//
//   · colours, which live in CSS custom properties, are resolved to literal
//     hex against the current palette
//   · the hand-lettered font, which is a same-origin woff2, is fetched and
//     inlined as a base64 @font-face
//
// Miss either one and the picture comes back black-on-nothing in Times New
// Roman. That document used to be painted onto a <canvas> and dropped on the
// floor; saving it as-is hands over the better of the two files, since a
// raster has a ceiling — see rasterScale — and a vector doesn't.
// ---------------------------------------------------------------------------

import { drawNodes, loadIconsFor } from "./sketch/svg"
import { copiedSurface, svgDocument, type ExportDrawing, type ExportSurface } from "./export-image-document"
import { downloadBlob } from "./file-io"
import { useSquig } from "./store"
import type { SquigNode } from "./types"

/** retina by default: a wireframe pasted into a doc gets read at 1×, not 2× */
const SCALE = 2
/** browsers refuse canvases past ~16k; stay well under and scale down instead */
const MAX_SIDE = 8192

type CopyResult = "copied" | "downloaded" | "empty" | "failed"

interface CopyOutcome {
  status: CopyResult
  /** nothing was selected, so the whole canvas went instead */
  whole: boolean
  /** what the raster actually landed at, when the board pushed it under 2× */
  scale?: number
}

/** The two file formats a drawing can leave as. */
export type ImageFormat = "png" | "svg"

interface SaveOutcome {
  status: "saved" | "empty" | "failed"
  format: ImageFormat
  /** nothing was selected, so the whole canvas went instead */
  whole: boolean
  scale?: number
}

// -- fonts -------------------------------------------------------------------

/** The font stack the canvas is actually drawing with, fully resolved. */
function canvasFontStack(): string {
  const probe = document.createElement("span")
  probe.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;font-family:var(--sq-font)"
  document.body.appendChild(probe)
  const family = getComputedStyle(probe).fontFamily
  probe.remove()
  return family || "sans-serif"
}

const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "")

function isFontFace(rule: CSSRule): rule is CSSFontFaceRule {
  return typeof CSSFontFaceRule !== "undefined" && rule instanceof CSSFontFaceRule
}

const MIME: Record<string, string> = {
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
}

async function fetchAsDataUri(url: string): Promise<string | null> {
  const res = await fetch(url)
  if (!res.ok) return null
  const bytes = new Uint8Array(await res.arrayBuffer())
  // chunked, because spreading a 40k-byte array into apply() blows the stack
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  const ext = /\.(\w+)(?:[?#]|$)/.exec(url)?.[1]?.toLowerCase() ?? ""
  return `data:${MIME[ext] ?? "application/octet-stream"};base64,${btoa(binary)}`
}

/**
 * Every @font-face in the page that the given stack names, rewritten with its
 * file inlined. next/font hashes its family names per build, so the match is
 * made against the resolved stack rather than a name written down here.
 */
async function buildFontFaceCss(stack: string): Promise<string> {
  const wanted = new Set(stack.split(",").map((f) => unquote(f).toLowerCase()))
  const out: string[] = []

  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      // a cross-origin stylesheet won't open — nothing we can inline from it
      continue
    }
    for (const rule of Array.from(rules)) {
      if (!isFontFace(rule)) continue
      const family = unquote(rule.style.getPropertyValue("font-family"))
      if (!wanted.has(family.toLowerCase())) continue
      const src = rule.style.getPropertyValue("src")
      // local() fallbacks (next/font's metric-adjusted stand-in) have no file
      const href = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(src)?.[1]
      if (!href) continue
      try {
        const data = await fetchAsDataUri(new URL(href, sheet.href ?? document.baseURI).href)
        if (!data) continue
        const weight = rule.style.getPropertyValue("font-weight") || "400"
        const style = rule.style.getPropertyValue("font-style") || "normal"
        // next/font ships one face per unicode subset — latin, latin-ext,
        // vietnamese — all under the same family, weight and style. Drop the
        // ranges and they collide: the last one declared wins for every
        // character, and anything it doesn't have (an é, a ẵ) quietly comes out
        // in the fallback face instead. Carry them over and each subset covers
        // what it was cut for.
        const range = rule.style.getPropertyValue("unicode-range")
        out.push(
          `@font-face{font-family:'${family}';src:url(${data});font-weight:${weight};font-style:${style};` +
            `${range ? `unicode-range:${range};` : ""}font-display:block;}`
        )
      } catch {
        // one unreachable file shouldn't cost the whole export
      }
    }
  }
  return out.join("")
}

/** Fonts don't change between exports; fetch and encode each stack once. */
const fontCache = new Map<string, Promise<string>>()

function fontFaceCss(stack: string): Promise<string> {
  const hit = fontCache.get(stack)
  if (hit) return hit
  const pending = buildFontFaceCss(stack).catch(() => "")
  fontCache.set(stack, pending)
  return pending
}

// -- rasterising -------------------------------------------------------------

/**
 * A data URI rather than a blob: URL — an SVG image drawn onto a canvas has to
 * be origin-clean or `toBlob` throws, and a data URI is unambiguously so on
 * every browser.
 */
function loadImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("the sketch wouldn't rasterise"))
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  })
}

async function rasterize(svg: string, w: number, h: number): Promise<Blob> {
  const img = await loadImage(svg)
  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("no 2d context")
  ctx.drawImage(img, 0, 0, w, h)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("the canvas gave back nothing"))), "image/png")
  })
}

// -- the export --------------------------------------------------------------

/**
 * What every export acts on: the selection, or the whole canvas when nothing
 * is picked. ⌘⇧C and both save commands share it so that picking one thing and
 * reaching for the menu can't quietly hand you the other.
 */
function pngTargets(): { nodes: SquigNode[]; whole: boolean } {
  const { nodes, order, selection } = useSquig.getState()
  const picked = order.filter((id) => selection.includes(id)).map((id) => nodes[id]).filter(Boolean)
  if (picked.length) return { nodes: picked, whole: false }
  return { nodes: order.map((id) => nodes[id]).filter(Boolean), whole: true }
}

/**
 * A drawing, gathered but not yet wrapped in a document. Every export goes
 * through here, so the file you save and the picture on your clipboard are the
 * same marks — only the frame around them differs.
 */
/** Draw a set of nodes, on the current theme's paper. */
async function draw(list: SquigNode[]): Promise<ExportDrawing> {
  if (!list.length) throw new Error("nothing to draw")

  await loadIconsFor(list)

  const s = useSquig.getState()
  const font = canvasFontStack()
  const d = drawNodes(list, { theme: s.theme, paper: s.paper, font: s.font, grid: s.grid }, { font })
  if (!d) throw new Error("nothing to draw")
  return { ...d, css: await fontFaceCss(font) }
}

/**
 * How big the raster is allowed to get: 2×, unless a wall-sized board won't fit
 * in a canvas, in which case less.
 *
 * This is a real cliff and it used to be a silent one — past about 4000 world
 * units across the answer drops under 2×, and past 8192 it comes out smaller
 * than the thing you drew. Every caller reports what it got back so the notice
 * can say so, because a wireframe that quietly came out at 0.8× reads as squig
 * being bad at PNGs rather than as a board that outgrew one.
 */
function rasterScale(w: number, h: number): number {
  return Math.min(SCALE, MAX_SIDE / w, MAX_SIDE / h)
}

/** Render a set of nodes to a PNG blob, and say how big it managed to be. */
async function renderPng(
  list: SquigNode[],
  options: { surface?: ExportSurface } = {}
): Promise<{ blob: Blob; scale: number }> {
  const d = await draw(list)
  const scale = rasterScale(d.w, d.h)
  const outW = Math.max(1, Math.round(d.w * scale))
  const outH = Math.max(1, Math.round(d.h * scale))
  return { blob: await rasterize(svgDocument(d, outW, outH, options.surface), outW, outH), scale }
}

/**
 * Render a set of nodes to an SVG blob — life size, because a vector has no
 * size to pick and every tool that opens it will scale it anyway.
 */
async function renderSvg(list: SquigNode[]): Promise<Blob> {
  const d = await draw(list)
  // the prolog is optional for anything served as image/svg+xml, but a file on
  // disk gets opened by things that sniff the first line instead, so it stays
  const doc = `<?xml version="1.0" encoding="UTF-8"?>\n${svgDocument(d, d.w, d.h)}`
  return new Blob([doc], { type: "image/svg+xml;charset=utf-8" })
}

/**
 * ⌘⇧C. Not async at the top on purpose: Safari only honours a clipboard write
 * that was set up inside the gesture that asked for it, so the ClipboardItem is
 * constructed synchronously around a promise of the blob rather than after
 * awaiting one. A browser that won't take an image lands on a download instead
 * — the sketch still leaves the app, just through the other door.
 */
function copySelectionAsPng(): Promise<CopyOutcome> {
  const { nodes, whole } = pngTargets()
  if (!nodes.length) return Promise.resolve({ status: "empty", whole })

  // A selection should paste like an object, not like a screenshot of the
  // sheet it was sitting on. The canvas command still carries the paper,
  // because in that case the sheet is the thing being copied.
  const render = renderPng(nodes, { surface: copiedSurface(whole) })
  // how far the raster got is only known once it has been made, and every
  // branch below reads it after the blob has landed — so a plain variable does
  // the job the ClipboardItem's promise won't let an await do
  let scale = SCALE
  const blob = render.then((r) => {
    scale = r.scale
    return r.blob
  })
  // the failure is handled below, but only after the clipboard has had its go —
  // claim it now so a rejection can't be reported as unhandled in between
  blob.catch(() => {})
  const fallback = (): Promise<CopyOutcome> =>
    blob
      .then((b) => {
        downloadBlob(b, ".png")
        return { status: "downloaded" as const, whole }
      })
      .catch(() => ({ status: "failed" as const, whole }))

  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return fallback()

  try {
    const item = new ClipboardItem({ "image/png": blob })
    return navigator.clipboard
      .write([item])
      .then(() => ({ status: "copied" as const, whole, scale }))
      .catch(fallback)
  } catch {
    return fallback()
  }
}

/**
 * Save PNG / Save SVG. Same targets as ⌘⇧C, and the same document underneath —
 * the SVG is simply the step the PNG throws away.
 */
async function saveSelectionAsImage(format: ImageFormat): Promise<SaveOutcome> {
  const { nodes, whole } = pngTargets()
  if (!nodes.length) return { status: "empty", format, whole }
  try {
    if (format === "svg") {
      downloadBlob(await renderSvg(nodes), ".svg")
      return { status: "saved", format, whole }
    }
    const { blob, scale } = await renderPng(nodes)
    downloadBlob(blob, ".png")
    return { status: "saved", format, whole, scale }
  } catch {
    return { status: "failed", format, whole }
  }
}

/**
 * The tail a notice grows when the raster hit its ceiling. Said out loud
 * rather than swallowed, and pointed at the SVG, which is the way out — a
 * board this size isn't a mistake, it just outgrew what a PNG can hold.
 */
function clampedTail(scale: number | undefined): string {
  if (scale === undefined || scale >= SCALE) return ""
  return ` — ${Math.round(scale * 10) / 10}× instead of 2×, as big as a raster gets. the SVG has no ceiling`
}

/** One wording for the flash, wherever the command was run from. */
function copyNotice({ status, whole, scale }: CopyOutcome): string {
  switch (status) {
    case "copied":
      return (whole ? "copied the whole canvas as a PNG" : "copied as a PNG") + clampedTail(scale)
    case "downloaded":
      // no clamp tail here: this line is already explaining a browser that
      // wouldn't take the picture, and two apologies in one flash is one too many
      return "this browser won't take images — saved a PNG instead"
    case "empty":
      return "nothing on the canvas to copy"
    case "failed":
      return "couldn't make that PNG"
  }
}

/** The same, for the two save commands. */
function saveNotice({ status, format, whole, scale }: SaveOutcome): string {
  const kind = format === "svg" ? "an SVG" : "a PNG"
  switch (status) {
    case "saved":
      return (whole ? `saved the whole canvas as ${kind}` : `saved as ${kind}`) + clampedTail(scale)
    case "empty":
      return "nothing on the canvas to save"
    case "failed":
      return `couldn't make that ${format.toUpperCase()}`
  }
}

/** ⌘⇧C, wired to the flash — what every entry point actually calls. */
export async function copyAsPngWithNotice(): Promise<void> {
  const s = useSquig.getState()
  const outcome = await copySelectionAsPng()
  s.setNotice(copyNotice(outcome))
}

/** The file menu and ⌘K both come through here. */
export async function saveImageWithNotice(format: ImageFormat): Promise<void> {
  const s = useSquig.getState()
  const outcome = await saveSelectionAsImage(format)
  s.setNotice(saveNotice(outcome))
}
