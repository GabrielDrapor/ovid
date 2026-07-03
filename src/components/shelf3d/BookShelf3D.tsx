import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree, ThreeEvent } from '@react-three/fiber';
import { Book, UserBookProgress, TranslationProgress } from './types';
import {
  BAY_PITCH,
  BOOK_DEPTH,
  BOOK_HEIGHT,
  DEFAULT_SPINE_RATIO,
  DIVIDER_T,
  ROW_HEIGHT,
  clampSpineRatio,
  layoutBooks,
  rowYCenters,
} from './layout';
import {
  averageColor,
  makeCoverCanvas,
  makePageEdgesCanvas,
  makeSpineCanvas,
} from './fallbackTextures';
import {
  makeCavityShadeCanvas,
  makeFloorCanvas,
  makePanelCanvas,
  makeWoodCanvas,
  seededRandom,
} from './woodTexture';
import './BookShelf3D.css';

interface BookShelf3DProps {
  books: Book[];
  loading: boolean;
  showProgress: boolean;
  progressMap: Map<string, UserBookProgress>;
  translationProgress: Map<string, TranslationProgress>;
  onRead: (bookUuid: string) => void;
  onDelete: (bookUuid: string) => void;
}

const ROOM = '#171210';
const CLOTH_FALLBACK = '#3a3026';

const MIN_ZOOM = 2.5;

