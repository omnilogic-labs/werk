import type { RendererFactory, Cell } from "@werk/terminal";
export interface BeamtermOptions {
  wasmUrl?: string | URL;
}
let serial = 0;
/** Importing this package does not fetch or instantiate beamterm WASM. */
export function beamtermRenderer(
  options: BeamtermOptions = {},
): RendererFactory {
  return async ({ mount }) => {
    if (!(mount instanceof HTMLElement))
      throw new TypeError("Renderer mount must be an HTMLElement");
    const bt = await import("@beamterm/renderer/web");
    await bt.default(
      options.wasmUrl ? { module_or_path: options.wasmUrl } : undefined,
    );
    const canvas = document.createElement("canvas");
    canvas.id = `werk-beamterm-${++serial}`;
    mount.append(canvas);
    let renderer: InstanceType<typeof bt.BeamtermRenderer>;
    try {
      renderer = bt.BeamtermRenderer.withDynamicAtlas(
        "#" + canvas.id,
        ["monospace"],
        14,
        false,
      );
    } catch (e) {
      canvas.remove();
      throw e;
    }
    let cols = 0,
      rows = 0,
      disposed = false;
    const shadow: Cell[][] = [];
    return {
      paint(frame) {
        if (disposed) throw new Error("Renderer is disposed");
        if (frame.cols !== cols || frame.rows !== rows) {
          cols = frame.cols;
          rows = frame.rows;
          const size = renderer.cellSize();
          try {
            renderer.resize(
              Math.ceil(cols * size.width),
              Math.ceil(rows * size.height),
            );
          } finally {
            size.free();
          }
        }
        for (const row of frame.changed) shadow[row.y] = row.cells;
        const batch = renderer.batch();
        try {
          for (let y = 0; y < rows; y++)
            for (let x = 0; x < cols; x++) {
              const c = shadow[y]?.[x];
              if (!c || c.width === 0) continue;
              let fg = c.fg,
                bg = c.bg;
              if (c.inverse) [fg, bg] = [bg, fg];
              if (
                frame.cursor.visible &&
                frame.cursor.x === x &&
                frame.cursor.y === y
              )
                [fg, bg] = [bg, fg];
              let style = bt.style().fg(fg).bg(bg);
              if (c.bold) style = style.bold();
              if (c.italic) style = style.italic();
              if (c.underline) style = style.underline();
              if (c.strikethrough) style = style.strikethrough();
              try {
                batch.text(x, y, c.text || " ", style);
              } finally {
                style.free();
              }
            }
          renderer.render();
        } finally {
          batch.free();
        }
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        renderer.free();
        canvas.remove();
      },
    };
  };
}
export const createBeamtermRenderer: RendererFactory = (host) =>
  beamtermRenderer()(host);
