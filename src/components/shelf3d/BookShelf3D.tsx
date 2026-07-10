import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Canvas, useFrame, useThree, ThreeEvent } from '@react-three/fiber';
import {
  Book,
  ShelfMoveTarget,
  ShelfSlot,
  ShelfUploadTarget,
  UserBookProgress,
  TranslationProgress,
} from './types';
import {
  BAY_PITCH,
  BOOK_DEPTH,
  BOOK_GAP,
  BOOK_HEIGHT,
  DEFAULT_SPINE_RATIO,
  DIVIDER_T,
  DropTarget,
  PlacedShelfLabel,
  ROW_HEIGHT,
  ShelfLayout,
  clampSpineRatio,
  layoutBooks,
  resolveDropTarget,
  rowYCenters,
} from './layout';
import {
  averageColor,
  makeCoverCanvas,
  makePageEdgesCanvas,
  makeProcessingCoverCanvas,
  makeProcessingSpineCanvas,
  makeSpineCanvas,
  makeUploadGhostCanvas,
} from './fallbackTextures';
import {
  makeCavityShadeCanvas,
  makePanelCanvas,
  makeWoodCanvas,
  seededRandom,
} from './woodTexture';
import './BookShelf3D.css';

interface BookShelf3DProps {
  books: Book[];
  shelfSlots: ShelfSlot[];
  loading: boolean;
  showProgress: boolean;
  progressMap: Map<string, UserBookProgress>;
  translationProgress: Map<string, TranslationProgress>;
  currentUserId?: number | null;
  onRead: (bookUuid: string) => void;
  onDelete: (bookUuid: string) => void;
  onUploadToSlot?: (target: ShelfUploadTarget) => void;
  onMoveBook?: (
    bookUuid: string,
    target: ShelfMoveTarget,
    insertIndex: number
  ) => void;
  /** Persist a slot label edit; resolve true on success. */
  onSaveSlotLabel?: (slotId: number, label: string) => Promise<boolean>;
}

const DRAG_START_PX_MOUSE = 6;
const DRAG_START_PX_TOUCH = 10;

// Only an in-flight import gates interaction; a 'ready' book missing
// cover/spine art (e.g. generation failed server-side) renders with fallback
// textures and stays readable.
function isBookImportPending(book: Book): boolean {
  return book.status === 'processing';
}

const ROOM = '#171210';
const CLOTH_FALLBACK = '#3a3026';

// Shown under the loading spinner — the shelf-keeper tidying up before
// opening the doors. One is picked at random per visit.
const LOADING_QUIPS = [
  'Sweeping the dust off the shelves…',
  'Straightening the spines…',
  'Lighting the reading lamp…',
  'Waking the librarian…',
];

const MIN_ZOOM = 2.5;
const SHELF_LABEL_HEIGHT = 0.084;
const SHELF_LABEL_FONT = '900 58px Arial, Helvetica, sans-serif';

/** A tiny solid-color canvas used as a neutral placeholder while loading. */
function makeNeutralCanvas(w = 16, h = 16): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#4a3f34';
    ctx.fillRect(0, 0, w, h);
  }
  return c;
}

function makeShelfLabelCanvas(text: string): HTMLCanvasElement {
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  const textWidth = (() => {
    if (!measureCtx) return 520;
    measureCtx.font = SHELF_LABEL_FONT;
    return Math.ceil(measureCtx.measureText(text).width);
  })();

  const c = document.createElement('canvas');
  c.width = Math.max(780, textWidth + 150);
  c.height = 132;
  const ctx = c.getContext('2d');
  if (!ctx) return c;

  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.34)';
  ctx.fillRect(30, 11, c.width - 60, 116);

  // Black plastic holder, like a clip-on library shelf label.
  ctx.fillStyle = '#11100e';
  ctx.fillRect(20, 4, c.width - 40, 116);
  ctx.fillStyle = '#24211d';
  ctx.fillRect(20, 4, c.width - 40, 18);
  ctx.fillStyle = '#050504';
  ctx.fillRect(20, 107, c.width - 40, 13);
  ctx.fillRect(20, 4, 20, 116);
  ctx.fillRect(c.width - 40, 4, 20, 116);

  // White paper insert.
  ctx.fillStyle = '#f6f4ed';
  ctx.fillRect(48, 30, c.width - 96, 64);
  ctx.strokeStyle = '#d0cabd';
  ctx.lineWidth = 2;
  ctx.strokeRect(48, 30, c.width - 96, 64);

  // Subtle paper grain so the label reads as a pasted library shelf marker.
  const noise = seededRandom(`shelf-label-${text}`);
  ctx.globalAlpha = 0.1;
  for (let i = 0; i < 1200; i++) {
    const v = 120 + Math.floor(noise() * 80);
    ctx.fillStyle = `rgb(${v}, ${v}, ${v})`;
    ctx.fillRect(48 + noise() * (c.width - 96), 30 + noise() * 64, 1, 1);
  }
  ctx.globalAlpha = 1;

  ctx.fillStyle = '#050505';
  ctx.font = SHELF_LABEL_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, c.width / 2, 63);
  return c;
}

/** Loads an image texture, falling back to generated canvas artwork.
 *  While a URL is loading, returns a neutral dark placeholder instead of the
 *  colorful fallback so the shelf looks clean during initial load. */
