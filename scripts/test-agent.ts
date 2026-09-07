// ---------------------------------------------------------------------------
// The hosted workspace, end to end without a database.
//
//   node --experimental-strip-types scripts/test-agent.ts
//
// The engine is the only thing standing between an agent's JSON and a canvas a
// person has to open, so most of what follows is refusals: bad ids, bad kinds,
// bad images, edits to a locked node. The rest is the render path, where a
// wrong line break or a missing face is invisible until someone looks at the
// PNG.
// ---------------------------------------------------------------------------

import { isDeepStrictEqual } from "node:util"
import {
  applyOperations,
  cleanNode,
  diffNodes,
  emptyDocument,
  validateDocument,
} from "../lib/agent/engine.ts"
import { renderPng, renderSvg, pngDocument } from "../lib/agent/render.ts"
import { operation } from "../lib/agent/schema.ts"
import { ALL_DEFS } from "../lib/library/registry.ts"
import { check, report } from "./harness.ts"

/** true when the call refused, which is the engine's whole job on bad input */
function refused(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b)

// -- every library kind is placeable ----------------------------------------

let d = emptyDocument("Test")
for (const def of ALL_DEFS)
  check(
    `${def.kind} cleans to a component`,
    cleanNode({ type: "component", kind: def.kind, x: 0, y: 0 }).type ===
      "component",
  )

// -- one batch of every operation -------------------------------------------

const batch = operation.array().parse([
  {
    op: "add",
    nodes: [
      { id: "a", type: "component", kind: "button", x: 0, y: 0 },
      { id: "b", type: "shape", x: 200, y: 20, w: 100, h: 80 },
      {
        id: "c",
        type: "text",
        x: 400,
        y: 100,
        text: "Hello",
        fontSize: 20,
      },
      {
        id: "line",
        type: "arrow",
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        points: [
          [0, 0],
          [100, 100],
        ],
        head: true,
        bind: ["a", "b"],
      },
      {
        id: "draw",
        type: "draw",
        x: 0,
        y: 200,
        points: [
          [0, 0],
          [10, 20],
        ],
      },
      {
        id: "img",
        type: "image",
        x: 200,
        y: 200,
        src: "data:image/png;base64,AA==",
        naturalW: 10,
        naturalH: 10,
      },
    ],
  },
  { op: "variation", id: "v1", title: "First", nodeIds: ["a", "b", "c"] },
  { op: "note", x: 0, y: 400, text: "Make the action clear" },
])
d = applyOperations(d, batch).document
check("six nodes plus the note", d.order.length === 7)
check("the variation stuck", d.variations.length === 1)
check("an arrow came back an arrow", d.nodes.line.type === "arrow")

// -- a batch is all or nothing ----------------------------------------------

const before = JSON.stringify(d)
check(
  "one bad operation refuses the batch",
  refused(() =>
    applyOperations(
      d,
      operation.array().parse([
        { op: "rename", name: "Changed" },
        { op: "delete", ids: ["missing"] },
      ]),
    ),
  ),
)
check("…and leaves the document untouched", JSON.stringify(d) === before)

// -- refusals ---------------------------------------------------------------

