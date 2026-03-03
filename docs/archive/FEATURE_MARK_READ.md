# 「标记读完」功能实现

## 概述
用户现在可以在书籍信息卡片中标记**任何书籍**（公共或个人上传）为「读完」，系统会为每个用户单独记录阅读状态。

## 设计原则

### 多对多关系
- **一个用户** 可以标记 **多本书** 为已读
- **一本书** 可以被 **多个用户** 分别标记为已读
- 使用独立的 `user_book_progress` 表存储这种关系，不污染 `books_v2` 表

### 优势
- 公共书和用户上传的书都支持标记已读
- 支持多用户环境（同一本书不同用户有不同状态）
- 为未来扩展预留空间（如读取进度百分比、最后阅读时间等）
- 易于删除用户数据或重置阅读状态

---

## 数据模型

### 表结构：user_book_progress

```sql
CREATE TABLE user_book_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,           -- 用户 ID
  book_uuid TEXT NOT NULL,            -- 书籍 UUID
  is_completed INTEGER DEFAULT 0,     -- 0 = 未读，1 = 已读
  reading_progress INTEGER,           -- 未来用：0-100 百分比
  completed_at DATETIME,              -- 标记为已读的时间
  last_read_at DATETIME,              -- 最后阅读时间
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, book_uuid)          -- 防止重复，同一用户对同一书只有一条记录
)
```

### 关键设计
- `UNIQUE(user_id, book_uuid)` 确保不会有重复记录
- 使用 `ON CONFLICT ... DO UPDATE` 实现 upsert，支持状态切换
- `completed_at` 条件性设置：标记为已读时有值，取消标记时为 NULL
- 预留 `reading_progress` 和 `last_read_at` 字段供未来扩展

---

## API 端点

### 1. 标记书籍为已读/未读

**POST /api/book/:uuid/mark-complete**

**请求：**
```json
{
  "isCompleted": true
}
```

**响应：**
```json
{
  "success": true,
  "progress": {
    "id": 1,
    "user_id": 123,
    "book_uuid": "abc-def-ghi",
    "is_completed": 1,
    "reading_progress": null,
    "completed_at": "2026-02-15T04:50:00.000Z",
    "last_read_at": "2026-02-15T04:50:00.000Z",
    "created_at": "2026-02-15T04:50:00.000Z",
    "updated_at": "2026-02-15T04:50:00.000Z"
  }
}
```

**认证：** 必需 ✓

---

### 2. 获取用户对某本书的阅读状态

**GET /api/book/:uuid/progress**

**响应：**
```json
{
  "progress": {
    "id": 1,
    "user_id": 123,
    "book_uuid": "abc-def-ghi",
    "is_completed": 1,
    "reading_progress": null,
    "completed_at": "2026-02-15T04:50:00.000Z",
    "last_read_at": "2026-02-15T04:50:00.000Z",
    "created_at": "2026-02-15T04:50:00.000Z",
    "updated_at": "2026-02-15T04:50:00.000Z"
  }
}
```

**认证：** 可选（未登录返回 `{ progress: null }`）

---

## 前端实现

### 数据流

1. **页面加载**：获取书籍列表 + 当前用户的所有阅读进度
2. **悬停书籍**：查询本地缓存的进度数据（`bookProgressMap`）
3. **点击按钮**：发送 POST 请求，更新数据库并刷新本地状态

### 组件状态

```typescript
const [books, setBooks] = useState<Book[]>([]);
const [bookProgressMap, setBookProgressMap] = useState<Map<string, UserBookProgress>>(new Map());
```

### 事件处理

```typescript
const handleToggleCompleted = async (e, bookUuid, currentProgress) => {
  // 1. POST 到 /api/book/:uuid/mark-complete
  // 2. 收到新的 progress 对象
  // 3. 更新 bookProgressMap
  // 4. UI 自动反映新状态
}
```

### UI 显示

- **绿色徽章**：仅在 `progress.is_completed === 1` 时显示
- **按钮文本**：`progress?.is_completed ? '标记为未读' : '标记为已读'`
- **按钮样式**：已完成状态时应用 `.completed` 类（绿色边框）

---

## 关键实现细节

### 后端（db.ts）

```typescript
export async function upsertUserBookProgress(
  db: D1Database,
  userId: number,
  bookUuid: string,
  isCompleted: boolean
): Promise<void>

export async function getUserBookProgress(
  db: D1Database,
  userId: number,
  bookUuid: string
): Promise<UserBookProgress | null>
```

### SQL 更新逻辑

```sql
INSERT INTO user_book_progress (user_id, book_uuid, is_completed, completed_at, last_read_at)
VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
ON CONFLICT(user_id, book_uuid) DO UPDATE SET
  is_completed = ?,
  completed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END,
  last_read_at = CURRENT_TIMESTAMP,
  updated_at = CURRENT_TIMESTAMP
```

- 使用 `ON CONFLICT ... DO UPDATE` 实现 upsert
- `CASE WHEN` 条件性设置 `completed_at`：标记时有值，取消时为 NULL
- 总是更新 `last_read_at` 和 `updated_at`

---

## 用户流程

1. **浏览书籍** → 悬停任何书籍（公共或个人）
2. **查看预览** → 预览卡片显示「Mark as read」按钮
3. **标记已读** → 点击按钮 → 按钮变为「Mark unread」+ 绿色徽章出现
4. **取消标记** → 点击按钮 → 徽章消失，按钮恢复原状
5. **状态持久化** → 刷新页面或下次访问时状态仍保留

---

## 测试检查表

- [ ] 登录用户可以标记公共书籍为已读
- [ ] 登录用户可以标记自己上传的书籍为已读
- [ ] 标记后显示绿色徽章和时间戳
- [ ] 取消标记（Mark unread）后徽章消失
- [ ] 刷新页面后状态保留
- [ ] 未登录用户无法点击标记按钮（或按钮不显示）
- [ ] 同一本书多个用户可以有不同的状态
- [ ] 删除用户上传的书籍，其读完记录仍可保留（可选）

---

## 相关文件

- **后端：**
  - `src/worker/db.ts` - `upsertUserBookProgress()`, `getUserBookProgress()`
  - `src/worker/index.ts` - 迁移 + API 路由
  
- **前端：**
  - `src/components/BookShelf.tsx` - `handleToggleCompleted()`, `fetchBooks()`
  - `src/components/BookShelf.css` - `.book-completed-badge`, `.mark-complete-btn`

- **文档：**
  - `docs/FEATURE_MARK_READ.md` - 本文件
