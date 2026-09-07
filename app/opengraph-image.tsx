import { ImageResponse } from "next/og";

import { DOODLE_H, DOODLE_PATHS, DOODLE_W } from "@/lib/sketch/doodle";

export const alt = "A blue doodle of a bear sketching a wireframe";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
// Required for `output: "export"` (webxdc packaging).
export const dynamic = "force-static";

const DOODLE_WIDTH = 840;
const DOODLE_HEIGHT = (DOODLE_WIDTH * DOODLE_H) / DOODLE_W;

// Next serves this card for Twitter too, so there is no twitter-image sibling.
export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#FBFAF5",
        }}
      >
        <svg
          viewBox={`0 0 ${DOODLE_W} ${DOODLE_H}`}
          width={DOODLE_WIDTH}
          height={DOODLE_HEIGHT}
          fill="none"
          stroke="#6E7DFF"
          strokeWidth={1.9}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          {DOODLE_PATHS.map((d, index) => (
            <path key={index} d={d} />
          ))}
        </svg>
      </div>
    ),
    size,
  );
}