check(
  "a prototype-polluting id is refused",
  refused(() =>
    cleanNode({ id: "__proto__", type: "text", x: 0, y: 0, text: "oops" }),
  ),
)
check(
  "a component nobody ships is refused",
  refused(() => cleanNode({ type: "component", kind: "not-real", x: 0, y: 0 })),
)
check(
  "a non-finite coordinate is refused",
  refused(() => cleanNode({ type: "text", x: Infinity, y: 0, text: "oops" })),
)
check(
  "an SVG data URL is refused, since it carries script",
  refused(() =>
    cleanNode({
      type: "image",
      x: 0,
      y: 0,
      src: "data:image/svg+xml;base64,xxx",
      naturalW: 10,
      naturalH: 10,
    }),
  ),
)
check(
  "a patch cannot change a node's type",
  refused(() =>
    applyOperations(
      d,
      operation
        .array()
        .parse([
          { op: "update", patches: [{ id: "a", patch: { type: "text" } }] },
        ]),
    ),
  ),
)
check(
  "a duplicated id in the order is refused",
  refused(() => validateDocument({ ...d, order: [...d.order, "a"] })),
)
check(
  "a negative width is refused",
  refused(() => cleanNode({ type: "text", x: 0, y: 0, w: -5, text: "bad" })),
)
check(
  "a javascript: link is refused",
  refused(() =>
    cleanNode({
      type: "text",
      x: 0,
      y: 0,
      link: "javascript:alert(1)",
      text: "bad",
    }),
  ),
)
check(
  "a hole in the node map is refused",
  refused(() =>
    validateDocument({
      ...d,
      nodes: { ...d.nodes, a: null },
    } as unknown as typeof d),
  ),
)
check(
  "a kind named after an Object property is refused",
  refused(() =>
    cleanNode({ type: "component", kind: "constructor", x: 0, y: 0 }),
  ),
)
check(
  "…and so is one named __proto__",
  refused(() => cleanNode({ type: "component", kind: "__proto__", x: 0, y: 0 })),
)

// -- locking ----------------------------------------------------------------

let locked = applyOperations(
  d,
  operation
    .array()
    .parse([
      { op: "update", patches: [{ id: "a", patch: { locked: true } }] },
    ]),
).document
check(
  "a locked node cannot be deleted",
  refused(() =>
    applyOperations(
      locked,
      operation.array().parse([{ op: "delete", ids: ["a"] }]),
    ),
  ),
)
locked = applyOperations(
  locked,
  operation.array().parse([
    { op: "update", patches: [{ id: "a", patch: { locked: false } }] },
    { op: "update", patches: [{ id: "a", patch: { x: 15 } }] },
  ]),
).document
check("unlocked, it moves", locked.nodes.a.x === 15)

// -- duplicating a group ----------------------------------------------------

const cloned = applyOperations(
  d,
  operation.array().parse([
    { op: "group", ids: ["a", "b"] },
    { op: "duplicate", ids: ["a", "b", "line"], dx: 800, dy: 0 },
  ]),
)
check("three copies came back", cloned.createdIds.length === 3)
check(
  "the copy got its own group",
  cloned.document.nodes.a.groupIds?.[0] !==
    cloned.document.nodes[cloned.createdIds[0]].groupIds?.[0],
)
check("the copied arrow binds to the copies", (() => {
  const n = cloned.document.nodes[cloned.createdIds[2]]
  return n.type === "arrow" && same(n.bind, cloned.createdIds.slice(0, 2))
})())

// -- arranging --------------------------------------------------------------

const arranged = applyOperations(
  d,
  operation.array().parse([
    { op: "align", ids: ["a", "b", "c"], edge: "top" },
    { op: "distribute", ids: ["a", "b", "c"], axis: "x" },
    { op: "reorder", ids: ["a"], position: "front" },
    { op: "flip", ids: ["c"], axis: "x" },
  ]),
).document
check("aligned to the same top", arranged.nodes.a.y === arranged.nodes.c.y)
check("brought to the front", arranged.order.at(-1) === "a")
check("flipped on x", arranged.nodes.c.flipX === true)

// -- detaching a component --------------------------------------------------

const detached = applyOperations(
  d,
  operation.array().parse([{ op: "detach", ids: ["a"] }]),
).document
check("the component itself is gone", detached.nodes.a === undefined)
check("its parts took its place", detached.order.length > 5)
check(
  "and the order still names real nodes",
  detached.order.every((id) => !!detached.nodes[id]),
)

// -- rendering --------------------------------------------------------------

