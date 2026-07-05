<p align="center">
  <img src="logo.png" alt="Ovid" width="180" />
</p>

<h1 align="center">Ovid</h1>

<p align="center"><strong>两种语言，轻轻一点。</strong></p>

🔗 **[在线体验 → ovid.ink](https://ovid.ink)**

[English](README.md) | 简体中文

## 功能

- **点击切换** — 点任意段落，原文 ↔ 译文即时切换
- **EPUB 导入** — 上传 EPUB，后台自动翻译
- **3D 书架** — WebGL 胡桃木书墙，布面精装书一字排开：鼠标/触屏平移缩放，点击书本飞出展示详情（无 WebGL 时回退到经典 2D 书架）
- **合成封面** — 每本书都有布面精装封面和书脊，由 EPUB 自带封面合成
- **阅读进度** — 自动记录阅读位置，云端同步
- **无限滚动** — 上下滑动自动加载上一章/下一章
- **CJK 排版** — 霞鹜新致宋屏幕版，精调行高和字间距
- **可安装 PWA** — 添加到主屏幕，新版本可用时弹出刷新提示
- **Google 登录** — 登录后拥有私人书库
- **积分 & 支付** — Stripe 驱动，按书付费翻译

## 工作原理

```
浏览器 (React SPA)
    ↕
Cloudflare Worker — API、认证、静态文件
    ↕                ↘
Cloudflare D1         Cloudflare R2
(书籍、章节、          (封面、书脊、
 段落、用户)            书内图片)
                     ↘
               Railway 翻译服务
               (webhook 触发，LLM 翻译，
                5 章并发，断点续传)
```

**上传流程：** 上传 EPUB → Worker 解析并存入 D1 → webhook 通知 Railway → Railway 逐章翻译（默认使用 gpt-4o-mini）并写回 D1。翻译完成后自动出现在书架上。

**阅读流程：** 点击段落 → 在原文和译文之间切换。基于 XPath 的映射保证段落级精确对齐。

## 快速开始

```bash
git clone https://github.com/GabrielDrapor/ovid.git && cd ovid
yarn install
cp wrangler.toml.example wrangler.toml   # 填入你的 D1 数据库 ID
yarn db:init                           # 建表
yarn preview                           # http://localhost:8787
```

## 常用命令

| 命令 | 说明 |
|---|---|
| `yarn preview` | 本地全栈开发（Worker + React，端口 8787） |
| `yarn deploy` | 构建 + 部署到 Cloudflare Workers |
| `yarn test` | 单元测试（Vitest） |
| `yarn test:visual` | 视觉回归测试（Playwright） |
| `yarn import-book -- --file="book.epub" --target="zh"` | CLI 导入并翻译书籍 |
| `yarn list-books:local` / `remote` | 列出本地/线上书籍 |
| `yarn remove-book:local` / `remote -- --uuid="..."` | 删除书籍 |

## 项目结构

```
src/
  components/        React 组件 — BookShelf（含 shelf3d/）, BilingualReaderV2, ErrorBoundary
  worker/            CF Worker — 认证、书籍处理、积分、数据库
  utils/             公共工具（翻译模块）
services/
  translator/        Railway 翻译服务（Hono + Sharp + D1 客户端、封面合成）
scripts/             CLI 工具 — 导入、列表、删除、同步、生成封面底板
database/            Schema、迁移、示例数据
docs/                架构和翻译系统文档
```

## 文档

- **[CLAUDE.md](CLAUDE.md)** — 开发指南（命令、架构、API、数据库）
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — 系统架构概览
- **[docs/TRANSLATION.md](docs/TRANSLATION.md)** — 翻译管线工作原理
- **[AGENTS.md](AGENTS.md)** — 深度技术参考（EPUB 解析经验、实现细节）

## 许可证

MIT — 详见 [LICENSE](LICENSE)
