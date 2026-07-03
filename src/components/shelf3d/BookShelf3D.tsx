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
  BOOK_DEPTH,
  BOOK_HEIGHT,
  DEFAULT_SPINE_RATIO,
  ROW_HEIGHT,
  clampSpineRatio,
  layoutBooks,
  rowYCenters,
} from './layout';
import { makeCoverCanvas, makeSpineCanvas } from './fallbackTextures';
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

const WOOD = '#77522e';
const WOOD_DARK = '#5c3d20';
const ROOM = '#171210';
const PAGES = '#efe5cc';

const MIN_ZOOM = 2.5;
const MAX_ZOOM = 9;

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

  const spineTex = useArtTexture(
    book.book_spine_img_url,
    () => makeSpineCanvas(book.original_title || book.title),
    (tex) => {
      const img = tex.image as { width?: number; height?: number };
      if (img?.width && img?.height) {
        onSpineRatio(book.uuid, clampSpineRatio(img.width / img.height));
      }
    }
  );
  const coverTex = useArtTexture(book.book_cover_img_url, () =>
    makeCoverCanvas(book.original_title || book.title, book.author)
  );

  useEffect(() => {
    document.body.style.cursor = hovered ? 'pointer' : '';
    return () => {
      document.body.style.cursor = '';
    };
  }, [hovered]);

  // Place the book at its shelf spot on first render so it doesn't fly in
  // from the origin.
  useEffect(() => {
    group.current?.position.set(...position);
  }, []);

  useFrame((state, delta) => {
    const g = group.current;
    if (!g) return;
    const k = 1 - Math.exp(-delta * 7);

    let tx = position[0];
    let ty = position[1];
    let tz = position[2];
    let ry = 0;

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
    } else if (hovered && !anySelected && !processing) {
      tz = position[2] + 0.22;
    }

    g.position.x += (tx - g.position.x) * k;
    g.position.y += (ty - g.position.y) * k;
    g.position.z += (tz - g.position.z) * k;
    g.rotation.y += (ry - g.rotation.y) * k;

    // Brightness: dim unselected books while one is out; pulse processing.
    const m = mesh.current;
    if (m && Array.isArray(m.material)) {
      let target = 1;
      if (anySelected && !selected) target = 0.35;
      else if (processing) {
        target = 0.55 + Math.sin(state.clock.elapsedTime * 2.5) * 0.12;
      }
      for (const mat of m.material as THREE.MeshStandardMaterial[]) {
        const v = mat.color.r + (target - mat.color.r) * k;
        mat.color.setScalar(v);
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
        onClick={handleClick}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
        }}
        onPointerOut={() => setHovered(false)}
      >
        <boxGeometry args={[width, BOOK_HEIGHT, BOOK_DEPTH]} />
        {/* +x: front cover (faces camera when the book turns out) */}
        <meshStandardMaterial
          attach="material-0"
          map={coverTex}
          roughness={0.62}
        />
        {/* -x: back cover */}
        <meshStandardMaterial
          attach="material-1"
          color="#3a3026"
          roughness={0.7}
        />
        {/* +y / -y: page block */}
        <meshStandardMaterial
          attach="material-2"
          color={PAGES}
          roughness={0.9}
        />
        <meshStandardMaterial
          attach="material-3"
          color={PAGES}
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
          color={PAGES}
          roughness={0.9}
        />
      </mesh>
    </group>
  );
}