const escaped = applyOperations(
  emptyDocument("<unsafe>"),
  operation.array().parse([
    {
      op: "add",
      nodes: [
        {
          id: "text",
          type: "text",
          x: 0,
          y: 0,
          text: '<script>alert("x")</script>',
          fontSize: 20,
        },
      ],
    },
  ]),
).document
check("markup in a text layer comes out escaped", (() => {
  const svg = renderSvg(escaped).svg
  return svg.includes("&lt;script&gt;") && !svg.includes("<script>")
})())
const typeset = applyOperations(
  emptyDocument("Typeset"),
  operation.array().parse([
    {
      op: "add",
      nodes: [
        {
          id: "t",
          type: "text",
          x: 0,
          y: 0,
          text: "Legible",
          fontSize: 24,
        },
      ],
    },
  ]),
).document
// Vercel functions carry no system fonts: the rasteriser only has the faces
// render.ts vendors, so the SVG has to ask for them by name or every glyph
// comes back a tofu box.
check(
  "the text asks for a face the rasteriser has",
  /font-family="([^"]*)"/.exec(renderSvg(typeset).svg)?.[1]?.includes(
    "Patrick Hand",
  ) === true,
)
const png = await renderPng(renderSvg(typeset).svg)
check(
  "a PNG comes back with a PNG's magic bytes",
  Buffer.isBuffer(png) && same([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]),
)
check(
  "rendering twice gives the same bytes",
  renderSvg(escaped).svg === renderSvg(escaped).svg,
)
check(
  "a variation nobody made is refused",
  refused(() => renderSvg(escaped, "missing")),
)

// -- cropping ---------------------------------------------------------------

const cropped = applyOperations(
  d,
  operation.array().parse([
    {
      op: "update",
      patches: [
        { id: "img", patch: { crop: { x: 0, y: 0, w: 0.5, h: 0.5 } } },
      ],
    },
  ]),
).document
check(
  "a crop lands on the image",
  cropped.nodes.img.type === "image" && !!cropped.nodes.img.crop,
)
const uncropped = applyOperations(
  cropped,
  operation
    .array()
    .parse([{ op: "update", patches: [{ id: "img", unset: ["crop"] }] }]),
).document
check(
  "and unset takes it off again",
  uncropped.nodes.img.type === "image" && !uncropped.nodes.img.crop,
)
check(
  "a variation can be removed",
  applyOperations(
    d,
    operation.array().parse([{ op: "remove_variation", id: "v1" }]),
  ).document.variations.length === 0,
)

// -- merging a shared canvas ------------------------------------------------
// Concurrent human and agent changes both have to survive the round trip.

const { mergeCanvas, canvasEqual } = await import("../lib/agent/merge")
check("key order doesn't count", canvasEqual({ a: 1, b: 2 }, { b: 2, a: 1 }))
check(
  "an undefined field reads as absent, nested",
  canvasEqual(
    { nodes: { a: { text: "Hello", groupIds: undefined } } },
    { nodes: { a: { text: "Hello" } } },
  ),
)
check(
  "…and at the top",
  canvasEqual({ text: "Hello" }, { text: "Hello", groupIds: undefined }),
)
check(
  "but a real value against undefined is a change",
  !canvasEqual({ locked: true }, { locked: undefined }),
)
check("and null is not absent", !canvasEqual({ bind: null }, {}))
const baseCanvas = { nodes: { a: { x: 0, text: "hello" } }, order: ["a"] }
check(
  "two sides editing different fields both land",
  same(
    mergeCanvas(
      baseCanvas,
      { nodes: { a: { x: 10, text: "hello" } }, order: ["a"] },
      { nodes: { a: { x: 0, text: "world" } }, order: ["a"] },
    ),
    {
      value: { nodes: { a: { x: 10, text: "world" } }, order: ["a"] },
      conflicts: [],
    },
  ),
)
check(
  "the same field twice is a conflict",
  same(
    mergeCanvas(
      baseCanvas,
      { nodes: { a: { x: 10, text: "hello" } }, order: ["a"] },
      { nodes: { a: { x: 20, text: "hello" } }, order: ["a"] },
    ).conflicts,
    ["nodes.a.x"],
  ),
)
check(
  "two new nodes both survive",
  same(
    mergeCanvas<Record<string, unknown>>(
      baseCanvas,
      { nodes: { ...baseCanvas.nodes, b: { x: 20 } }, order: ["a", "b"] },
      { nodes: { ...baseCanvas.nodes, c: { x: 30 } }, order: ["a", "c"] },
    ).value,
    {
      nodes: { ...baseCanvas.nodes, b: { x: 20 }, c: { x: 30 } },
      order: ["a", "c", "b"],
    },
  ),
)
check(
  "deleting a node the other side edited is a conflict",
  same(
    mergeCanvas<Record<string, unknown>>(
      baseCanvas,
      { nodes: {}, order: [] },
      { nodes: { a: { x: 20, text: "hello" } }, order: ["a"] },
    ).conflicts,
    ["nodes.a"],
  ),
)
check(
  "two reorderings are a conflict",
  same(
    mergeCanvas(
      { order: ["a", "b", "c"] },
      { order: ["b", "a", "c"] },
      { order: ["a", "c", "b"] },
    ).conflicts,
    ["order"],
  ),
)

