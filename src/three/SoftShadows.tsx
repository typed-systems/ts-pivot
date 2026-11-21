import { useFrame, useThree } from "@react-three/fiber";
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useMemo } from "react";
import * as THREE from "three";

/**
 * Soft floor shadows that build up over a few frames, after drei's
 * `AccumulativeShadows` + `RandomizedLight` (itself after zalo's progressive
 * light map). Each frame a handful of shadow-casting lights are jittered
 * around a main direction, partly spread over the whole sky for an ambient-
 * occlusion look, and the lit floor is averaged into a texture. A plane on the
 * floor shows the result as a transparent shadow.
 *
 * Differences from the drei version, which made it render dark here:
 *  - The buffers start fully lit (white), not black. drei starts black and
 *    hides the plane until enough frames have passed; with `frameloop="demand"`
 *    those frames may never come, so the floor stayed black.
 *  - `refresh()` keeps the old map and blends new frames in, so shadows morph
 *    when the bars change (e.g. while scrolling) instead of blinking out.
 *  - Meshes that don't cast shadows are hidden during the pass rather than
 *    getting a swapped material (drei Text manages its own material), and the
 *    scene is collected on every pass, so labels added later can't leak in.
 *  - Falls back to 8-bit buffers where half-float render targets aren't available.
 */
export interface SoftShadowsHandle {
  /** Re-accumulate after the shadow casters changed. */
  refresh(): void;
}

interface Props {
  ref?: Ref<SoftShadowsHandle>;
  /** Plane size on the floor (x, z) and its centre. */
  width: number;
  depth: number;
  center?: [number, number];
  y?: number;
  /** Main light position; the shadow points away from it. */
  light: [number, number, number];
  /** Jitter of the main light, in world units (bigger = softer penumbra). */
  radius: number;
  /** Share of lights spread over the sky instead of near the main one (0..1). */
  ambient?: number;
  /** Lights per frame. */
  amount?: number;
  /** Frames accumulated after each change, and the averaging window. */
  frames?: number;
  blend?: number;
  resolution?: number;
  mapSize?: number;
  color: string;
  opacity: number;
  /** Contrast: how fast partial shade turns into full shadow (1 = linear). */
  gain?: number;
}

const SHADOW_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
  }`;
const SHADOW_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D map;
  uniform vec3 color;
  uniform float opacity;
  uniform float gain;
  uniform float ref; // what an unshadowed point accumulates (see "ref" in the pass)
  void main() {
    vec3 lit = texture2D(map, vUv).rgb;
    // Occlusion relative to open floor: exactly 0 where nothing blocks the light,
    // so the plane itself never shows as a grey square. The small offset eats
    // half-float rounding noise.
    float occ = 1.0 - (lit.r + lit.g + lit.b) / (3.0 * ref);
    float a = clamp((occ - 0.01) * gain, 0.0, 1.0);
    gl_FragColor = vec4(color, a * opacity);
    #include <colorspace_fragment>
  }`;

/** Off-screen vertex, so casters cost only their vertex shader in the light-map pass. */
const discard = new THREE.ShaderMaterial({
  vertexShader: "void main() { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); }",
  fragmentShader: "void main() { discard; }",
});

