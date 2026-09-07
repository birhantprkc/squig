// ---------------------------------------------------------------------------
// squig as an MCP server: the same document API as the CLI, over stdio.
//
//   pnpm mcp
//
// Documents are addressed by absolute path, because the agent on the other end
// already has a working directory full of files and no idea what the browser's
// drawer holds. Every tool reads a file, calls into lib/doc.ts, writes it back,
// and answers in the fewest words that are still actionable — a tool result is
// context somebody pays for.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, resolve } from "node:path"
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import {
  DocError, addNodes, arrowNode, bringToFront, componentNode, describeComponent, docBounds,
  emptyDoc, groupNodes, listComponents, nodeLine, nodesOf, parseDoc, removeNodes, sendToBack,
  serializeDoc, shapeNode, textNode, updateNode, type SquigDocument,
} from "@/lib/doc"
import { renderSvg } from "@/lib/sketch/svg"
import type { SquigNode } from "@/lib/types"

const INSTRUCTIONS = `squig draws wireframes that look hand-sketched. A document is one .squig.json file: a flat map of nodes on an infinite sheet, addressed by absolute path, which a person opens in the app with File > Open or by dropping the file on the canvas.

Coordinates are world pixels with y pointing down, and every library component has a sensible default size, so place things at their defaults before you start setting w and h. Start with list_components, then describe_component for the props of the one you picked.

The drawing is monochrome and low fidelity on purpose: one ink on paper, no color, nothing that looks decided. Write real words on anything a person reads out loud (button labels, nav items, headings) and use the lorem-style placeholder components for body copy nobody is meant to read. Put variations side by side on the same sheet with a text label over each rather than in separate files, keep a rough 8px rhythm with 16 to 24px of air inside containers, and group what belongs together. Call render_svg and actually look at the markup before you say you are done.`

const server = new McpServer({ name: "squig", version: "0.1.0" }, { instructions: INSTRUCTIONS })

// -- files -------------------------------------------------------------------

/** The one naming rule: if it isn't a .squig.json, it isn't ours to write over. */
function docPath(p: string): string {
  const abs = resolve(p)
  if (!abs.endsWith(".squig.json")) throw new DocError(`squig documents are named *.squig.json, and "${abs}" isn't`)
  return abs
}

function readDoc(p: string): { path: string; doc: SquigDocument } {
  const path = docPath(p)
  if (!existsSync(path)) throw new DocError(`no file at ${path} — create_document makes one`)
  const doc = parseDoc(readFileSync(path, "utf8"), basename(path).replace(/\.squig\.json$/, ""))
  if (!doc) throw new DocError(`${path} isn't a squig document squig can read`)
  return { path, doc }
}

function writeDoc(path: string, doc: SquigDocument): void {
  writeFileSync(path, serializeDoc(doc) + "\n")
}

// -- registering a tool ------------------------------------------------------

/**
 * Every tool here is the same shape: parse, do one thing, answer in text. The
 * wrapper exists so a DocError arrives as the sentence it is — the library
 * already words its refusals for whoever called, and an agent can act on
 * "no component called X" but not on a stack trace.
 */
function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: S,
  run: (args: z.infer<z.ZodObject<S>>) => string
): void {
  // the cast is the SDK's inference giving up on a shape it can't see through,
  // not a claim about the arguments: they are exactly `inputSchema` parsed
  const cb = (args: z.infer<z.ZodObject<S>>) => {
    try {
      return { content: [{ type: "text" as const, text: run(args) }] }
    } catch (err) {
      if (err instanceof DocError) return { content: [{ type: "text" as const, text: err.message }], isError: true }
      throw err
    }
  }
  server.registerTool(name, { description, inputSchema }, cb as unknown as ToolCallback<S>)
}

const r = (v: number) => String(Math.round(v))

// -- the library -------------------------------------------------------------

tool(
  "list_components",
  "The squig component library as one line each (kind, name, group, default size). Filter with a query, or omit it for everything. Start here before placing anything.",
  { query: z.string().optional().describe("matches name, kind, group and keywords") },
  ({ query }) => {
    const found = listComponents(query ?? "")
    if (!found.length) throw new DocError(`nothing in the library matches "${query}"`)
    return found.map((d) => `${d.kind}  ${d.name}  ${d.group ?? d.category}  ${d.size.w}×${d.size.h}`).join("\n")
  }
)

tool(
  "describe_component",
  "Everything needed to place one component: its default size, its default props, and the controls that say which prop values are legal.",
  { kind: z.string().describe('a registry kind, like "button"') },
  ({ kind }) => {
    const info = describeComponent(kind)
    if (!info) throw new DocError(`no component called "${kind}" — list_components("${kind}") will show what there is`)
    return JSON.stringify(info, null, 2)
  }
)

// -- documents ---------------------------------------------------------------

const path = z.string().describe("absolute path to a .squig.json")

tool(
  "create_document",
  "Write a blank squig document at an absolute *.squig.json path. Refuses to overwrite one that is already there.",
  { path, name: z.string().optional().describe("the name shown in the app; defaults to the file name") },
  ({ path: p, name }) => {
    const abs = docPath(p)
    if (existsSync(abs)) throw new DocError(`${abs} is already there — read_document to see what's in it`)
    writeDoc(abs, emptyDoc(name ?? basename(abs).replace(/\.squig\.json$/, "")))
    return `wrote ${abs}`
  }
)