// -- an edit response ships only the nodes its batch touched ----------------

const touched = applyOperations(
  d,
  operation.array().parse([
    { op: "update", patches: [{ id: "c", patch: { text: "Changed" } }] },
    { op: "delete", ids: ["draw"] },
    {
      op: "add",
      nodes: [{ id: "fresh", type: "shape", x: 0, y: 600, w: 40, h: 40 }],
    },
  ]),
).document
const diff = diffNodes(d.nodes, touched.nodes)
check(
  "the edited and the new node come back",
  same(Object.keys(diff.changed).sort(), ["c", "fresh"]),
)
check("the deleted one is named", same(diff.deletedIds, ["draw"]))
check("with its new text", (() => {
  const node = diff.changed.c
  return node.type === "text" && node.text === "Changed"
})())
check("an untouched node stays home", diff.changed.a === undefined)
check(
  "no edits, nothing to ship",
  same(diffNodes(d.nodes, d.nodes), { changed: {}, deletedIds: [] }),
)

// -- the command layer ------------------------------------------------------
// An unfiltered catalog stays small, and db() stays lazy.

const { execute, origin } = await import("../lib/agent/service.ts")
type CatalogResult = {
  total: number
  hint?: string
  components: Record<string, unknown>[]
}
const compact = (await execute(
  "catalog",
  {},
  {
    workspaceId: "w",
  },
)) as unknown as CatalogResult
check(
  "the catalog lists every definition",
  compact.components.length === ALL_DEFS.length,
)
check(
  "…with sizes but without the long tail",
  compact.components.every(
    (c) => !!c.size && !("controls" in c) && !("defaults" in c),
  ),
)
check("and says how to ask for more", !!compact.hint?.includes("query or kind"))
const detailed = (await execute(
  "catalog",
  { kind: "button" },
  {
    workspaceId: "w",
  },
)) as unknown as CatalogResult
check("asking by kind narrows it to one", detailed.components.length === 1)
check(
  "and that one carries its controls",
  Array.isArray(detailed.components[0].controls),
)

// -- preview links ride the branch host, not the per-deployment hash --------

delete process.env.SQUIG_PUBLIC_URL
process.env.VERCEL_ENV = "preview"
process.env.VERCEL_URL = "squig-abc123.vercel.app"
process.env.VERCEL_BRANCH_URL = "squig-git-feature.vercel.app"
check(
  "a preview link points at the branch",
  origin() === "https://squig-git-feature.vercel.app",
)
delete process.env.VERCEL_BRANCH_URL
check(
  "without one, at the deployment",
  origin() === "https://squig-abc123.vercel.app",
)
delete process.env.VERCEL_ENV
check("and off Vercel entirely, at squig.sh", origin() === "https://squig.sh")
delete process.env.VERCEL_URL

