import { rasterizeImageSource } from "../clipboard"
import type { SquigDoc, SquigNode } from "../types"

/** Only the shared copy changes; a failed connection leaves the local file intact. */
export async function prepareCanvas<T extends SquigDoc>(doc: T, rasterize = rasterizeImageSource): Promise<T> {
  const nodes = { ...doc.nodes }
  for (const [id, node] of Object.entries(nodes)) {
    if (node.type !== "image" || !/^data:image\/svg\+xml[;,]/i.test(node.src)) continue
    try {
      const src = await rasterize(node.src)
      if (!/^data:image\/(png|jpeg|webp|gif);base64,/i.test(src)) throw new Error("Not a raster")
      nodes[id] = { ...node, src }
    } catch {
      throw new Error(`Could not prepare the SVG image “${node.name || id}” for sharing. Replace it with a PNG, JPEG, WebP or GIF and try again. Your local canvas is unchanged.`)
    }
  }
  return { ...doc, nodes }
}

/** Preserve edits made during upload, including replacing an image's source. */
export function applyPreparedImages(nodes: Record<string, SquigNode>, original: SquigDoc, prepared: SquigDoc) {
  return Object.fromEntries(Object.entries(nodes).map(([id, node]) => {
    const before = original.nodes[id], after = prepared.nodes[id]
    return [id, node.type === "image" && before?.type === "image" && after?.type === "image" &&
      node.src === before.src && before.src !== after.src ? { ...node, src: after.src } : node]
  }))
}