/** Loads an image texture, falling back to generated canvas artwork. */
function useArtTexture(
  url: string | null,
  makeFallback: () => HTMLCanvasElement,
  onLoaded?: (tex: THREE.Texture) => void
): THREE.Texture {
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const fallback = useMemo(() => {
    const tex = new THREE.CanvasTexture(makeFallback());
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);

  const [loaded, setLoaded] = useState<THREE.Texture | null>(null);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(url, (tex) => {
      if (cancelled) {
        tex.dispose();
        return;
      }
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      setLoaded(tex);
      onLoadedRef.current?.(tex);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    return () => {
      fallback.dispose();
      loaded?.dispose();
    };
  }, []);

  return loaded ?? fallback;
}

interface BookMeshProps {
  book: Book;
  position: [number, number, number];
  width: number;
  selected: boolean;
  anySelected: boolean;
  onSelect: (uuid: string) => void;
  onSpineRatio: (uuid: string, ratio: number) => void;
}

function BookMesh({
  book,
  position,
  width,
  selected,
  anySelected,
  onSelect,
  onSpineRatio,
}: BookMeshProps) {
  const group = useRef<THREE.Group>(null);
  const mesh = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);
  const processing = book.status === 'processing';

  // Real shelves aren't perfectly uniform: vary height, push-in depth and a
  // hair of lean per book, deterministically from its uuid.
  const jitter = useMemo(() => {
    const rand = seededRandom(book.uuid);
    return {
      heightScale: 0.955 + rand() * 0.075,
      pushIn: -0.055 + rand() * 0.065,
      lean: (rand() - 0.5) * 0.014,
    };
  }, [book.uuid]);
  const bookHeight = BOOK_HEIGHT * jitter.heightScale;
  // Keep the bottom edge on the board regardless of height.
  const shelfY = position[1] - (BOOK_HEIGHT - bookHeight) / 2;

  // Cloth color (back cover, page rims) sampled from the spine art.
  const [cloth, setCloth] = useState(CLOTH_FALLBACK);

  const spineTex = useArtTexture(
    book.book_spine_img_url,
    () => makeSpineCanvas(book.original_title || book.title),
    (tex) => {
      const img = tex.image as HTMLImageElement;
      if (img?.width && img?.height) {
        onSpineRatio(book.uuid, clampSpineRatio(img.width / img.height));
        setCloth(averageColor(img, CLOTH_FALLBACK));
      }
    }
  );
  const coverTex = useArtTexture(book.book_cover_img_url, () =>
    makeCoverCanvas(book.original_title || book.title, book.author)
  );
  const pagesTex = useMemo(() => {
    const t = new THREE.CanvasTexture(makePageEdgesCanvas(cloth));
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [cloth]);
  useEffect(() => () => pagesTex.dispose(), [pagesTex]);
  // Base tints per material slot; the dim animation multiplies these instead
  // of overwriting them (overwriting is what used to bleach the back cover).
  const baseColors = useMemo(() => {
    const white = new THREE.Color('#ffffff');
    const clothC = new THREE.Color(cloth);
    // [cover, back cover, top, bottom, spine, fore edge]
    return [white, clothC, white, white, white, white];
  }, [cloth]);
  const dim = useRef(1);

  useEffect(() => {
    document.body.style.cursor = hovered ? 'pointer' : '';
    return () => {
      document.body.style.cursor = '';
    };
  }, [hovered]);

  // Place the book at its shelf spot on first render so it doesn't fly in
  // from the origin.
  useEffect(() => {
    group.current?.position.set(
      position[0],
      shelfY,
      position[2] + jitter.pushIn
    );
  }, []);

  useFrame((state, delta) => {
    const g = group.current;
    if (!g) return;
    const k = 1 - Math.exp(-delta * 7);

    let tx = position[0];
    let ty = shelfY;
    let tz = position[2] + jitter.pushIn;
    let ry = 0;
    let rz = jitter.lean;

    if (selected) {
      // Float in front of the camera, cover turned toward the viewer.
      // On wide screens sit left of center (info panel is on the right);
      // on portrait screens stay centered above the bottom sheet.
      const cam = state.camera;
      const aspect = state.size.width / state.size.height;
      const halfW = Math.tan((38 / 2) * (Math.PI / 180)) * 2.15 * aspect;
      const xOff = aspect > 1 ? -Math.min(0.75, halfW * 0.42) : 0;
      const yOff = aspect > 1 ? -0.05 : 0.3;
      tx = cam.position.x + xOff;
      ty =
        cam.position.y + yOff + Math.sin(state.clock.elapsedTime * 1.1) * 0.02;
      tz = cam.position.z - 2.15;
      ry = -Math.PI / 2;
      rz = 0;
    } else if (hovered && !anySelected && !processing) {
      // Tip the book out of the row and yaw it so the cover peeks out.
      tz = position[2] + 0.42;
      ry = -0.3;
    }

    g.position.x += (tx - g.position.x) * k;
    g.position.y += (ty - g.position.y) * k;
    g.position.z += (tz - g.position.z) * k;
    g.rotation.y += (ry - g.rotation.y) * k;
    g.rotation.z += (rz - g.rotation.z) * k;

    // Brightness: dim unselected books while one is out; pulse processing.
    const m = mesh.current;
    if (m && Array.isArray(m.material)) {
      let target = 1;
      if (anySelected && !selected) target = 0.35;
      else if (processing) {
        target = 0.55 + Math.sin(state.clock.elapsedTime * 2.5) * 0.12;
      }
      dim.current += (target - dim.current) * k;
      const mats = m.material as THREE.MeshStandardMaterial[];
      for (let i = 0; i < mats.length; i++) {
        const base = baseColors[i] ?? baseColors[0];
        mats[i].color.setRGB(
          base.r * dim.current,
          base.g * dim.current,
          base.b * dim.current
        );
      }
    }
  });

  const handleClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      onSelect(book.uuid);
    },
    [book.uuid, onSelect]
  );

  return (
    <group ref={group}>
      <mesh
        ref={mesh}
        castShadow
        receiveShadow
        onClick={handleClick}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
        }}
        onPointerOut={() => setHovered(false)}
      >
        <boxGeometry args={[width, bookHeight, BOOK_DEPTH]} />
        {/* +x: front cover (faces camera when the book turns out) */}
        <meshStandardMaterial
          attach="material-0"
          map={coverTex}
          roughness={0.62}
        />
        {/* -x: back cover, cloth colored to match the spine art */}
        <meshStandardMaterial
          attach="material-1"
          color={cloth}
          roughness={0.68}
        />
        {/* +y / -y: page block with striations and a cloth rim */}
        <meshStandardMaterial
          attach="material-2"
          map={pagesTex}
          roughness={0.9}
        />
        <meshStandardMaterial
          attach="material-3"
          map={pagesTex}
          roughness={0.9}
        />
        {/* +z: spine, -z: fore edge */}
        <meshStandardMaterial
          attach="material-4"
          map={spineTex}
          roughness={0.62}
        />
        <meshStandardMaterial
          attach="material-5"
          map={pagesTex}
          roughness={0.9}
        />
      </mesh>
    </group>
  );
}