function useArtTexture(
  url: string | null,
  makeFallback: () => HTMLCanvasElement,
  fallbackKey: string,
  onLoaded?: (tex: THREE.Texture) => void
): THREE.Texture {
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const fallback = useMemo(() => {
    const tex = new THREE.CanvasTexture(makeFallback());
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, [fallbackKey]);
  useEffect(() => () => fallback.dispose(), [fallback]);

  const neutral = useMemo(() => {
    if (!url) return null;
    const tex = new THREE.CanvasTexture(makeNeutralCanvas());
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, [url]);
  useEffect(() => () => neutral?.dispose(), [neutral]);

  const [loaded, setLoaded] = useState<THREE.Texture | null>(null);
  useEffect(() => () => loaded?.dispose(), [loaded]);

  useEffect(() => {
    setLoaded(null);
    if (!url) return;
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    const apply = (tex: THREE.Texture) => {
      if (cancelled) {
        tex.dispose();
        return;
      }
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      setLoaded(tex);
      onLoadedRef.current?.(tex);
    };
    loader.load(url, apply, undefined, () => {
      if (cancelled) return;
      const bust = url + (url.includes('?') ? '&' : '?') + 'cors=1';
      loader.load(bust, apply, undefined, () => {
        if (cancelled) return;
        // Both attempts failed — settle on the colorful fallback, and report
        // it as loaded so the shelf's reveal gate doesn't wait forever.
        setLoaded(fallback);
        onLoadedRef.current?.(fallback);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [fallback, url]);

  // No URL → colorful fallback immediately.
  // URL loading → neutral dark placeholder.
  // URL resolved → real texture (or fallback on failure).
  if (!url) return fallback;
  return loaded ?? neutral ?? fallback;
}

function ShelfLabel({
  label,
  y,
  editable,
  hidden,
  onEdit,
  dragDist,
}: {
  label: PlacedShelfLabel;
  y: number;
  /** Signed-in user, non-public slot: click to edit / add. */
  editable: boolean;
  /** A book is presented — labels stay visible but stop taking clicks. */
  hidden: boolean;
  onEdit?: (label: PlacedShelfLabel) => void;
  dragDist: React.MutableRefObject<number>;
}) {
  const [hovered, setHovered] = useState(false);
  const materialRef = useRef<THREE.MeshBasicMaterial>(null);
  const isGhost = !label.text;

  // An unlabeled bay renders as a blank label holder — visibly present (so
  // the affordance is discoverable) but clearly empty, waiting to be filled.
  const art = useMemo(() => {
    const canvas = makeShelfLabelCanvas(label.text);
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return {
      texture: t,
      width: SHELF_LABEL_HEIGHT * (canvas.width / canvas.height),
    };
  }, [label.text]);
  useEffect(() => () => art.texture.dispose(), [art]);

  useEffect(() => {
    if (hidden) setHovered(false);
  }, [hidden]);

  useEffect(() => {
    if (!editable || hidden) return;
    document.body.style.cursor = hovered ? 'pointer' : '';
    return () => {
      document.body.style.cursor = '';
    };
  }, [hovered, editable, hidden]);

  // Blank holders sit at half strength and wake up on hover; filled labels
  // dim slightly on hover when editable, so the click affordance reads
  // without extra chrome.
  useFrame((_, delta) => {
    const m = materialRef.current;
    if (!m) return;
    const target = isGhost ? (hovered ? 1 : 0.5) : hovered && editable ? 0.82 : 1;
    m.opacity += (target - m.opacity) * (1 - Math.exp(-delta * 10));
  });

  const handleClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      if (!editable || !onEdit) return;
      e.stopPropagation();
      // The tail of a touch pan must not open the editor.
      if (dragDist.current > 12) return;
      onEdit(label);
    },
    [editable, onEdit, label, dragDist]
  );

  return (
    <group>
      <mesh
        position={[label.left + art.width / 2, y, BOOK_DEPTH / 2 + 0.15]}
        renderOrder={5}
      >
        <meshBasicMaterial
          ref={materialRef}
          map={art.texture}
          transparent
          opacity={isGhost ? 0 : 1}
          depthWrite={false}
          toneMapped={false}
        />
        <planeGeometry args={[art.width, SHELF_LABEL_HEIGHT]} />
      </mesh>
      {/* The hit mesh is removed entirely while a book is presented so a
          click near a label falls through to onPointerMissed and closes the
          panel instead of opening the editor. */}
      {editable && !hidden && (
        <mesh
          position={[
            label.left + art.width / 2,
            // Extra hit height extends DOWN into the shelf board only —
            // growing upward would sit in front of the row above's books
            // and steal clicks off their bottom edges.
            y - SHELF_LABEL_HEIGHT / 2,
            BOOK_DEPTH / 2 + 0.16,
          ]}
          onClick={handleClick}
          onPointerOver={(e) => {
            e.stopPropagation();
            setHovered(true);
          }}
          onPointerOut={() => setHovered(false)}
        >
          <planeGeometry args={[art.width * 1.15, SHELF_LABEL_HEIGHT * 2]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}

interface BookMeshProps {
  book: Book;
  position: [number, number, number];
  width: number;
  selected: boolean;
  anySelected: boolean;
  onSelect: (uuid: string) => void;
  onSpineRatio: (uuid: string, ratio: number) => void;
  onArtReady: (uuid: string) => void;
  processingProgress: number;
  /** Accumulated touch-drag distance; large values suppress the tap-click. */
  dragDist: React.MutableRefObject<number>;
  /** Owned books off public shelves can be dragged; everything else can't. */
  draggable: boolean;
  layout: ShelfLayout;
  draggingUuid: React.MutableRefObject<string | null>;
  dragPointerId: React.MutableRefObject<number | null>;
  dragWorldPos: React.MutableRefObject<THREE.Vector3>;
  /** Books that slide right to open a gap at the live insertion point. */
  dragShift: React.MutableRefObject<{
    uuids: Set<string>;
    amount: number;
  } | null>;
  onDragEnd: (bookUuid: string, candidate: DropTarget | null) => void;
}

function BookMesh({
  book,
  position,
  width,
  selected,
  anySelected,
  onSelect,
  onSpineRatio,
  onArtReady,
  processingProgress,
  dragDist,
  draggable,
  layout,
  draggingUuid,
  dragPointerId,
  dragWorldPos,
  dragShift,
  onDragEnd,
}: BookMeshProps) {
  const { camera, gl } = useThree();
  const group = useRef<THREE.Group>(null);
  const mesh = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);

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

  const hasSpineUrl = !!book.book_spine_img_url;
  const hasCoverUrl = !!book.book_cover_img_url;
  const processing = isBookImportPending(book);
  const [spineLoaded, setSpineLoaded] = useState(false);
  const [coverLoaded, setCoverLoaded] = useState(false);

  // Real pointer drag: pick up an owned book and move it to a new bay.
  // Pointer capture (set on pointerdown) keeps move/up events targeting this
  // mesh even once the pointer strays off its (shrinking/relocating) geometry.
  const dragPlane = useMemo(
    () => new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
    []
  );
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  // Scratch objects reused across pointermove events — a drag can dispatch
  // dozens per frame and fresh allocations each time are pure GC churn.
  const ndcScratch = useMemo(() => new THREE.Vector2(), []);
  const hitScratch = useMemo(() => new THREE.Vector3(), []);
  const dragStart = useRef<{
    x: number;
    y: number;
    pointerId: number;
    moved: boolean;
  } | null>(null);
  const lastCandidate = useRef<DropTarget | null>(null);
  const lastShiftKey = useRef<string | null>(null);
  const justDragged = useRef(false);

  const handlePointerDown = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (!draggable || processing) return;
      // One drag pointer at a time: a second finger tapping another book
      // mid-drag must not steal dragPointerId — CameraRig would resume
      // panning for the finger still carrying the first book.
      if (dragPointerId.current !== null) return;
      e.stopPropagation();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      dragStart.current = {
        x: e.clientX,
        y: e.clientY,
        pointerId: e.pointerId,
        moved: false,
      };
      dragPointerId.current = e.pointerId;
    },
    [draggable, processing, dragPointerId]
  );

  const handlePointerMove = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      const start = dragStart.current;
      if (!start || start.pointerId !== e.pointerId) return;
      const dist = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      const threshold =
        e.pointerType === 'touch' ? DRAG_START_PX_TOUCH : DRAG_START_PX_MOUSE;
      if (!start.moved && dist > threshold) {
        start.moved = true;
        draggingUuid.current = book.uuid;
      }
      if (!start.moved) return;
      e.stopPropagation();

      const rect = gl.domElement.getBoundingClientRect();
      ndcScratch.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      raycaster.setFromCamera(ndcScratch, camera);
      if (!raycaster.ray.intersectPlane(dragPlane, hitScratch)) return;
      dragWorldPos.current.set(
        hitScratch.x,
        hitScratch.y,
        BOOK_DEPTH / 2 + 0.4
      );

      const candidate = resolveDropTarget(
        hitScratch.x,
        hitScratch.y,
        layout,
        book.uuid
      );
      lastCandidate.current = candidate;

      // Open a gap at the insertion point: everything at/after it slides
      // right by the dragged book's width so the landing spot reads clearly.
      // Only rebuild the shift set when the candidate actually changes —
      // pointermove fires dozens of times a second over the same spot.
      const shiftKey = candidate
        ? `${candidate.rowCoord}:${candidate.colCoord}:${candidate.insertIndex}`
        : null;
      if (shiftKey !== lastShiftKey.current) {
        lastShiftKey.current = shiftKey;
        if (candidate) {
          const siblings = candidate.bookUuids.filter(
            (uuid) => uuid !== book.uuid
          );
          const toShift = siblings.slice(candidate.insertIndex);
          dragShift.current =
            toShift.length > 0
              ? { uuids: new Set(toShift), amount: width + BOOK_GAP }
              : null;
        } else {
          dragShift.current = null;
        }
      }
    },
    [
      gl,
      camera,
      raycaster,
      dragPlane,
      ndcScratch,
      hitScratch,
      draggingUuid,
      dragWorldPos,
      dragShift,
      layout,
      book.uuid,
      width,
    ]
  );

  const finishDrag = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      const start = dragStart.current;
      if (!start || start.pointerId !== e.pointerId) return;
      dragStart.current = null;
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      if (dragPointerId.current === e.pointerId) dragPointerId.current = null;

      if (start.moved) {
        justDragged.current = true;
        draggingUuid.current = null;
        dragShift.current = null;
        lastShiftKey.current = null;
        onDragEnd(book.uuid, lastCandidate.current);
        lastCandidate.current = null;
      }
    },
    [dragPointerId, draggingUuid, dragShift, onDragEnd, book.uuid]
  );
  const displayTitle = book.original_title || book.title;
  const processingClarity = Math.max(
    0,
    Math.min(1, Number.isFinite(processingProgress) ? processingProgress : 0)
  );
  const processingTextureStep = Math.round(processingClarity * 10) / 10;

  const spineTex = useArtTexture(
    book.book_spine_img_url,
    () => makeSpineCanvas(displayTitle),
    `spine:${displayTitle}`,
    (tex) => {
      setSpineLoaded(true);
      const img = tex.image as HTMLImageElement;
      if (img?.width && img?.height) {
        onSpineRatio(book.uuid, clampSpineRatio(img.width / img.height));
        setCloth(averageColor(img, CLOTH_FALLBACK));
      }
    }
  );
  const coverTex = useArtTexture(
    book.book_cover_img_url,
    () => makeCoverCanvas(displayTitle, book.author),
    `cover:${displayTitle}:${book.author}`,
    () => setCoverLoaded(true)
  );
  const processingSpineTex = useMemo(() => {
    const tex = new THREE.CanvasTexture(
      makeProcessingSpineCanvas(displayTitle, processingTextureStep)
    );
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }, [displayTitle, processingTextureStep]);
  const processingCoverTex = useMemo(() => {
    const tex = new THREE.CanvasTexture(
      makeProcessingCoverCanvas(
        displayTitle,
        book.author,
        processingTextureStep
      )
    );
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }, [book.author, displayTitle, processingTextureStep]);
  useEffect(
    () => () => {
      processingSpineTex.dispose();
      processingCoverTex.dispose();
    },
    [processingCoverTex, processingSpineTex]
  );
  const effectiveSpineTex = processing ? processingSpineTex : spineTex;
  const effectiveCoverTex = processing ? processingCoverTex : coverTex;
  // Books without URLs are ready immediately; books with URLs wait for load.
  const artReady =
    processing ||
    ((!hasSpineUrl || spineLoaded) && (!hasCoverUrl || coverLoaded));
  useEffect(() => {
    if (artReady) onArtReady(book.uuid);
  }, [artReady, book.uuid, onArtReady]);
  const effectiveCloth = processing ? '#5f5a52' : cloth;
  const pagesTex = useMemo(() => {
    const t = new THREE.CanvasTexture(makePageEdgesCanvas(effectiveCloth));
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [effectiveCloth]);
  useEffect(() => () => pagesTex.dispose(), [pagesTex]);
  // Base tints per material slot; the dim animation multiplies these instead
  // of overwriting them (overwriting is what used to bleach the back cover).
  const baseColors = useMemo(() => {
    const white = new THREE.Color('#ffffff');
    const clothC = new THREE.Color(effectiveCloth);
    // [cover, back cover, top, bottom, spine, fore edge]
    return [white, clothC, white, white, white, white];
  }, [effectiveCloth]);
  const dim = useRef(1);
  // Fade-in: books with image URLs start transparent, fade to opaque once loaded.
  const reveal = useRef(artReady ? 1 : 0);

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
    const isDragging = draggingUuid.current === book.uuid;
    // Snappier follow while the pointer is actively carrying the book.
    const k = 1 - Math.exp(-delta * (isDragging ? 20 : 7));

    let tx = position[0];
    let ty = shelfY;
    let tz = position[2] + jitter.pushIn;
    let ry = 0;
    let rz = jitter.lean;
    let ts = 1;

    if (isDragging) {
      tx = dragWorldPos.current.x;
      ty = dragWorldPos.current.y;
      tz = dragWorldPos.current.z;
      ry = 0;
      rz = 0;
      ts = 1.06;
    } else if (selected) {
      // Float in front of the camera, cover turned toward the viewer.
      // On wide screens sit left of center (info panel is on the right).
      const cam = state.camera;
      const aspect = state.size.width / state.size.height;
      const tanHalf = Math.tan((38 / 2) * (Math.PI / 180));
      const visH = 2 * tanHalf * 2.15;
      const visW = visH * aspect;
      // Matches the CSS breakpoint where the info panel becomes a bottom sheet.
      const sheetMode = state.size.width <= 768;
      let xOff = 0;
      let yOff = -0.05;
      if (!sheetMode) {
        xOff = -Math.min(0.75, (visW / 2) * 0.42);
      } else {
        // The sheet hides the bottom of the viewport, and at this distance
        // the cover is wider than what remains of a portrait frame — shrink
        // the book to fit the free space and center it there. (Backing the
        // book further off instead would clip it into the shelf whenever the
        // camera is near MIN_ZOOM.)
        const sheet = 0.38; // rough fraction covered by the bottom sheet
        yOff = (sheet * visH) / 2;
        ts = Math.min(
          1,
          (0.62 * visW) / BOOK_DEPTH,
          (0.72 * (1 - sheet) * visH) / bookHeight
        );
      }
      tx = cam.position.x + xOff;
      ty =
        cam.position.y + yOff + Math.sin(state.clock.elapsedTime * 1.1) * 0.02;
      tz = cam.position.z - 2.15;
      ry = -Math.PI / 2;
      rz = 0;
    } else if (dragShift.current?.uuids.has(book.uuid)) {
      // Another book is being carried over this bay: slide right to open a
      // gap at the insertion point. The lerp below animates the shuffle.
      tx = position[0] + dragShift.current.amount;
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
    g.scale.setScalar(g.scale.x + (ts - g.scale.x) * k);

    // Skeleton → reveal: books with image URLs start as visible silhouettes
    // with a breathing shimmer, then fade to full brightness once loaded.
    if (artReady) {
      reveal.current = Math.min(1, reveal.current + delta * 2.5);
    }

    // Brightness: dim unselected books while one is out; pulse processing.
    const m = mesh.current;
    if (m && Array.isArray(m.material)) {
      let target = 1;
      if (anySelected && !selected && !isDragging) target = 0.35;
      else if (processing) {
        const shimmer =
          Math.sin(state.clock.elapsedTime * 2.5) *
          (0.1 * (1 - processingClarity));
        target = 0.62 + processingClarity * 0.32 + shimmer;
      }
      dim.current += (target - dim.current) * k;
      const mats = m.material as THREE.MeshStandardMaterial[];

      // Loading shimmer: gentle breathing pulse on skeleton books.
      let bright = dim.current;
      if (!artReady) {
        bright *= 0.55 + Math.sin(state.clock.elapsedTime * 1.8) * 0.15;
      } else if (reveal.current < 1) {
        bright *= reveal.current;
      }

      for (let i = 0; i < mats.length; i++) {
        const base = baseColors[i] ?? baseColors[0];
        mats[i].color.setRGB(base.r * bright, base.g * bright, base.b * bright);
      }
    }
  });

  const handleClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      // A touch pan that ends on a book must not count as a tap.
      if (dragDist.current > 12) return;
      // A completed pointer-drag fires a click right after pointerup — don't
      // let it also open the info panel.
      if (justDragged.current) {
        justDragged.current = false;
        return;
      }
      onSelect(book.uuid);
    },
    [book.uuid, onSelect, dragDist]
  );

  // Slightly rounded edges — hardcovers aren't razor-sharp boxes.
  const geometry = useMemo(
    () => new RoundedBoxGeometry(width, bookHeight, BOOK_DEPTH, 2, 0.022),
    [width, bookHeight]
  );
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <group ref={group}>
      <mesh
        ref={mesh}
        geometry={geometry}
        castShadow
        receiveShadow
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
        }}
        onPointerOut={() => setHovered(false)}
      >
        {/* +x: front cover (faces camera when the book turns out) */}
        <meshStandardMaterial
          attach="material-0"
          map={effectiveCoverTex}
          roughness={processing ? 0.9 - processingClarity * 0.2 : 0.62}
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
          map={effectiveSpineTex}
          roughness={processing ? 0.9 - processingClarity * 0.2 : 0.62}
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

