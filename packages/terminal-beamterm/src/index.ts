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
    // A batch updates the cells it is given and keeps every cell it is not, so
    // a paint emits the rows the frame changed plus the two cells the cursor
    // left and entered. A size change emits the whole grid.
    let cursorX = -1,
      cursorY = -1;
    return {
      paint(frame) {
        if (disposed) throw new Error("Renderer is disposed");
        let everything = false;
        if (frame.cols !== cols || frame.rows !== rows) {
          cols = frame.cols;
          rows = frame.rows;
          everything = true;
          shadow.length = 0;
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
        const wasX = cursorX,
          wasY = cursorY;
        cursorX = frame.cursor.visible ? frame.cursor.x : -1;
        cursorY = frame.cursor.visible ? frame.cursor.y : -1;
        const batch = renderer.batch();
        try {
          const emitted = new Set<number>();
          const emitCell = (x: number, y: number) => {
            const c = shadow[y]?.[x];
            if (!c || c.width === 0) return;
            let fg = c.fg,
              bg = c.bg;
            if (c.inverse) [fg, bg] = [bg, fg];
            if (x === cursorX && y === cursorY) [fg, bg] = [bg, fg];
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
          };
          const emitRow = (y: number) => {
            if (y < 0 || y >= rows || emitted.has(y)) return;
            emitted.add(y);
            for (let x = 0; x < cols; x++) emitCell(x, y);
          };
          if (everything) for (let y = 0; y < rows; y++) emitRow(y);
          else for (const row of frame.changed) emitRow(row.y);
          if (wasX !== cursorX || wasY !== cursorY) {
            const moved: [number, number][] = [
              [wasX, wasY],
              [cursorX, cursorY],
            ];
            for (const [x, y] of moved)
              if (x >= 0 && x < cols && y >= 0 && y < rows && !emitted.has(y))
                emitCell(x, y);
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
