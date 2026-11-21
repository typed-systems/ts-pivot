// Minimal typings for the parts of troika-three-text used here (it ships none).
declare module "troika-three-text" {
  import type { ColorRepresentation, Mesh } from "three";

  export class Text extends Mesh {
    text: string;
    font: string | null;
    fontSize: number;
    color: ColorRepresentation | null;
    anchorX: number | "left" | "center" | "right" | string;
    anchorY: number | "top" | "top-baseline" | "middle" | "bottom-baseline" | "bottom" | string;
    sync(callback?: () => void): void;
    dispose(): void;
  }

  /** Renders any number of member Text objects in one draw call. */
  export class BatchedText extends Text {
    addText(text: Text): void;
    removeText(text: Text): void;
  }
}
