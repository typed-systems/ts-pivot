import { useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { BatchedText, Text } from "troika-three-text";

/**
 * troika's BatchedText packs each member colour as a hex number and the shader
 * uses it as linear RGB, so an sRGB colour comes out too light (a near-black
 * label rendered mid-grey). Hand it the linear value's hex instead; three's
 * sRGB round trip in troika then leaves that number unchanged.
 */
const tmpColor = new THREE.Color();
function batchColor(css: string): number {
  return tmpColor.set(css).getHex(THREE.LinearSRGBColorSpace);
}

export interface LabelItem {
  text: string;
  x: number;
  z: number;
  /** Rotation around the floor normal (0 = reads along +x). */
  turn: number;
  anchorX: "left" | "right";
  color: string;
}

/**
 * Axis labels as one troika `BatchedText`: every label is a member `Text`, but
 * they all draw in a single call and share one glyph atlas. The members are
 * pooled and reused while you scroll, so a new window only re-lays out the
 * strings that changed instead of creating and disposing meshes.
 */
export function AxisLabels({
  items,
  font,
  fontSize = 0.45,
  y = 0.02,
}: {
  items: LabelItem[];
  font: string;
  fontSize?: number;
  y?: number;
}) {
  const invalidate = useThree((s) => s.invalidate);
  const batch = useMemo(() => {
    const b = new BatchedText();
    b.font = font;
    b.fontSize = fontSize;
    b.rotation.x = -Math.PI / 2; // lie flat on the floor
    b.raycast = () => {};
    b.frustumCulled = false;
    return b;
  }, [font, fontSize]);
  const pool = useRef<Text[]>([]);
  const active = useRef(0);

  // Async layout (worker) -> redraw once the glyphs are in, since frameloop="demand".
  useEffect(() => {
    const done = () => invalidate();
    batch.addEventListener("synccomplete" as never, done);
    return () => {
      batch.removeEventListener("synccomplete" as never, done);
      // Take the members out of the batch, not just out of our pool: React may
      // run this cleanup and then the effects again on the same batch (StrictMode
      // in dev does exactly that), and members left behind would keep drawing
      // their old labels at their old positions.
      for (const t of pool.current) {
        batch.removeText(t);
        t.dispose();
      }
      pool.current = [];
      active.current = 0;
      batch.dispose();
    };
  }, [batch, invalidate]);

  useLayoutEffect(() => {
    const p = pool.current;
    while (p.length < items.length) {
      const t = new Text();
      t.font = font;
      t.fontSize = fontSize;
      t.anchorY = "middle";
      p.push(t);
    }
    // grow / shrink the set of batch members
    for (let i = active.current; i < items.length; i++) batch.addText(p[i]!);
    for (let i = items.length; i < active.current; i++) batch.removeText(p[i]!);
    active.current = items.length;

    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const t = p[i]!;
      // troika only re-lays out when text/anchor actually change
      if (t.text !== it.text) t.text = it.text;
      if (t.anchorX !== it.anchorX) t.anchorX = it.anchorX;
      t.color = batchColor(it.color);
      // batch is rotated flat, so its local (x, y) is world (x, -z)
      t.position.set(it.x, -it.z, y);
      t.rotation.set(0, 0, it.turn);
    }
    batch.visible = items.length > 0; // an empty batch has no data texture to bind
    invalidate();
  }, [items, batch, font, fontSize, y, invalidate]);

  return <primitive object={batch} />;
}
