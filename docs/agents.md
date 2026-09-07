# Driving squig as an agent

squig is a wireframing tool: an infinite canvas of UI components that render as
a hand-drawn sketch. A document is a flat map of nodes saved as
[`.squig.json`](format.md), and everything below writes exactly that same file.

There are three doors. Use the first one that fits.

1. **The file door.** You have a shell or an MCP client and you want a
   `.squig.json` on disk that a person can open. This is almost always the one.
2. **The browser door.** The app is already open and you are driving the canvas
   somebody is looking at.
3. **The library door.** You are writing TypeScript in this repo.

---

## 1. The file door

### The CLI

```bash
pnpm squig <command> [...]
```

Negative numbers need the equals form, because node's argument parser cannot
tell `-40` from a flag: `--x=-40`, not `--x -40`.

| command | what it does |
|---|---|
| `components [query]` | the library, one line each: kind, name, group, default size |
| `describe <kind>` | that component's default size, default props and legal prop values |
| `new <file>` | a blank document |
| `ls <file>` | what is on the sheet, bottom to top |
| `add <file> <kind>` | place a component |
| `text <file> "<words>"` | place a text layer |
| `shape <file> rect\|ellipse` | place a rectangle or an ellipse |
| `arrow <file>` | connect two nodes, or two points |
| `set <file> <id>` | change one node |
| `rm\|group\|front\|back <file> <id...>` | remove, group, reorder |
| `render <file>` | the drawing as SVG |
| `validate <file>` | does squig still read this file |

```bash
pnpm squig components card                 # kinds matching "card"
pnpm squig describe button                 # every prop a button takes
pnpm squig new signin.squig.json --name "sign in"
pnpm squig ls signin.squig.json
pnpm squig add signin.squig.json card --x 0 --y 0 --id card1
pnpm squig add signin.squig.json button --x 40 --y 200 --props '{"label":"Sign in"}' --id go
pnpm squig text signin.squig.json "the happy path" --x 40 --y 160 --size 20 --bold --id note
pnpm squig shape signin.squig.json rect --x=-24 --y=-24 --w 320 --h 300 --fill light --dashed
pnpm squig arrow signin.squig.json --from note --to go --style elbow
pnpm squig set signin.squig.json go --patch '{"w":180}'
pnpm squig rm signin.squig.json note
pnpm squig group signin.squig.json card1 go
pnpm squig front signin.squig.json go       # or back
pnpm squig render signin.squig.json --out signin.svg
pnpm squig validate signin.squig.json
```

Every mutating command prints the ids it touched. Anything you got wrong prints
one sentence on stderr and exits 1.

### The MCP server

Same document API, over stdio, for a client that speaks MCP.

Claude Code:

```bash
claude mcp add squig -- pnpm --dir /absolute/path/to/squig mcp
```

Cursor, Codex and anything else that reads an `mcp.json`:

```json
{
  "mcpServers": {
    "squig": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/squig", "mcp"]
    }
  }
}
```

Documents are addressed by absolute path, and a path that does not end in
`.squig.json` is refused.

| tool | what it does |
|---|---|
| `list_components({ query? })` | the library index: kind, name, group, default size |
| `describe_component({ kind })` | one component's default size, props and legal values |
| `create_document({ path, name? })` | a blank document, refusing to overwrite |
| `read_document({ path })` | name, look, bounds, and every node in draw order |
| `add_nodes({ path, nodes })` | components, text, shapes and arrows in one write |
| `update_node({ path, id, patch })` | merge a patch into one node |
| `remove_nodes({ path, ids })` | take nodes off the sheet |
| `group_nodes({ path, ids })` | group them, answering with the new group id |
| `reorder_nodes({ path, ids, to })` | send to `"front"` or `"back"` |
| `render_svg({ path, out?, transparent? })` | the markup, or the path it was written to |

