// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasDataGrid } from "./data/CanvasDataGrid";
import { CanvasPivotGrid } from "./pivot/CanvasPivotGrid";

/** A 2D context where every call is a no-op and text measures 7px per char. */
function fakeContext(): CanvasRenderingContext2D {
  const ctx: Record<string | symbol, unknown> = {
    measureText: (s: string) => ({ width: s.length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    createLinearGradient: () => ({ addColorStop() {} }),
  };
  return new Proxy(ctx, {
    get: (t, k) => (k in t ? t[k] : () => undefined),
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

let releaseFonts: () => void;

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => fakeContext() as unknown as ReturnType<HTMLCanvasElement["getContext"]>,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  // Fonts stay "loading" until the test releases them.
  const fontsReady = new Promise<void>((r) => (releaseFonts = r));
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: () => fontsReady.then(() => []) },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const grids = [
  ["CanvasPivotGrid", (host: HTMLElement) => new CanvasPivotGrid(host)],
  ["CanvasDataGrid", (host: HTMLElement) => new CanvasDataGrid(host)],
] as const;

describe.each(grids)("%s.destroy", (name, create) => {
  it("removes everything it added to the host", () => {
    const host = document.createElement("div");
    const grid = create(host);
    expect(host.querySelector("canvas")).not.toBeNull();
    grid.destroy();
    expect(host.childElementCount).toBe(0);
  });

  it("leaves one canvas after a mount, unmount, mount cycle (StrictMode)", () => {
    const host = document.createElement("div");
    create(host).destroy();
    create(host);
    expect(host.querySelectorAll("canvas")).toHaveLength(1);
  });

  it("does not re-measure after destroy when fonts finish loading", async () => {
    const proto = (name === "CanvasPivotGrid" ? CanvasPivotGrid : CanvasDataGrid).prototype as unknown as {
      measure: (fromHeaders: boolean) => void;
    };
    const measure = vi.spyOn(proto, "measure");
    const grid = create(document.createElement("div"));
    grid.destroy();
    measure.mockClear();
    releaseFonts();
    await new Promise((r) => setTimeout(r, 0));
    expect(measure).not.toHaveBeenCalled();
  });
});