/** Wooden bookcase frame sized to the shelf rows. */
function Bookcase({
  rowCount,
  caseWidth,
}: {
  rowCount: number;
  caseWidth: number;
}) {
  const rows = rowYCenters(rowCount);
  const width = caseWidth + 0.5;
  const boardT = 0.08;
  const depth = BOOK_DEPTH + 0.28;
  const headroom = 0.34;
  const topY = rows[0] + BOOK_HEIGHT / 2 + headroom;
  const bottomY = rows[rows.length - 1] - BOOK_HEIGHT / 2 - boardT;
  const height = topY - bottomY;
  const midY = (topY + bottomY) / 2;

  return (
    <group>
      {/* back panel */}
      <mesh position={[0, midY, -BOOK_DEPTH / 2 - 0.09]}>
        <boxGeometry args={[width + 0.3, height + 0.2, 0.06]} />
        <meshStandardMaterial color={WOOD_DARK} roughness={0.92} />
      </mesh>
      {/* side panels */}
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * (width / 2 + 0.09), midY, -0.02]}>
          <boxGeometry args={[0.18, height + 0.2, depth]} />
          <meshStandardMaterial color={WOOD} roughness={0.85} />
        </mesh>
      ))}
      {/* top cap */}
      <mesh position={[0, topY + boardT / 2, -0.02]}>
        <boxGeometry args={[width + 0.36, boardT, depth]} />
        <meshStandardMaterial color={WOOD} roughness={0.85} />
      </mesh>
      {/* a board under every row of books */}
      {rows.map((y, i) => (
        <mesh key={i} position={[0, y - BOOK_HEIGHT / 2 - boardT / 2, -0.02]}>
          <boxGeometry args={[width + 0.2, boardT, depth]} />
          <meshStandardMaterial color={WOOD} roughness={0.85} />
        </mesh>
      ))}
    </group>
  );
}

/** Mouse-move gaze + wheel dolly, framing the bookcase on load. */
function CameraRig({
  focused,
  caseWidth,
  rowCount,
}: {
  focused: boolean;
  caseWidth: number;
  rowCount: number;
}) {
  const { camera, gl, size } = useThree();
  const zoom = useRef<number | null>(null);
  const userZoomed = useRef(false);

  // Distance at which the whole bookcase fits in view, with some margin.
  const fitZ = useMemo(() => {
    if (!caseWidth || !rowCount) return 6;
    const tanHalf = Math.tan((38 / 2) * (Math.PI / 180));
    const aspect = size.width / size.height;
    const zForWidth = (caseWidth / 2 + 0.55) / (tanHalf * aspect);
    const zForHeight = (rowCount * ROW_HEIGHT) / 2 / tanHalf + 0.6;
    return THREE.MathUtils.clamp(
      Math.max(zForWidth, zForHeight),
      MIN_ZOOM,
      MAX_ZOOM
    );
  }, [caseWidth, rowCount, size]);

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
        MAX_ZOOM
      );
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [gl]);

  useFrame((state, delta) => {
    const k = 1 - Math.exp(-delta * 4);
    // While a book is presented, quiet the gaze so the pose feels stable.
    const gaze = focused ? 0.18 : 1;
    const tx = state.pointer.x * 1.55 * gaze;
    const ty = state.pointer.y * 0.5 * gaze;
    camera.position.x += (tx - camera.position.x) * k;
    camera.position.y += (ty - camera.position.y) * k;
    camera.position.z += ((zoom.current ?? fitZ) - camera.position.z) * k;
    camera.lookAt(camera.position.x * 1.35, camera.position.y * 0.75, 0);
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

  const { placements, rowCount, caseWidth } = useMemo(
    () => layoutBooks(books, spineRatios),
    [books, spineRatios]
  );
  const rowCenters = useMemo(() => rowYCenters(rowCount), [rowCount]);
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
        camera={{ fov: 38, position: [0, 0, initialZ], near: 0.1, far: 60 }}
        gl={{ antialias: true }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.NoToneMapping;
        }}
        onPointerMissed={() => setSelectedUuid(null)}
      >
        <color attach="background" args={[ROOM]} />
        <fog attach="fog" args={[ROOM, 8, 24]} />
        <ambientLight intensity={0.92} />
        <directionalLight
          position={[2.5, 4, 6]}
          intensity={0.55}
          color="#ffe9c9"
        />
        <directionalLight
          position={[-3, 1.5, 4]}
          intensity={0.25}
          color="#cfd8ff"
        />

        {rowCount > 0 && <Bookcase rowCount={rowCount} caseWidth={caseWidth} />}

        {placements.map((p) => {
          const book = bookByUuid.get(p.uuid);
          if (!book) return null;
          const y = rowCenters[p.row];
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
          caseWidth={caseWidth}
          rowCount={rowCount}
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