`add_nodes` takes a list tagged by `type`: `component` (`kind, x, y, w?, h?,
props?`), `text` (`text, x, y, fontSize?, w?, align?, bold?, italic?, ink?,
boxed?`), `shape` (`shape, x, y, w, h, fill?, dashed?`) and `arrow` (`from,
to, head?, lineStyle?`), each with an optional `id`. An arrow end is a node id
or an `[x, y]` point, and it may name an id created earlier in the same batch.
One batch is one write, so send a screen as one call rather than twelve.

---

## 2. The browser door

With the app open, `window.squig` edits the canvas somebody is watching. Every
call is synchronous, throws on bad input with a sentence worth reading, lands
in the undo stack (`⌘Z` takes it back) and autosaves.

```js
squig.version                      // the bridge's version
squig.doc()                        // the whole document as a value
squig.serialize()                  // it as .squig.json text
squig.load(json)                   // replace the canvas with a document
squig.add(nodes)                   // nodes built by hand, in one undo step
squig.addComponent(kind, { x, y, w, h, props })
squig.addText("the happy path", { x, y, fontSize, w, align, bold, ink })
squig.addShape("rect", { x, y, w, h, fill, dashed })
squig.addArrow({ from, to, head, lineStyle })
squig.update(id, patch)
squig.remove(ids)
squig.group(ids)                   // the new group id, or null
squig.select(ids)
squig.selection()                  // the ids currently selected
squig.zoomToFit()
squig.zoomTo(ids)
squig.bounds()                     // the world box the drawing covers
squig.components(query)            // the same index as list_components
squig.describe(kind)
squig.svg(ids)                     // markup for those nodes, or the whole sheet
```

```js
squig.addComponent("card", { x: 0, y: 0 })
squig.addText("empty state", { x: 0, y: -40, bold: true })
squig.zoomToFit()
```

---

## 3. The library door

From node or a test inside this repo, [`lib/doc.ts`](../lib/doc.ts) is the
whole API the other two doors are built on. It is pure: every function returns
a new document and leaves its input alone.

```ts
import { addNodes, componentNode, emptyDoc, nodesOf, serializeDoc, textNode } from "@/lib/doc"
import { renderSvg } from "@/lib/sketch/svg"

let doc = emptyDoc("pricing")
doc = addNodes(doc, [componentNode("pricing", { x: 0, y: 0 }), textNode("three tiers", { x: 0, y: -40 })])
writeFileSync("pricing.squig.json", serializeDoc(doc))
console.log(renderSvg(nodesOf(doc), doc.look))
```

Run it the way this repo runs any TypeScript from node:

```bash
node --experimental-strip-types --import ./scripts/register-loader.mjs yourfile.ts
```

---

## How to draw well

The loop: **list, describe, place, render, look, adjust.** `list_components`
before you invent a component that already exists, `describe_component` before
you guess at a prop name, then place things at their default sizes, render the
SVG, and actually read it before you say you are done. A wireframe you have not
looked at is a guess.

**Place at default sizes.** Every component ships the size it was drawn for.
Set `w` and `h` when the layout genuinely needs it, not as a reflex.

**Keep an 8px rhythm.** Positions and gaps in multiples of 8, and 16 to 24px of
air inside a container before its contents start. Things that line up read as
deliberate even in a sketch.

**Real words where a person reads them.** Button labels, nav items, headings,
empty states: write the actual copy. It is where half the design decisions
hide. For body copy nobody is meant to read, drop a `paragraph` or another
placeholder-line component rather than writing sentences to fill the space.

**Stay monochrome and low fidelity.** One ink on paper. No colour, no shadows,
no pixel-precision. The napkin look is the point: nothing looks decided, so the
feedback is about the idea.

**Variations go side by side.** Three takes on one screen belong on one sheet,
spaced apart with a text label over each saying what it is, not in three files.
Comparing is the whole reason to draw three.

**Group what belongs together.** A card and its contents, a nav and its items.
Then a person can move the idea instead of eleven rectangles.

**Lock the background.** If you draw a big rectangle behind everything, give it
`"locked": true` so nobody grabs it by accident when they start editing.
