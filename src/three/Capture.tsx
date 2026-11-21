import { addAfterEffect, useThree } from "@react-three/fiber";
import { type Ref, useEffect, useImperativeHandle, useRef } from "react";

export interface CaptureHandle {
  /** The 3D view as a PNG, exactly as on screen (environment, shadows, AO, labels). */
  capture(): Promise<Blob>;
}

/**
 * Screenshot of the canvas without `preserveDrawingBuffer` (which would cost on
 * every frame): ask for one more frame, and read the pixels in R3F's after-effect
 * hook, i.e. right after that frame is drawn and before the browser clears it.
 */
export function Capture({ ref }: { ref?: Ref<CaptureHandle> }) {
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const pending = useRef<{ resolve: (b: Blob) => void; reject: (e: Error) => void }[]>([]);

  useEffect(
    () =>
      addAfterEffect(() => {
        if (!pending.current.length) return;
        const waiting = pending.current;
        pending.current = [];
        // toDataURL copies synchronously, while the frame is still in the buffer
        let url: string;
        try {
          url = gl.domElement.toDataURL("image/png");
        } catch (e) {
          for (const p of waiting) p.reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        void fetch(url)
          .then((r) => r.blob())
          .then((b) => {
            for (const p of waiting) p.resolve(b);
          })
          .catch((e: unknown) => {
            for (const p of waiting) p.reject(e instanceof Error ? e : new Error(String(e)));
          });
      }),
    [gl],
  );

  useImperativeHandle(
    ref,
    () => ({
      capture: () =>
        new Promise<Blob>((resolve, reject) => {
          pending.current.push({ resolve, reject });
          invalidate();
        }),
    }),
    [invalidate],
  );
  return null;
}