/** Built-in wall unit: a uniform grid of bays, floor to ceiling. */
function Bookcase({
  totalRows,
  totalCols,
}: {
  totalRows: number;
  totalCols: number;
}) {
  const rows = rowYCenters(totalRows);
  const width = totalCols * BAY_PITCH + DIVIDER_T;
  const boardT = 0.09;
  const depth = BOOK_DEPTH + 0.3;
  const headroom = 0.18;
  const topY = rows[0] + BOOK_HEIGHT / 2 + headroom;
  const bottomY = rows[rows.length - 1] - BOOK_HEIGHT / 2 - boardT;
  const height = topY - bottomY;
  const midY = (topY + bottomY) / 2;

  // A divider on every internal bay boundary — all bays the same width.
  const dividerXs = useMemo(() => {
    const xs: number[] = [];
    for (let i = 1; i < totalCols; i++) {
      xs.push((i - totalCols / 2) * BAY_PITCH);
    }
    return xs;
  }, [totalCols]);

  const boardTex = useMemo(() => {
    const t = new THREE.CanvasTexture(makeWoodCanvas('ovid-boards'));
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  }, []);
  const sideTex = useMemo(() => {
    const t = new THREE.CanvasTexture(makeWoodCanvas('ovid-sides'));
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    // Grain runs along the length of vertical members.
    t.center.set(0.5, 0.5);
    t.rotation = Math.PI / 2;
    return t;
  }, []);
  const cavityTex = useMemo(
    () => new THREE.CanvasTexture(makeCavityShadeCanvas()),
    []
  );
  useEffect(
    () => () => {
      boardTex.dispose();
      sideTex.dispose();
      cavityTex.dispose();
    },
    [boardTex, sideTex, cavityTex]
  );

  return (
    <group>
      {/* back panel — the case's own back, covering the wall behind it */}
      <mesh position={[0, midY, -BOOK_DEPTH / 2 - 0.09]} receiveShadow>
        <boxGeometry args={[width, height + boardT, 0.06]} />
        <meshStandardMaterial map={boardTex} color="#b9a897" roughness={0.92} />
      </mesh>
      {/* end stiles flush against the side walls */}
      {[-1, 1].map((side) => (
        <mesh
          key={side}
          position={[side * (width / 2 - 0.09), midY + boardT / 2, -0.02]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[0.18, height + boardT, depth]} />
          <meshStandardMaterial map={sideTex} roughness={0.8} />
        </mesh>
      ))}
      {/* vertical dividers between bays */}
      {dividerXs.map((x) => (
        <mesh
          key={`div-${x.toFixed(3)}`}
          position={[x, midY + boardT / 2, -0.03]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[DIVIDER_T, height + boardT, depth - 0.06]} />
          <meshStandardMaterial map={sideTex} roughness={0.8} />
        </mesh>
      ))}
      {/* top cap meets the ceiling */}
      <mesh position={[0, topY + boardT / 2, -0.02]} castShadow receiveShadow>
        <boxGeometry args={[width, boardT, depth]} />
        <meshStandardMaterial map={boardTex} roughness={0.8} />
      </mesh>
      {/* a board under every row */}
      {rows.map((y, i) => (
        <mesh
          key={i}
          position={[0, y - BOOK_HEIGHT / 2 - boardT / 2, -0.02]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[width, boardT, depth]} />
          <meshStandardMaterial map={boardTex} roughness={0.8} />
        </mesh>
      ))}
      {/* cheap ambient occlusion inside every cavity */}
      {rows.map((y, i) => {
        const ceiling = i === 0 ? topY : rows[i - 1] - BOOK_HEIGHT / 2 - boardT;
        const floor = y - BOOK_HEIGHT / 2;
        const h = ceiling - floor;
        return (
          <mesh
            key={`cavity-${i}`}
            position={[0, (ceiling + floor) / 2, -BOOK_DEPTH / 2 - 0.05]}
          >
            <planeGeometry args={[width - 0.3, h]} />
            <meshBasicMaterial map={cavityTex} transparent depthWrite={false} />
          </mesh>
        );
      })}
    </group>
  );
}