interface UploadPlaceholderProps {
  target: {
    shelfSlotId?: number | null;
    rowCoord: number;
    colCoord: number;
    label?: string | null;
    x: number;
    hitX: number;
    hitWidth: number;
    width: number;
  };
  y: number;
  hidden: boolean;
  onUpload: (target: ShelfUploadTarget) => void;
  dragDist: React.MutableRefObject<number>;
}

function UploadPlaceholder({
  target,
  y,
  hidden,
  onUpload,
  dragDist,
}: UploadPlaceholderProps) {
  const [hovered, setHovered] = useState(false);
  const bookRef = useRef<THREE.Group>(null);
  const spineRef = useRef<THREE.MeshBasicMaterial>(null);
  const bodyRef = useRef<THREE.MeshStandardMaterial>(null);
  const bookHeight = BOOK_HEIGHT * 0.94;
  const shelfY = y - (BOOK_HEIGHT - bookHeight) / 2;

  const geometry = useMemo(
    () => new RoundedBoxGeometry(target.width, bookHeight, BOOK_DEPTH, 2, 0.02),
    [target.width, bookHeight]
  );
  useEffect(() => () => geometry.dispose(), [geometry]);

  const ghostTex = useMemo(() => {
    const t = new THREE.CanvasTexture(makeUploadGhostCanvas());
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, []);
  useEffect(() => () => ghostTex.dispose(), [ghostTex]);

  useEffect(() => {
    if (hidden) {
      setHovered(false);
      document.body.style.cursor = '';
      return;
    }
    document.body.style.cursor = hovered ? 'copy' : '';
    return () => {
      document.body.style.cursor = '';
    };
  }, [hovered, hidden]);

  useFrame((state, delta) => {
    const group = bookRef.current;
    const body = bodyRef.current;
    const spine = spineRef.current;
    if (!group || !body || !spine) return;
    const k = 1 - Math.exp(-delta * 9);
    // Body: barely-there cream volume behind the ghost, hover only.
    const bodyTarget = !hidden && hovered ? 0.14 : 0;
    body.opacity += (bodyTarget - body.opacity) * k;
    // Plus glyph: hover only — idle slots stay clean so the wall doesn't
    // fill up with plus signs.
    const ghostTarget = !hidden && hovered ? 0.95 : 0;
    spine.opacity += (ghostTarget - spine.opacity) * k;
    group.position.z =
      (hovered && !hidden ? 0.05 : 0) +
      Math.sin(state.clock.elapsedTime * 2.4) * (hovered && !hidden ? 0.01 : 0);
  });

  const handleClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      if (hidden || dragDist.current > 12) return;
      onUpload({
        shelfSlotId: target.shelfSlotId,
        row: target.rowCoord,
        col: target.colCoord,
        label: target.label ?? null,
      });
    },
    [dragDist, hidden, onUpload, target]
  );

  return (
    <group>
      <mesh
        position={[target.hitX, y, BOOK_DEPTH / 2 + 0.1]}
        onPointerOver={(e) => {
          e.stopPropagation();
          if (!hidden) setHovered(true);
        }}
        onPointerOut={() => setHovered(false)}
        onClick={handleClick}
      >
        <boxGeometry args={[target.hitWidth, BOOK_HEIGHT, 0.16]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <group ref={bookRef} position={[target.x, shelfY, 0]}>
        <mesh
          geometry={geometry}
          position={[0, 0, 0.03]}
          onPointerOver={(e) => {
            e.stopPropagation();
            if (!hidden) setHovered(true);
          }}
          onPointerOut={() => setHovered(false)}
          onClick={handleClick}
        >
          <meshStandardMaterial
            ref={bodyRef}
            color="#efe3cf"
            roughness={0.78}
            transparent
            opacity={0}
            depthWrite={false}
          />
        </mesh>
        <mesh position={[0, 0, BOOK_DEPTH / 2 + 0.064]}>
          <planeGeometry args={[target.width, bookHeight]} />
          <meshBasicMaterial
            ref={spineRef}
            map={ghostTex}
            transparent
            opacity={0}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      </group>
    </group>
  );
}

