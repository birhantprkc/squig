// ---------------------------------------------------------------------------
// Smart Guides — Snap Engine
// ---------------------------------------------------------------------------
// Pure calculation engine for alignment snapping. No React, no store.
// All calculations in screen space (overlay-relative pixels) so the snap
// threshold feels consistent regardless of zoom level.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A rectangle in screen-space overlay coordinates. */
export interface SnapRect {
  id: string
  left: number
  top: number
  width: number
  height: number
  /** center x = left + width / 2 */
  cx: number
  /** center y = top + height / 2 */
  cy: number
}

/** A guide line to render on the overlay. */
export interface GuideLine {
  axis: "x" | "y"
  /** For axis='x' this is the x position; for axis='y' this is the y position */
  position: number
  /** Extent start (min of aligned elements) */
  start: number
  /** Extent end (max of aligned elements) */
  end: number
}

/** A distance indicator between two edges. */
interface DistanceIndicator {
  axis: "x" | "y"
  /** Pixel distance */
  distance: number
  /** Line start */
  x1: number
  y1: number
  /** Line end */
  x2: number
  y2: number
  /** Label position */
  labelX: number
  labelY: number
}

/** Result of a snap calculation. */
export interface SnapResult {
  /** Screen-space delta to apply */
  dx: number
  dy: number
  /** Guide lines to render */
  guides: GuideLine[]
  /** Distance indicators to render */
  distances: DistanceIndicator[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function makeSnapRect(
  id: string,
  left: number,
  top: number,
  width: number,
  height: number
): SnapRect {
  return { id, left, top, width, height, cx: left + width / 2, cy: top + height / 2 }
}

/** Extract 3 snap positions per axis. */
function getEdges(r: SnapRect): { x: number[]; y: number[] } {
  return {
    x: [r.left, r.cx, r.left + r.width],
    y: [r.top, r.cy, r.top + r.height],
  }
}

// ---------------------------------------------------------------------------
// computeSnap — Core snapping algorithm
// ---------------------------------------------------------------------------

/**
 * Compare the dragged rect's edges/centers against all candidate edges.
 * For each axis independently, find the smallest delta within `threshold`.
 * Returns the snap delta (screen px) and guide lines to render.
 */
export function computeSnap(
  dragged: SnapRect,
  candidates: SnapRect[],
  threshold: number,
  parent?: SnapRect
): SnapResult {
  const allCandidates = parent ? [parent, ...candidates] : candidates
  const dragEdges = getEdges(dragged)
  const guides: GuideLine[] = []

  let bestDx = Infinity
  let bestDy = Infinity
  const xMatches: { pos: number; rects: SnapRect[]; dragEdgeIdx: number }[] = []
  const yMatches: { pos: number; rects: SnapRect[]; dragEdgeIdx: number }[] = []

  // Check X axis (vertical guide lines)
  for (let di = 0; di < dragEdges.x.length; di++) {
    const dragPos = dragEdges.x[di]
    for (const cand of allCandidates) {
      if (cand.id === dragged.id) continue
      const candEdges = getEdges(cand)
      for (const candPos of candEdges.x) {
        const delta = candPos - dragPos
        const absDelta = Math.abs(delta)
        if (absDelta > threshold) continue
        if (absDelta < Math.abs(bestDx)) {
          bestDx = delta
          xMatches.length = 0
          xMatches.push({ pos: candPos, rects: [cand], dragEdgeIdx: di })
        } else if (absDelta === Math.abs(bestDx) && delta === bestDx) {
          // Same delta — collect for multi-element guides
          const existing = xMatches.find((m) => m.pos === candPos)
          if (existing) {
            existing.rects.push(cand)
          } else {
            xMatches.push({ pos: candPos, rects: [cand], dragEdgeIdx: di })
          }
        }
      }
    }
  }

  // Check Y axis (horizontal guide lines)
  for (let di = 0; di < dragEdges.y.length; di++) {
    const dragPos = dragEdges.y[di]
    for (const cand of allCandidates) {
      if (cand.id === dragged.id) continue
      const candEdges = getEdges(cand)
      for (const candPos of candEdges.y) {
        const delta = candPos - dragPos
        const absDelta = Math.abs(delta)
        if (absDelta > threshold) continue
        if (absDelta < Math.abs(bestDy)) {
          bestDy = delta
          yMatches.length = 0
          yMatches.push({ pos: candPos, rects: [cand], dragEdgeIdx: di })
        } else if (absDelta === Math.abs(bestDy) && delta === bestDy) {
          const existing = yMatches.find((m) => m.pos === candPos)
          if (existing) {
            existing.rects.push(cand)
          } else {
            yMatches.push({ pos: candPos, rects: [cand], dragEdgeIdx: di })
          }
        }
      }
    }
  }

  const dx = isFinite(bestDx) ? bestDx : 0
  const dy = isFinite(bestDy) ? bestDy : 0

  // Build guide lines for X matches (vertical lines)
  const snappedDragged = makeSnapRect(
    dragged.id,
    dragged.left + dx,
    dragged.top + dy,
    dragged.width,
    dragged.height
  )

  for (const match of xMatches) {
    // Compute the vertical extent of the guide line
    const allRects = [...match.rects, snappedDragged]
    let minY = Infinity
    let maxY = -Infinity
    for (const r of allRects) {
      minY = Math.min(minY, r.top)
      maxY = Math.max(maxY, r.top + r.height)
    }
    guides.push({
      axis: "x",
      position: match.pos,
      start: minY,
      end: maxY,
    })
  }

  // Build guide lines for Y matches (horizontal lines)
  for (const match of yMatches) {
    const allRects = [...match.rects, snappedDragged]
    let minX = Infinity
    let maxX = -Infinity
    for (const r of allRects) {
      minX = Math.min(minX, r.left)
      maxX = Math.max(maxX, r.left + r.width)
    }
    guides.push({
      axis: "y",
      position: match.pos,
      start: minX,
      end: maxX,
    })
  }

  return { dx, dy, guides, distances: [] }
}

// ---------------------------------------------------------------------------
// computeResizeSnap — Snap only the edges being resized
// ---------------------------------------------------------------------------

/**
 * During resize, only the moving edge(s) should snap.
 * `handle` is the resize handle string like "nw", "e", "se", etc.
 */
export function computeResizeSnap(
  dragged: SnapRect,
  handle: string,
  candidates: SnapRect[],
  threshold: number,
  parent?: SnapRect
): SnapResult {
  const allCandidates = parent ? [parent, ...candidates] : candidates
  const guides: GuideLine[] = []

  // Determine which edges are moving
  const movingLeft = handle.includes("w")
  const movingRight = handle.includes("e")
  const movingTop = handle.includes("n")
  const movingBottom = handle.includes("s")

  // Collect the drag positions to test for each axis
  const testX: number[] = []
  if (movingLeft) testX.push(dragged.left)
  if (movingRight) testX.push(dragged.left + dragged.width)

  const testY: number[] = []
  if (movingTop) testY.push(dragged.top)
  if (movingBottom) testY.push(dragged.top + dragged.height)

  let bestDx = Infinity
  let bestDy = Infinity
  const xMatches: { pos: number; rects: SnapRect[] }[] = []
  const yMatches: { pos: number; rects: SnapRect[] }[] = []

  // X axis
  for (const dragPos of testX) {
    for (const cand of allCandidates) {
      if (cand.id === dragged.id) continue
      const candEdges = getEdges(cand)
      for (const candPos of candEdges.x) {
        const delta = candPos - dragPos
        const absDelta = Math.abs(delta)
        if (absDelta > threshold) continue
        if (absDelta < Math.abs(bestDx)) {
          bestDx = delta
          xMatches.length = 0
          xMatches.push({ pos: candPos, rects: [cand] })
        } else if (absDelta === Math.abs(bestDx) && delta === bestDx) {
          const existing = xMatches.find((m) => m.pos === candPos)
          if (existing) existing.rects.push(cand)
          else xMatches.push({ pos: candPos, rects: [cand] })
        }
      }
    }
  }

  // Y axis
  for (const dragPos of testY) {
    for (const cand of allCandidates) {
      if (cand.id === dragged.id) continue
      const candEdges = getEdges(cand)
      for (const candPos of candEdges.y) {
        const delta = candPos - dragPos
        const absDelta = Math.abs(delta)
        if (absDelta > threshold) continue
        if (absDelta < Math.abs(bestDy)) {
          bestDy = delta
          yMatches.length = 0
          yMatches.push({ pos: candPos, rects: [cand] })
        } else if (absDelta === Math.abs(bestDy) && delta === bestDy) {
          const existing = yMatches.find((m) => m.pos === candPos)
          if (existing) existing.rects.push(cand)
          else yMatches.push({ pos: candPos, rects: [cand] })
        }
      }
    }
  }

  const dx = isFinite(bestDx) ? bestDx : 0
  const dy = isFinite(bestDy) ? bestDy : 0

  // Build guide lines
  const snappedDragged = makeSnapRect(
    dragged.id,
    dragged.left + (movingLeft ? dx : 0),
    dragged.top + (movingTop ? dy : 0),
    dragged.width + (movingRight ? dx : movingLeft ? -dx : 0),
    dragged.height + (movingBottom ? dy : movingTop ? -dy : 0)
  )

  for (const match of xMatches) {
    const allRects = [...match.rects, snappedDragged]
    let minY = Infinity
    let maxY = -Infinity
    for (const r of allRects) {
      minY = Math.min(minY, r.top)
      maxY = Math.max(maxY, r.top + r.height)
    }
    guides.push({ axis: "x", position: match.pos, start: minY, end: maxY })
  }

  for (const match of yMatches) {
    const allRects = [...match.rects, snappedDragged]
    let minX = Infinity
    let maxX = -Infinity
    for (const r of allRects) {
      minX = Math.min(minX, r.left)
      maxX = Math.max(maxX, r.left + r.width)
    }
    guides.push({ axis: "y", position: match.pos, start: minX, end: maxX })
  }

  return { dx, dy, guides, distances: [] }
}