export function SoftShadows({
  ref,
  width,
  depth,
  center = [0, 0],
  y = 0.003,
  light,
  radius,
  ambient = 0.35,
  amount = 8,
  frames = 60,
  blend = 20,
  resolution = 1024,
  mapSize = 1024,
  color,
  opacity,
  gain = 1.5,
}: Props) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const invalidate = useThree((s) => s.invalidate);

  // ---- buffers + the material that writes the lit floor into them
  // biome-ignore lint/correctness/useExhaustiveDependencies: blend is applied to the existing buffers below; changing it must not rebuild them
  const plm = useMemo(() => {
    const half = gl.extensions.has("EXT_color_buffer_float") || gl.extensions.has("EXT_color_buffer_half_float");
    const opts = {
      type: half ? THREE.HalfFloatType : THREE.UnsignedByteType,
      magFilter: THREE.LinearFilter,
      minFilter: THREE.LinearFilter,
      depthBuffer: false,
    };
    const a = new THREE.WebGLRenderTarget(resolution, resolution, opts);
    const b = new THREE.WebGLRenderTarget(resolution, resolution, opts);
    const previous = { value: a.texture };
    const window = { value: blend };
    const target = new THREE.MeshLambertMaterial({ fog: false });
    target.onBeforeCompile = (shader) => {
      // Draw the plane in UV space, so the render fills the light map.
      shader.vertexShader =
        "varying vec2 vUv2;\n" +
        shader.vertexShader.slice(0, -1) +
        "vUv2 = uv; gl_Position = vec4((uv - 0.5) * 2.0, 1.0, 1.0); }";
      const body = shader.fragmentShader.indexOf("void main() {");
      shader.fragmentShader =
        "varying vec2 vUv2;\nuniform sampler2D previousMap;\nuniform float averagingWindow;\n" +
        shader.fragmentShader.slice(0, body) +
        shader.fragmentShader.slice(body, -1) +
        `\n  vec3 old = texture2D(previousMap, vUv2).rgb;
  gl_FragColor.rgb = mix(old, gl_FragColor.rgb, 1.0 / averagingWindow);
}`;
      shader.uniforms.previousMap = previous;
      shader.uniforms.averagingWindow = window;
    };
    target.customProgramCacheKey = () => "soft-shadow-target";
    return { a, b, previous, window, target, flip: false };
  }, [gl, resolution]);
  plm.window.value = blend;

  const shadowMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          map: { value: null },
          color: { value: new THREE.Color() },
          opacity: { value: 1 },
          gain: { value: 1.5 },
          ref: { value: 1 },
        },
        vertexShader: SHADOW_VERT,
        fragmentShader: SHADOW_FRAG,
        transparent: true,
        depthWrite: false,
      }),
    [],
  );
  shadowMat.uniforms.color!.value.set(color);
  shadowMat.uniforms.opacity!.value = opacity;
  shadowMat.uniforms.gain!.value = gain;

  const plane = useMemo(() => {
    const m = new THREE.Mesh<THREE.PlaneGeometry, THREE.Material>(new THREE.PlaneGeometry(1, 1), shadowMat);
    m.rotation.x = -Math.PI / 2;
    m.receiveShadow = true;
    m.frustumCulled = false; // the light-map pass draws it in UV space, whatever the camera sees
    m.raycast = () => {};
    return m;
  }, [shadowMat]);

  // ---- the jittered lights (only visible during the light-map pass)
  const lights = useMemo(() => {
    const g = new THREE.Group();
    g.visible = false;
    for (let i = 0; i < amount; i++) {
      const l = new THREE.DirectionalLight(0xffffff, Math.PI / amount);
      l.castShadow = true;
      l.shadow.bias = -0.0005;
      l.shadow.normalBias = 0.02;
      g.add(l);
    }
    return g;
  }, [amount]);

  const size = Math.max(width, depth);
  const len = Math.hypot(...light);
  useLayoutEffect(() => {
    const ext = size * 0.75 + 2;
    for (const o of lights.children) {
      const l = o as THREE.DirectionalLight;
      l.shadow.mapSize.set(mapSize, mapSize);
      l.shadow.map?.dispose();
      l.shadow.map = null; // re-created at the new size
      const cam = l.shadow.camera;
      cam.left = cam.bottom = -ext;
      cam.right = cam.top = ext;
      cam.near = 0.1;
      cam.far = len * 2 + size;
      cam.updateProjectionMatrix();
    }
  }, [lights, size, len, mapSize]);

  // `ref` follows the light level of open, unshadowed floor through the same
  // running average as the light map (buffers start white = 1).
  const state = useMemo(() => ({ count: 0, ref: 1 }), []);

  const clear = () => {
    const prev = gl.getRenderTarget();
    const c = gl.getClearColor(new THREE.Color());
    const a = gl.getClearAlpha();
    gl.setClearColor(0xffffff, 1); // fully lit
    for (const t of [plm.a, plm.b]) {
      gl.setRenderTarget(t);
      gl.clear(true, false, false);
    }
    gl.setRenderTarget(prev);
    gl.setClearColor(c, a);
  };

  const jitter = () => {
    for (const o of lights.children) {
      if (Math.random() > ambient) {
        o.position.set(
          light[0] + THREE.MathUtils.randFloatSpread(radius),
          light[1] + THREE.MathUtils.randFloatSpread(radius),
          light[2] + THREE.MathUtils.randFloatSpread(radius),
        );
      } else {
        // anywhere on the upper hemisphere, same distance
        const lambda = Math.acos(2 * Math.random() - 1) - Math.PI / 2;
        const phi = 2 * Math.PI * Math.random();
        o.position.set(
          Math.cos(lambda) * Math.cos(phi) * len,
          Math.abs(Math.cos(lambda) * Math.sin(phi) * len) + 0.5,
          Math.sin(lambda) * len,
        );
      }
    }
  };

  const pass = () => {
    // Everything else either goes invisible or, if it casts shadows, draws nothing
    // but still lands in the shadow maps. Scene lights are switched off.
    const hidden: THREE.Object3D[] = [];
    const swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
    const dimmed: [THREE.Light, number][] = [];
    scene.traverse((o) => {
      if (o === plane || o === lights || o.parent === lights) return;
      if ((o as THREE.Light).isLight) {
        const l = o as THREE.Light;
        dimmed.push([l, l.intensity]);
        l.intensity = 0;
      } else if ((o as THREE.Mesh).isMesh && o.castShadow && o.visible) {
        const m = o as THREE.Mesh;
        swapped.push([m, m.material]);
        m.material = discard;
      } else if (o.visible && ((o as THREE.Mesh).isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints)) {
        hidden.push(o);
        o.visible = false;
      }
    });
    const bg = scene.background;
    const env = scene.environment;
    scene.background = null;
    scene.environment = null;
    lights.visible = true;
    plane.material = plm.target;

    jitter();
    // Unshadowed Lambert floor (normal up, white): each light adds
    // (intensity / π) · cos θ = cos θ / amount, so the frame's value is the mean cos θ.
    let open = 0;
    for (const o of lights.children) open += Math.max(0, o.position.y / Math.max(1e-6, o.position.length()));
    open /= lights.children.length;
    state.ref += (open - state.ref) / plm.window.value;
    shadowMat.uniforms.ref!.value = Math.max(1e-4, state.ref);
    const write = plm.flip ? plm.a : plm.b;
    const read = plm.flip ? plm.b : plm.a;
    plm.flip = !plm.flip;
    plm.previous.value = read.texture;
    const prev = gl.getRenderTarget();
    gl.setRenderTarget(write);
    gl.render(scene, camera);
    gl.setRenderTarget(prev);
    shadowMat.uniforms.map!.value = write.texture;

    plane.material = shadowMat;
    lights.visible = false;
    scene.background = bg;
    scene.environment = env;
    for (const o of hidden) o.visible = true;
    for (const [m, mat] of swapped) m.material = mat;
    for (const [l, i] of dimmed) l.intensity = i;
  };

  // New buffers (or first mount): start fully lit and accumulate.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per new set of buffers (plm); the other values are stable for its lifetime
  useLayoutEffect(() => {
    clear();
    state.ref = 1;
    shadowMat.uniforms.ref!.value = 1;
    shadowMat.uniforms.map!.value = plm.a.texture;
    state.count = 0;
    invalidate();
    return () => {
      plm.a.dispose();
      plm.b.dispose();
      plm.target.dispose();
    };
  }, [plm]);

  // Light rig or plane changed: blend toward the new result.
  // biome-ignore lint/correctness/useExhaustiveDependencies: element-wise deps so a new array with the same values doesn't restart accumulation
  useEffect(() => {
    state.count = 0;
    invalidate();
  }, [width, depth, center[0], center[1], light[0], light[1], light[2], radius, ambient, state, invalidate]);

  useEffect(
    () => () => {
      for (const o of lights.children) (o as THREE.DirectionalLight).shadow.dispose();
    },
    [lights],
  );

  useImperativeHandle(
    ref,
    () => ({
      refresh() {
        state.count = 0;
        invalidate();
      },
    }),
    [state, invalidate],
  );

  useFrame(() => {
    if (state.count >= frames) return;
    pass();
    state.count++;
    invalidate(); // keep going under frameloop="demand"
  });

  return (
    <>
      <primitive object={lights} />
      <primitive object={plane} position={[center[0], y, center[1]]} scale={[width, depth, 1]} />
    </>
  );
}