tool(
  "read_document",
  "What a document holds: its name, look, world bounds, and every node in draw order, bottom to top.",
  { path },
  ({ path: p }) => {
    const { doc } = readDoc(p)
    const box = docBounds(doc)
    return [
      `${doc.fileName} — ${doc.order.length} nodes`,
      `look: ${doc.look.theme}, ${doc.look.paper} paper, ${doc.look.font} type, grid ${doc.look.grid ? "on" : "off"}`,
      box ? `bounds: ${r(box.minX)} ${r(box.minY)} ${r(box.maxX - box.minX)}×${r(box.maxY - box.minY)}` : "bounds: blank sheet",
      "",
      ...nodesOf(doc).map(nodeLine),
    ].join("\n")
  }
)

// -- editing -----------------------------------------------------------------

const n = z.number()
const opt = z.number().optional()
const bit = z.boolean().optional()
const id = z.string().optional().describe("your own id for the node; one is minted otherwise")
const end = z.union([z.string(), z.tuple([n, n])])

const nodeSpec = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("component"), kind: z.string(), x: n, y: n, w: opt, h: opt,
    props: z.record(z.string(), z.unknown()).optional().describe("overrides on the def's defaults"), id,
  }),
  z.object({
    type: z.literal("text"), text: z.string(), x: n, y: n, fontSize: opt,
    w: opt.describe("a measure to wrap to; omit and the box hugs the words"),
    align: z.enum(["left", "center", "right"]).optional(), bold: bit, italic: bit,
    ink: z.enum(["ink", "muted", "faint"]).optional(), boxed: bit, id,
  }),
  z.object({
    type: z.literal("shape"), shape: z.enum(["rect", "ellipse"]), x: n, y: n, w: n, h: n,
    fill: z.enum(["none", "paper", "light", "strong"]).optional(), dashed: bit, id,
  }),
  z.object({
    type: z.literal("arrow"),
    from: end.describe("a node id to stick to, or an [x, y] point"), to: end,
    head: bit, lineStyle: z.enum(["straight", "elbow", "curved"]).optional(), id,
  }),
])

tool(
  "add_nodes",
  "Add components, text, shapes and arrows to a document in one write. Nodes land in the order given, and an arrow may name an id created earlier in the same batch.",
  { path, nodes: z.array(nodeSpec).min(1) },
  ({ path: p, nodes }) => {
    const { path: abs, doc } = readDoc(p)
    // arrows bind by id, so build against the document as it grows rather than
    // as it was — otherwise a batch can't point at its own work
    const growing: Record<string, SquigNode> = { ...doc.nodes }
    const built: SquigNode[] = []
    for (const spec of nodes) {
      const node =
        spec.type === "component"
          ? componentNode(spec.kind, spec)
          : spec.type === "text"
            ? textNode(spec.text, spec)
            : spec.type === "shape"
              ? shapeNode(spec.shape, spec)
              : arrowNode(spec, growing)
      growing[node.id] = node
      built.push(node)
    }
    writeDoc(abs, addNodes(doc, built))
    return `added ${built.map((b) => b.id).join(" ")}`
  }
)

tool(
  "update_node",
  "Change one node in place. The patch merges over what's there; a text node re-fits its box to new words, size or measure.",
  { path, id: z.string(), patch: z.record(z.string(), z.unknown()) },
  ({ path: p, id: which, patch }) => {
    const { path: abs, doc } = readDoc(p)
    writeDoc(abs, updateNode(doc, which, patch as Partial<SquigNode>))
    return `changed ${which}`
  }
)

tool(
  "remove_nodes",
  "Take nodes off the sheet. An arrow aimed at one lets go and stays where it was drawn.",
  { path, ids: z.array(z.string()).min(1) },
  ({ path: p, ids }) => {
    const { path: abs, doc } = readDoc(p)
    writeDoc(abs, removeNodes(doc, ids))
    return `removed ${ids.join(" ")}`
  }
)

tool(
  "group_nodes",
  "Group nodes so they move as one, the way command-G does in the app. Answers with the new group id, or says there was nothing to group.",
  { path, ids: z.array(z.string()).min(2) },
  ({ path: p, ids }) => {
    const { path: abs, doc } = readDoc(p)
    const grouped = groupNodes(doc, ids)
    if (!grouped) return "nothing to group: fewer than two of those are on the sheet, or that group is already whole"
    writeDoc(abs, grouped.doc)
    return `grouped ${ids.join(" ")} as ${grouped.groupId}`
  }
)

tool(
  "reorder_nodes",
  "Move nodes to the front or the back of the draw order. Later in the order means drawn on top.",
  { path, ids: z.array(z.string()).min(1), to: z.enum(["front", "back"]) },
  ({ path: p, ids, to }) => {
    const { path: abs, doc } = readDoc(p)
    for (const which of ids) if (!doc.nodes[which]) throw new DocError(`no node called "${which}"`)
    writeDoc(abs, to === "front" ? bringToFront(doc, ids) : sendToBack(doc, ids))
    return `sent ${ids.join(" ")} to the ${to}`
  }
)

/** Past this much markup, an SVG stops being something to read and becomes a file. */
const INLINE_LIMIT = 200_000

tool(
  "render_svg",
  "Draw the document as SVG so you can check your work before a person opens it. Returns the markup, or the path it was written to when it is too big to read.",
  {
    path,
    out: z.string().optional().describe("where to write the SVG; defaults to next to the document"),
    transparent: z.boolean().optional().describe("no paper behind the drawing"),
  },
  ({ path: p, out, transparent }) => {
    const { path: abs, doc } = readDoc(p)
    const svg = renderSvg(nodesOf(doc), doc.look, transparent ? "transparent" : "paper")
    if (!svg) throw new DocError("nothing on the sheet to draw")
    if (svg.length <= INLINE_LIMIT && !out) return svg
    const target = out ? resolve(out) : abs.replace(/\.squig\.json$/, ".svg")
    writeFileSync(target, svg + "\n")
    return `wrote ${target} (${Math.round(svg.length / 1024)} KB)`
  }
)

await server.connect(new StdioServerTransport())