// -- real face metrics drive both diagnostics and the SVG's line breaks -----

const { textMeasurer, measureDocumentText } = await import(
  "../lib/agent/text-metrics"
)
for (const font of ["hand", "sans", "serif"] as const) {
  const measure = textMeasurer(font)
  check(
    `${font} measures W wider than i`,
    measure("WWWW", { size: 20 }) > measure("iiii", { size: 20 }) * 2,
  )
}
const textDoc = applyOperations(
  emptyDocument("Text metrics"),
  operation
    .array()
    .parse([
      {
        op: "add",
        nodes: [
          {
            id: "overflow",
            type: "text",
            x: 0,
            y: 0,
            w: 70,
            h: 10,
            text: "Wide words wrap here",
            fontSize: 24,
            fixedW: true,
          },
        ],
      },
    ]),
).document
const measured = measureDocumentText(textDoc)[0]
check(
  "a box too short for its words reports the overflow",
  measured.overflowY && measured.lineCount > 1,
)
check(
  "and the render breaks in the same places",
  (renderSvg(textDoc).svg.match(/<text /g) ?? []).length ===
    measured.lineCount,
)
const fitted = applyOperations(
  textDoc,
  operation
    .array()
    .parse([
      {
        op: "update",
        patches: [
          { id: "overflow", patch: { h: measured.requiredHeight } },
        ],
      },
    ]),
).document
check(
  "the height it asked for is the height that fits",
  measureDocumentText(fitted)[0].overflowY === false,
)
const { wrapText } = await import("../lib/canvas/text-metrics")
let measuredCharacters = 0
const longLines = wrapText("a".repeat(10000), 8, { size: 1 }, (t) => {
  measuredCharacters += t.length
  return t.length
})
check(
  "an unbroken word breaks to the box",
  longLines.every((line) => line.length <= 8),
)
check("losing no characters", longLines.join("").length === 10000)
check(
  "long words must not repeatedly measure their entire suffix",
  measuredCharacters < 300000,
  `${measuredCharacters} characters measured`,
)

// -- WebP is accepted by the canvas and must survive agent PNG previews -----

const { default: sharp } = await import("sharp")
const webp = await sharp({
  create: {
    width: 20,
    height: 20,
    channels: 3,
    background: { r: 230, g: 10, b: 50 },
  },
})
  .webp()
  .toBuffer()
const imageDoc = applyOperations(
  emptyDocument("WebP"),
  operation
    .array()
    .parse([
      {
        op: "add",
        nodes: [
          {
            id: "image",
            type: "image",
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            naturalW: 20,
            naturalH: 20,
            src: `data:image/webp;base64,${webp.toString("base64")}`,
          },
        ],
      },
    ]),
).document
const preview = await pngDocument(imageDoc)
check(
  "the preview swapped the picture out",
  preview.nodes.image !== imageDoc.nodes.image,
)
check(
  "and left the stored document as WebP",
  imageDoc.nodes.image.type === "image" &&
    imageDoc.nodes.image.src.startsWith("data:image/webp"),
)
const renderedWebp = await renderPng(renderSvg(preview).svg)
const { data: pixels, info } = await sharp(renderedWebp)
  .raw()
  .toBuffer({ resolveWithObject: true })
const pixel =
  (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) *
  info.channels
check(
  "WebP pixels must be visible in the PNG",
  pixels[pixel] > 200 && pixels[pixel + 1] < 40 && pixels[pixel + 2] < 100,
  `rgb(${pixels[pixel]}, ${pixels[pixel + 1]}, ${pixels[pixel + 2]})`,
)

// ---------------------------------------------------------------------------

report(`agent engine checks passed (${ALL_DEFS.length} library definitions)`)
