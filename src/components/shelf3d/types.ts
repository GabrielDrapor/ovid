// Shared shapes between the classic BookShelf and the 3D closet view.

export interface Book {
  id: number;
  uuid: string;
  title: string;
  original_title: string;
  author: string;
  language_pair: string;
  book_cover_img_url: string | null;
  book_spine_img_url: string | null;
  user_id: number | null;
  status: string | null; // 'ready' | 'processing' | 'error'
  display_order?: number | null;
  shelf_id?: string | null;
  shelf_position?: number | null;
  shelf_slot_id?: number | null;
  shelf_row?: number | null;
  shelf_col?: number | null;
  shelf_slot_order?: number | null;
  shelf_slot_label?: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserBookProgress {
  id: number;
  user_id: number;
  book_uuid: string;
  is_completed: number; // 0 or 1
  reading_progress: number | null;
  completed_at: string | null;
  last_read_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TranslationProgress {
  phase: string;
  chaptersCompleted: number;
  chaptersTotal: number;
}

export interface ShelfUploadTarget {
  shelfSlotId?: number | null;
  row: number;
  col: number;
  label?: string | null;
}

export interface ShelfMoveTarget {
  slotId: number | null;
  row: number;
  col: number;
}

export interface ShelfSlot {
  id: number;
  shelf_id: string;
  row: number;
  col: number;
  sort_order: number;
  label?: string | null;
  is_public?: number | null;
}