/** Built-in wall unit: a uniform grid of bays, floor to ceiling. */
function Bookcase({
  totalRows,
  totalCols,
  slotLabels,
  onEditLabel,
  labelsHidden,
  dragDist,
}: {
  totalRows: number;
  totalCols: number;
  slotLabels: PlacedShelfLabel[];
  onEditLabel?: (label: PlacedShelfLabel) => void;
  labelsHidden: boolean;
  dragDist: React.MutableRefObject<number>;
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
    // Tile the grain along long boards instead of stretching one plank.
    t.repeat.set(2.6, 1);
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
  // The exposed back of the case: vertical planks with seams, like the
  // veneer back panels of real wall units.
  const backTex = useMemo(() => {
    const t = new THREE.CanvasTexture(makePanelCanvas('ovid-back'));
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  }, []);
  useEffect(() => {
    backTex.repeat.set(width / 3.2, (height + boardT) / 3.2);
  }, [backTex, width, height, boardT]);
  const cavityTex = useMemo(
    () => new THREE.CanvasTexture(makeCavityShadeCanvas()),
    []
  );
  useEffect(
    () => () => {
      boardTex.dispose();
      sideTex.dispose();
      backTex.dispose();
      cavityTex.dispose();
    },
    [boardTex, sideTex, backTex, cavityTex]
  );

  return (
    <group>
      {/* back panel — the case's own back, covering the wall behind it */}
      <mesh position={[0, midY, -BOOK_DEPTH / 2 - 0.09]} receiveShadow>
        <boxGeometry args={[width, height + boardT, 0.06]} />
        <meshStandardMaterial map={backTex} color="#a2907e" roughness={0.88} />
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
      {slotLabels.map((label) => {
        const editable =
          !!onEditLabel && !label.isPublic && label.slotId !== null;
        // Blank holders exist purely as an edit affordance — don't even
        // mount them (or their canvas textures) for read-only viewers.
        if (!label.text && !editable) return null;
        return (
          <ShelfLabel
            key={label.key}
            label={label}
            y={rows[label.row + 1] - BOOK_HEIGHT / 2 - SHELF_LABEL_HEIGHT / 2}
            editable={editable}
            hidden={labelsHidden}
            onEdit={onEditLabel}
            dragDist={dragDist}
          />
        );
      })}
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

/**
 * Camera control. The view is always clamped to the wall: panning stops at
 * the wall edges and zooming out stops once the wall fills the frame.
 * Desktop: mouse-move gaze + wheel dolly. Touch: one-finger drag pans,
 * two-finger pinch zooms; small taps still select books.
 */
function CameraRig({
  focused,
  contentW,
  contentH,
  wallW,
  caseTop,
  caseBottom,
  dragDist,
  dragPointerId,
}: {
  focused: boolean;
  contentW: number;
  contentH: number;
  wallW: number;
  caseTop: number;
  caseBottom: number;
  dragDist: React.MutableRefObject<number>;
  /** Pointer id currently picking up a book — excluded from pan/pinch. */
  dragPointerId: React.MutableRefObject<number | null>;
}) {
  const { camera, gl, size } = useThree();
  const zoom = useRef<number | null>(null);
  const userZoomed = useRef(false);
  const touchMode = useRef(false);
  const pan = useRef({ x: 0, y: (caseTop + caseBottom) / 2 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchDist = useRef(0);

  const tanHalf = Math.tan((38 / 2) * (Math.PI / 180));
  const aspect = size.width / size.height;
  const wallH = caseTop - caseBottom;
  const wallMidY = (caseTop + caseBottom) / 2;

  // Zooming out stops once the wall fills the frame in one dimension.
  const maxZoom = useMemo(() => {
    if (!wallW) return 8;
    const zForWidth = wallW / 2 / (tanHalf * aspect);
    const zForHeight = wallH / 2 / tanHalf;
    return Math.max(MIN_ZOOM + 0.5, Math.min(zForWidth, zForHeight));
  }, [wallW, wallH, tanHalf, aspect]);
  const maxZoomRef = useRef(maxZoom);
  maxZoomRef.current = maxZoom;

  // Distance at which the content bays fit in view, with some margin.
  const fitZ = useMemo(() => {
    if (!contentW) return 6;
    const zForWidth = (contentW / 2 + 0.55) / (tanHalf * aspect);
    const zForHeight = contentH / 2 / tanHalf + 0.9;
    return THREE.MathUtils.clamp(
      Math.max(zForWidth, zForHeight),
      MIN_ZOOM,
      maxZoom
    );
  }, [contentW, contentH, tanHalf, aspect, maxZoom]);

  // Follow layout changes until the user takes over the wheel.
  useEffect(() => {
    if (!userZoomed.current) zoom.current = fitZ;
  }, [fitZ]);

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

  // Touch gestures: drag to pan, pinch to zoom. dragDist lets book meshes
  // tell a pan apart from a tap.
  useEffect(() => {
    const el = gl.domElement;
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      // This finger is picking up a book — it must not also pan/pinch.
      if (e.pointerId === dragPointerId.current) return;
      touchMode.current = true;
      dragDist.current = 0;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.current.size === 2) {
        const [a, b] = Array.from(pointers.current.values());
        pinchDist.current = Math.hypot(a.x - b.x, a.y - b.y);
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      if (e.pointerId === dragPointerId.current) {
        // Evict a stale entry seeded by the pointerdown tick above, so a
        // second unrelated finger's pinch math never mixes in this one's
        // now-frozen coordinate.
        pointers.current.delete(e.pointerId);
        return;
      }
      const prev = pointers.current.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.current.size >= 2) {
        const [a, b] = Array.from(pointers.current.values());
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist.current > 0 && d > 0) {
          userZoomed.current = true;
          zoom.current = THREE.MathUtils.clamp(
            (zoom.current ?? 6) * (pinchDist.current / d),
            MIN_ZOOM,
            maxZoomRef.current
          );
        }
        pinchDist.current = d;
        dragDist.current += 100; // a pinch is never a tap
        return;
      }
      dragDist.current += Math.abs(dx) + Math.abs(dy);
      // Convert pixel deltas to world units at the wall plane.
      const worldPerPx =
        (2 * Math.tan((38 / 2) * (Math.PI / 180)) * camera.position.z) /
        size.height;
      pan.current.x -= dx * worldPerPx;
      pan.current.y += dy * worldPerPx;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      pointers.current.delete(e.pointerId);
      if (pointers.current.size < 2) pinchDist.current = 0;
    };
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
    };
  }, [gl, camera, size, dragDist, dragPointerId]);

  useFrame((state, delta) => {
    const k = 1 - Math.exp(-delta * 4);
    const z = zoom.current ?? fitZ;
    // Clamp the pan so the frustum never leaves the wall.
    const visHalfH = tanHalf * z;
    const visHalfW = visHalfH * aspect;
    const xMax = Math.max(0, wallW / 2 - visHalfW);
    let yMin = caseBottom + visHalfH;
    let yMax = caseTop - visHalfH;
    if (yMin > yMax) yMin = yMax = wallMidY;

    let tx: number;
    let ty: number;
    if (touchMode.current) {
      pan.current.x = THREE.MathUtils.clamp(pan.current.x, -xMax, xMax);
      pan.current.y = THREE.MathUtils.clamp(pan.current.y, yMin, yMax);
      tx = pan.current.x;
      ty = pan.current.y;
    } else {
      // While a book is presented, quiet the gaze so the pose feels stable.
      const gaze = focused ? 0.18 : 1;
      tx = state.pointer.x * xMax * gaze;
      ty = THREE.MathUtils.clamp(
        wallMidY + state.pointer.y * ((yMax - yMin) / 2) * gaze,
        yMin,
        yMax
      );
    }
    camera.position.x += (tx - camera.position.x) * k;
    camera.position.y += (ty - camera.position.y) * k;
    camera.position.z += (z - camera.position.z) * k;
    camera.lookAt(camera.position.x, camera.position.y, 0);
  });

  return null;
}

// Fill light for the flown-out book. The key spotlight is aimed at the wall,
// so a presented book — floating well in front of it — would only catch
// ambient light and read too dark, most visibly on phones where the camera
// sits far back. decay=2 keeps the light local to the book: the wall behind
// is far enough away that it stays effectively untouched.
function SelectionLight({ active }: { active: boolean }) {
  const ref = useRef<THREE.PointLight>(null);
  useFrame((state, delta) => {
    const l = ref.current;
    if (!l) return;
    const k = 1 - Math.exp(-delta * 7);
    l.intensity += ((active ? 2.1 : 0) - l.intensity) * k;
    const cam = state.camera;
    l.position.set(cam.position.x, cam.position.y + 0.55, cam.position.z - 1.0);
  });
  return <pointLight ref={ref} intensity={0} decay={2} color="#f2e6d2" />;
}

const BookShelf3D: React.FC<BookShelf3DProps> = ({
  books,
  shelfSlots,
  loading,
  showProgress,
  progressMap,
  translationProgress,
  currentUserId,
  onRead,
  onDelete,
  onUploadToSlot,
  onMoveBook,
  onSaveSlotLabel,
}) => {
  const [spineRatios, setSpineRatios] = useState<Map<string, number>>(
    new Map()
  );
  const [selectedUuid, setSelectedUuid] = useState<string | null>(null);
  // Shelf-label editing (click a label / empty label strip to open).
  const [editingLabel, setEditingLabel] = useState<PlacedShelfLabel | null>(
    null
  );
  const [labelDraft, setLabelDraft] = useState('');
  const [savingLabel, setSavingLabel] = useState(false);

  const handleEditLabel = useCallback((label: PlacedShelfLabel) => {
    setLabelDraft(label.text);
    setEditingLabel(label);
  }, []);

  const handleSaveLabel = useCallback(async () => {
    // Explicit null check — the click affordance gates on `slotId !== null`,
    // and a falsy check here would silently no-op a legitimate id of 0.
    if (editingLabel?.slotId == null || !onSaveSlotLabel || savingLabel) return;
    setSavingLabel(true);
    const ok = await onSaveSlotLabel(editingLabel.slotId, labelDraft.trim());
    setSavingLabel(false);
    if (ok) setEditingLabel(null);
  }, [editingLabel, onSaveSlotLabel, labelDraft, savingLabel]);

  // Track how many books with image URLs have finished loading.
  const booksWithUrls = useMemo(
    () =>
      books.filter((b) => b.book_spine_img_url || b.book_cover_img_url).length,
    [books]
  );
  const [readyCount, setReadyCount] = useState(0);
  const readySet = useRef(new Set<string>());
  const handleArtReady = useCallback((uuid: string) => {
    if (readySet.current.has(uuid)) return;
    readySet.current.add(uuid);
    setReadyCount(readySet.current.size);
  }, []);
  const allArtReady = booksWithUrls === 0 || readyCount >= booksWithUrls;

  // The loading veil blocks interaction until every spine has settled, but
  // only for the initial reveal — art streaming in later (fresh uploads,
  // artwork refresh) must not re-lock the UI. A timeout caps how long a
  // stalled network can hold the shelf hostage.
  const [revealed, setRevealed] = useState(false);
  // One quip per visit, shared by the fetch screen and the art veil so the
  // two loading phases read as a single moment.
  const quip = useMemo(
    () => LOADING_QUIPS[Math.floor(Math.random() * LOADING_QUIPS.length)],
    []
  );
  useEffect(() => {
    if (revealed || loading) return;
    if (allArtReady) {
      setRevealed(true);
      return;
    }
    const t = setTimeout(() => setRevealed(true), 10000);
    return () => clearTimeout(t);
  }, [allArtReady, loading, revealed]);

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

  const layout = useMemo(
    () => layoutBooks(books, spineRatios, undefined, undefined, shelfSlots),
    [books, spineRatios, shelfSlots]
  );
  const {
    placements,
    slotLabels,
    uploadTargets,
    contentRows,
    contentCols,
    totalRows,
    totalCols,
    wallWidth,
  } = layout;
  const rowCenters = useMemo(() => rowYCenters(totalRows), [totalRows]);
  const caseTop =
    totalRows > 0 ? rowCenters[0] + BOOK_HEIGHT / 2 + 0.18 + 0.09 : 3;
  const caseBottom =
    totalRows > 0 ? rowCenters[totalRows - 1] - BOOK_HEIGHT / 2 - 0.09 : -3;
  // Books ignore taps that were actually the tail end of a touch pan.
  const dragDist = useRef(0);
  // Real pointer drag-to-move state, shared across every BookMesh + CameraRig.
  const draggingUuid = useRef<string | null>(null);
  const dragPointerId = useRef<number | null>(null);
  const dragWorldPos = useRef(new THREE.Vector3());
  const dragShift = useRef<{ uuids: Set<string>; amount: number } | null>(
    null
  );
  const bookByUuid = useMemo(
    () => new Map(books.map((b) => [b.uuid, b])),
    [books]
  );
  // Books sitting on a public (seeded-collection) shelf are locked in place,
  // even when the viewer happens to own them.
  const publicShelfUuids = useMemo(
    () =>
      new Set(
        layout.bays
          .filter((bay) => bay.isPublic)
          .flatMap((bay) => bay.bookUuids)
      ),
    [layout]
  );

  const handleDragEnd = useCallback(
    (bookUuid: string, candidate: DropTarget | null) => {
      if (!candidate || !onMoveBook) return;
      onMoveBook(
        bookUuid,
        {
          slotId: candidate.shelfSlotId,
          row: candidate.rowCoord,
          col: candidate.colCoord,
        },
        candidate.insertIndex
      );
    },
    [onMoveBook]
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
      if (e.key === 'Escape') {
        setSelectedUuid(null);
        setEditingLabel(null);
      }
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
        onPointerMissed={() => {
          if (dragDist.current <= 12) setSelectedUuid(null);
        }}
      >
        <color attach="background" args={[ROOM]} />
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
        <SelectionLight active={!!selectedUuid} />

        {totalRows > 0 && (
          <Bookcase
            totalRows={totalRows}
            totalCols={totalCols}
            slotLabels={slotLabels}
            onEditLabel={
              onSaveSlotLabel && currentUserId != null
                ? handleEditLabel
                : undefined
            }
            labelsHidden={selectedUuid !== null}
            dragDist={dragDist}
          />
        )}

        {placements.map((p) => {
          const book = bookByUuid.get(p.uuid);
          if (!book) return null;
          const y = rowCenters[p.row + 1];
          const progress = translationProgress.get(book.uuid);
          const processingProgress =
            progress && progress.chaptersTotal > 0
              ? progress.chaptersCompleted / progress.chaptersTotal
              : 0;
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
              onArtReady={handleArtReady}
              processingProgress={processingProgress}
              dragDist={dragDist}
              draggable={
                currentUserId != null &&
                book.user_id === currentUserId &&
                !publicShelfUuids.has(book.uuid)
              }
              layout={layout}
              draggingUuid={draggingUuid}
              dragPointerId={dragPointerId}
              dragWorldPos={dragWorldPos}
              dragShift={dragShift}
              onDragEnd={handleDragEnd}
            />
          );
        })}

        {onUploadToSlot &&
          uploadTargets.map((target) => {
            const y = rowCenters[target.row + 1];
            return (
              <UploadPlaceholder
                key={`upload-${target.rowCoord}:${target.colCoord}`}
                target={target}
                y={y}
                hidden={loading || selectedUuid !== null}
                onUpload={onUploadToSlot}
                dragDist={dragDist}
              />
            );
          })}

        <CameraRig
          focused={selectedUuid !== null}
          contentW={contentCols * BAY_PITCH}
          contentH={contentRows * ROW_HEIGHT}
          wallW={wallWidth}
          caseTop={caseTop}
          caseBottom={caseBottom}
          dragDist={dragDist}
          dragPointerId={dragPointerId}
        />
      </Canvas>

      {editingLabel && (
        <div
          className="closet3d-panel closet3d-label-editor"
          role="dialog"
          aria-label="Edit shelf label"
        >
          <h3>Shelf label</h3>
          <input
            type="text"
            value={labelDraft}
            maxLength={40}
            placeholder="e.g. Sci-fi, To read…"
            autoFocus
            onChange={(e) => setLabelDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') handleSaveLabel();
              if (e.key === 'Escape') setEditingLabel(null);
            }}
          />
          <div className="closet3d-label-editor-actions">
            <button
              className="closet3d-read-btn"
              onClick={handleSaveLabel}
              disabled={savingLabel}
            >
              {savingLabel ? 'Saving…' : 'Save'}
            </button>
            <button
              className="closet3d-label-cancel-btn"
              onClick={() => setEditingLabel(null)}
              disabled={savingLabel}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {!loading && (
        <div
          className={`closet3d-blur-overlay ${revealed ? 'closet3d-blur-clear' : ''}`}
        >
          <div className="closet3d-spinner closet3d-blur-spinner" />
          <p className="closet3d-loading-quip">{quip}</p>
        </div>
      )}

      {loading && (
        <div className="closet3d-loading">
          <div className="closet3d-spinner" />
          <p className="closet3d-loading-quip">{quip}</p>
        </div>
      )}

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

          {isBookImportPending(selectedBook) ? (
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
                      : selectedBook.status === 'processing' &&
                          !selectedBook.language_pair?.endsWith('-none')
                        ? 'Translating…'
                        : 'Preparing cover and spine…'}
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
