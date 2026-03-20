# Homepage Redesign Plan

## Goal
Redesign the OVID bookshelf homepage to match the provided mockup. The mockup shows a photorealistic, skeuomorphic bookshelf with 3D book effects.

## Reference Mockup (Key Elements)

### Layout
- **Left column (~65%)**: Wooden bookshelf with books
- **Right column (~35%)**: Selected book detail panel (dark background `#1e2024`)
- **Header**: Flame icon + "OVID Library" (left), hamburger menu (right) — transparent overlay
- **Bottom bar**: "OVID" text + Google Sign-in button, frosted glass overlay on shelf

### Bookshelf (Left)
- Rich walnut/mahogany wood texture (`#6b4226` to `#8b5e3c`)
- Books standing upright, tightly packed (~16-17 books)
- **Selected book pulled out at ~20-25° angle** (rotateY with perspective) — this is the key interaction
- Each book spine has:
  - Gold/cream serif title text (vertical, bottom-to-top)
  - Gold decorative horizontal bands at top/bottom thirds
  - Small gold emblem/icon near bottom
  - Subtle 3D rounding effect (lighter center, darker edges)
- Top shadow from shelf above falling onto book tops
- Warm golden ambient lighting from upper-left
- Visible page edges (cream/off-white) on shorter books
- A blurred row of books visible above (depth-of-field effect on top shelf)

### Book Detail Panel (Right)
- **3D rendered book cover** with:
  - Slight `rotateY(8-12deg)` perspective tilt
  - Visible spine edge on left (~8-10px, darker shade)
  - Visible top page edges (cream)
  - Large soft drop shadow (`20px 30px 60px rgba(0,0,0,0.6)`)
  - Gold decorative border/frame with corner flourishes on cover
  - Cover-specific icon centered (e.g., flame for Sherlock)
- **Title**: Large serif, white, ~36-42px, bold
- **Chinese title**: Below, lighter gray `#a0a0a0`, ~20-24px
- **Author**: Even lighter gray `#707070`, ~16px, "by Author Name"

### Bottom Bar
- Semi-transparent frosted glass over shelf bottom (`rgba(30,28,25,0.85)` + backdrop-blur)
- "OVID" in bold sans-serif, white, 28-32px, letter-spacing 2-3px
- Google Sign-in button: rounded rect, semi-transparent dark gray, Google G logo + "Sign in"
- Both centered as a cluster

## Implementation Steps

### Phase 1: Shelf Visual Overhaul
1. **Remove current shelf-board CSS gradients**, replace with higher-quality wood texture
2. **Improve shelf compartment depth** — multi-layer inset shadows for realistic inner depth
3. **Add top shelf blur effect** — a blurred row of decorative book shapes above the main shelf (CSS blur or a static blurred image)
4. **Warm directional lighting** — gradient overlay from upper-left (warm gold to transparent)

### Phase 2: Book Spine Redesign
1. **Redesign default spine style** — gold serif text, decorative horizontal bands, emblem at bottom
2. **Improve spine 3D effect** — subtle vertical gradient (lighter center) for rounded-spine illusion
3. **Selected state: book pull-out** — on click/hover, apply `rotateY(-20deg)` with `perspective(800px)` + `translateZ(20px)`, show front cover edge
4. **Page edge visibility** — cream-colored pseudo-element on top/right of each book

### Phase 3: Book Detail Panel
1. **3D cover rendering** — CSS 3D transforms: `rotateY(8deg)` with perspective, spine edge as pseudo-element, top edge as pseudo-element, large soft shadow
2. **Typography update** — serif font for title (Playfair Display or Georgia), Chinese subtitle below, author below that
3. **Clean layout** — centered content, generous spacing

### Phase 4: Header & Bottom Bar
1. **Header**: Transparent overlay, flame icon + "OVID Library" left, hamburger right
2. **Bottom bar**: Frosted glass (backdrop-filter: blur), "OVID" logo + Sign-in button centered
3. **Move current shelf-board controls** into the new header/bottom bar positions

### Phase 5: Polish
1. **Hover/interaction transitions** — smooth transforms for book pull-out
2. **Mobile responsive** — bottom sheet preserved, adapted layout
3. **Test with existing book spine/cover images** — ensure generated assets look right
4. **Deploy to staging**

## Technical Notes
- Keep all existing functionality (upload, credits, translation progress, mobile bottom sheet)
- The interaction model changes: currently hover shows preview, mockup suggests click-to-select with pull-out animation
- Shelf structure (upper/lower compartments, public/user books) stays the same
- All changes are CSS + minor React state changes, no API/backend changes
- Font: Consider adding Playfair Display via Google Fonts for the serif title

## Files to Modify
- `src/components/BookShelf.tsx` — React component changes
- `src/components/BookShelf.css` — Major CSS overhaul
- `public/index.html` — Add Google Fonts link if needed
- Possibly add new texture assets to `public/`

## Deployment
```bash
npm run deploy -- --env staging
```
Staging URL: https://ovid-staging.drapor.workers.dev