/** Repeating canvas texture with proper color space and wrapping. */
function useTiledTexture(
  make: () => HTMLCanvasElement,
  repeatX: number,
  repeatY: number
): THREE.Texture {
  const tex = useMemo(() => {
    const t = new THREE.CanvasTexture(make());
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
    // eslint-disable-next-line
  }, []);
  useEffect(() => {
    tex.repeat.set(repeatX, repeatY);
  }, [tex, repeatX, repeatY]);
  useEffect(() => () => tex.dispose(), [tex]);
  return tex;
}

/**
 * Walk-in closet room around the bookcase: paneled walls on all sides,
 * floorboards and a ceiling, so the view never falls off into a void.
 */
function ClosetRoom({
  totalRows,
  roomW,
}: {
  totalRows: number;
  roomW: number;
}) {
  const rows = rowYCenters(totalRows);
  const boardT = 0.09;
  const headroom = 0.18;
  const topY = rows[0] + BOOK_HEIGHT / 2 + headroom + boardT;
  const bottomY = rows[rows.length - 1] - BOOK_HEIGHT / 2 - boardT;

  const floorY = bottomY;
  // Built-in: the ceiling rests right on the case's top cap.
  const ceilY = topY + 0.02;
  const roomH = ceilY - floorY;
  const zBack = -1.35;
  const zFront = 13.5;
  const zMid = (zBack + zFront) / 2;
  const roomD = zFront - zBack;
  // Side moldings start in front of the case so they don't clip through it.
  const zTrim = 0.6;
  const zTrimMid = (zTrim + zFront) / 2;
  const trimD = zFront - zTrim;

  const backTex = useTiledTexture(
    () => makePanelCanvas('ovid-wall-back'),
    roomW / 4,
    roomH / 4
  );
  const leftTex = useTiledTexture(
    () => makePanelCanvas('ovid-wall-left'),
    roomD / 4,
    roomH / 4
  );
  const rightTex = useTiledTexture(
    () => makePanelCanvas('ovid-wall-right'),
    roomD / 4,
    roomH / 4
  );
  const floorTex = useTiledTexture(
    () => makeFloorCanvas('ovid-floor'),
    roomW / 4,
    roomD / 4
  );

  const wallY = floorY + roomH / 2;
  const WALL_TINT = '#8d7e6f'; // walls sit back tonally so the case pops

  return (
    <group>
      {/* back wall */}
      <mesh position={[0, wallY, zBack]} receiveShadow>
        <planeGeometry args={[roomW, roomH]} />
        <meshStandardMaterial map={backTex} color={WALL_TINT} roughness={0.9} />
      </mesh>
      {/* side walls */}
      <mesh
        position={[-roomW / 2, wallY, zMid]}
        rotation={[0, Math.PI / 2, 0]}
        receiveShadow
      >
        <planeGeometry args={[roomD, roomH]} />
        <meshStandardMaterial map={leftTex} color={WALL_TINT} roughness={0.9} />
      </mesh>
      <mesh
        position={[roomW / 2, wallY, zMid]}
        rotation={[0, -Math.PI / 2, 0]}
        receiveShadow
      >
        <planeGeometry args={[roomD, roomH]} />
        <meshStandardMaterial
          map={rightTex}
          color={WALL_TINT}
          roughness={0.9}
        />
      </mesh>
      {/* floor — low roughness for a subtle sheen under the lights */}
      <mesh
        position={[0, floorY, zMid]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <planeGeometry args={[roomW, roomD]} />
        <meshStandardMaterial
          map={floorTex}
          roughness={0.34}
          metalness={0.16}
        />
      </mesh>
      {/* ceiling */}
      <mesh position={[0, ceilY, zMid]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[roomW, roomD]} />
        <meshStandardMaterial color="#48382a" roughness={0.95} />
      </mesh>
      {/* crown molding along the side walls (the case meets the ceiling) */}
      {[-1, 1].map((side) => (
        <mesh
          key={`crown-${side}`}
          position={[side * (roomW / 2 - 0.04), ceilY - 0.07, zTrimMid]}
        >
          <boxGeometry args={[0.07, 0.14, trimD]} />
          <meshStandardMaterial color="#3f2b19" roughness={0.7} />
        </mesh>
      ))}
      {/* baseboards along the side walls */}
      {[-1, 1].map((side) => (
        <mesh
          key={side}
          position={[side * (roomW / 2 - 0.03), floorY + 0.08, zTrimMid]}
        >
          <boxGeometry args={[0.05, 0.16, trimD]} />
          <meshStandardMaterial color="#3a2817" roughness={0.7} />
        </mesh>
      ))}
      {/* soft ceiling glow pooling down the walls */}
      <pointLight
        position={[-roomW * 0.28, ceilY - 0.3, 2]}
        decay={0}
        intensity={0.3}
        color="#efe0cb"
      />
      <pointLight
        position={[roomW * 0.28, ceilY - 0.3, 2]}
        decay={0}
        intensity={0.3}
        color="#efe0cb"
      />
      {/* washers brightening the upper side walls and ceiling edge */}
      <pointLight
        position={[-(roomW / 2 - 0.7), ceilY - 0.5, 3]}
        decay={0}
        intensity={0.14}
        color="#ece0cd"
      />
      <pointLight
        position={[roomW / 2 - 0.7, ceilY - 0.5, 3]}
        decay={0}
        intensity={0.14}
        color="#ece0cd"
      />
      <pointLight
        position={[0, floorY + 1.2, 9]}
        decay={0}
        intensity={0.12}
        color="#eaddca"
      />
    </group>
  );
}

/**
 * Mouse-move gaze + wheel dolly. Frames the content bays on load; panning
 * with the pointer can reach the ring of empty bays around the content but
 * never past the closet's walls.
 */
function CameraRig({
  focused,
  contentW,
  contentH,
  roomW,
  wallH,
  centerY,
}: {
  focused: boolean;
  contentW: number;
  contentH: number;
  roomW: number;
  wallH: number;
  centerY: number;
}) {
  const { camera, gl, size } = useThree();
  const zoom = useRef<number | null>(null);
  const userZoomed = useRef(false);

  const tanHalf = Math.tan((38 / 2) * (Math.PI / 180));
  const aspect = size.width / size.height;

  // Distance at which the content bays fit in view, with some margin.
  const fitZ = useMemo(() => {
    if (!contentW) return 6;
    const zForWidth = (contentW / 2 + 0.55) / (tanHalf * aspect);
    const zForHeight = contentH / 2 / tanHalf + 0.9;
    return THREE.MathUtils.clamp(Math.max(zForWidth, zForHeight), MIN_ZOOM, 11);
  }, [contentW, contentH, tanHalf, aspect]);

  // Zooming out stops roughly when the whole wall (incl. the empty ring)
  // fills the view.
  const maxZoom = useMemo(() => {
    const zForWidth = (roomW / 2 + 0.2) / (tanHalf * aspect);
    const zForHeight = wallH / 2 / tanHalf + 0.6;
    return THREE.MathUtils.clamp(
      Math.max(zForWidth, zForHeight, fitZ + 0.8),
      MIN_ZOOM + 1,
      11.5
    );
  }, [roomW, wallH, fitZ, tanHalf, aspect]);

  // Follow layout changes until the user takes over the wheel.
  useEffect(() => {
    if (!userZoomed.current) zoom.current = fitZ;
  }, [fitZ]);

  const maxZoomRef = useRef(maxZoom);
  maxZoomRef.current = maxZoom;
  useEffect(() => {
    const el = gl.domElement;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      userZoomed.current = true;
      zoom.current = THREE.MathUtils.clamp(
        (zoom.current ?? 6) + e.deltaY * 0.005,
        MIN_ZOOM,
        maxZoomRef.current
      );
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [gl]);

  useFrame((state, delta) => {
    const k = 1 - Math.exp(-delta * 4);
    // While a book is presented, quiet the gaze so the pose feels stable.
    const gaze = focused ? 0.18 : 1;
    // Pan range: far enough to reach the empty ring, never past the walls.
    const xRange = Math.max(1.2, roomW / 2 - 2.1);
    const yRange = Math.max(0.45, wallH / 2 - 1.15);
    const tx = state.pointer.x * xRange * gaze;
    const ty = centerY + state.pointer.y * yRange * gaze;
    camera.position.x += (tx - camera.position.x) * k;
    camera.position.y += (ty - camera.position.y) * k;
    camera.position.z += ((zoom.current ?? fitZ) - camera.position.z) * k;
    camera.lookAt(
      camera.position.x * 1.12,
      centerY + (camera.position.y - centerY) * 0.8,
      0
    );
  });

  return null;
}

const BookShelf3D: React.FC<BookShelf3DProps> = ({
  books,
  loading,
  showProgress,
  progressMap,
  translationProgress,
  onRead,
  onDelete,
}) => {
  const [spineRatios, setSpineRatios] = useState<Map<string, number>>(
    new Map()
  );
  const [selectedUuid, setSelectedUuid] = useState<string | null>(null);

  const handleSpineRatio = useCallback((uuid: string, ratio: number) => {
    setSpineRatios((prev) => {
      if (Math.abs((prev.get(uuid) ?? DEFAULT_SPINE_RATIO) - ratio) < 0.001) {
        return prev;
      }
      const next = new Map(prev);
      next.set(uuid, ratio);
      return next;
    });
  }, []);

  const {
    placements,
    contentRows,
    contentCols,
    totalRows,
    totalCols,
    wallWidth,
  } = useMemo(() => layoutBooks(books, spineRatios), [books, spineRatios]);
  const rowCenters = useMemo(() => rowYCenters(totalRows), [totalRows]);
  const roomW = wallWidth;
  const caseTop =
    totalRows > 0 ? rowCenters[0] + BOOK_HEIGHT / 2 + 0.18 + 0.09 : 3;
  // Content rows sit in the middle of the ring, so their center is y = 0.
  const contentMidY =
    contentRows > 0 ? (rowCenters[1] + rowCenters[totalRows - 2]) / 2 : 0;
  const bookByUuid = useMemo(
    () => new Map(books.map((b) => [b.uuid, b])),
    [books]
  );

  const selectedBook = selectedUuid
    ? (bookByUuid.get(selectedUuid) ?? null)
    : null;

  // If the selected book disappears (e.g. deleted), close the panel.
  useEffect(() => {
    if (selectedUuid && !bookByUuid.has(selectedUuid)) {
      setSelectedUuid(null);
    }
  }, [selectedUuid, bookByUuid]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedUuid(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const initialZ = 6;

  return (
    <div className="closet3d-root">
      <Canvas
        dpr={[1, 2]}
        shadows
        camera={{ fov: 38, position: [0, 0, initialZ], near: 0.1, far: 60 }}
        gl={{ antialias: true }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.15;
        }}
        onPointerMissed={() => setSelectedUuid(null)}
      >
        <color attach="background" args={[ROOM]} />
        <fog attach="fog" args={[ROOM, 12, 40]} />
        <ambientLight intensity={0.62} color="#f4ede3" />
        {/* key light just below the ceiling, the only shadow caster */}
        <spotLight
          position={[1.3, caseTop - 0.25, 5.4]}
          angle={1.15}
          penumbra={0.9}
          decay={0}
          intensity={1.55}
          color="#f4e7d3"
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-bias={-0.0004}
        />
        {/* soft fills so shadowed sides don't go black */}
        <directionalLight
          position={[-4, 1.2, 3.5]}
          intensity={0.26}
          color="#ccd4e8"
        />
        <pointLight
          position={[0, -0.4, 4.5]}
          decay={0}
          intensity={0.15}
          color="#ece1cf"
        />

        {totalRows > 0 && (
          <>
            <ClosetRoom totalRows={totalRows} roomW={roomW} />
            <Bookcase totalRows={totalRows} totalCols={totalCols} />
          </>
        )}

        {placements.map((p) => {
          const book = bookByUuid.get(p.uuid);
          if (!book) return null;
          const y = rowCenters[p.row + 1];
          return (
            <BookMesh
              key={p.uuid}
              book={book}
              position={[p.x, y, 0]}
              width={p.width}
              selected={selectedUuid === p.uuid}
              anySelected={selectedUuid !== null}
              onSelect={setSelectedUuid}
              onSpineRatio={handleSpineRatio}
            />
          );
        })}

        <CameraRig
          focused={selectedUuid !== null}
          contentW={contentCols * BAY_PITCH}
          contentH={contentRows * ROW_HEIGHT}
          roomW={roomW}
          wallH={totalRows * ROW_HEIGHT}
          centerY={contentMidY}
        />
      </Canvas>

      {loading && (
        <div className="closet3d-loading">
          <div className="closet3d-spinner" />
        </div>
      )}

      <div className="closet3d-hint">
        Move the mouse to look around · scroll to zoom · click a book
      </div>

      {selectedBook && (
        <div
          className="closet3d-panel"
          role="dialog"
          aria-label={selectedBook.title}
        >
          <button
            className="closet3d-panel-close"
            aria-label="Close"
            onClick={() => setSelectedUuid(null)}
          >
            ×
          </button>
          <h2>{selectedBook.original_title || selectedBook.title}</h2>
          {selectedBook.original_title &&
            selectedBook.title !== selectedBook.original_title && (
              <h3>{selectedBook.title}</h3>
            )}
          <p className="closet3d-author">By {selectedBook.author}</p>

          {selectedBook.status === 'processing' ? (
            <div className="closet3d-processing">
              {(() => {
                const tp = translationProgress.get(selectedBook.uuid);
                if (tp && tp.chaptersTotal > 0) {
                  const pct = Math.round(
                    (tp.chaptersCompleted / tp.chaptersTotal) * 100
                  );
                  return (
                    <>
                      <span>
                        Translating… {tp.chaptersCompleted}/{tp.chaptersTotal}{' '}
                        chapters ({pct}%)
                      </span>
                      <div className="closet3d-progress-bar">
                        <div style={{ width: `${pct}%` }} />
                      </div>
                    </>
                  );
                }
                return (
                  <span>
                    {tp?.phase === 'glossary'
                      ? 'Extracting glossary…'
                      : 'Translating…'}
                  </span>
                );
              })()}
            </div>
          ) : selectedBook.status === 'error' ? (
            <div className="closet3d-error">Translation failed</div>
          ) : (
            <>
              {showProgress &&
                (() => {
                  const progress = progressMap.get(selectedBook.uuid);
                  const pct = progress?.is_completed
                    ? 100
                    : progress?.reading_progress || 0;
                  const label = progress?.is_completed
                    ? '✓ Completed'
                    : pct > 0
                      ? `${pct}% read`
                      : 'Not started';
                  return (
                    <div className="closet3d-progress">
                      <div className="closet3d-progress-bar">
                        <div style={{ width: `${pct}%` }} />
                      </div>
                      <span>{label}</span>
                    </div>
                  );
                })()}
              <button
                className="closet3d-read-btn"
                onClick={() => onRead(selectedBook.uuid)}
              >
                Read
              </button>
            </>
          )}

          {selectedBook.user_id && (
            <button
              className="closet3d-remove-btn"
              onClick={() => onDelete(selectedBook.uuid)}
            >
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default BookShelf3D;
