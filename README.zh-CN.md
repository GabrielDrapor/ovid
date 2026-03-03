# Ovid 📖

**浏览器里的双语阅读器。** 导入任意 EPUB，点击段落即可在原文和译文之间切换。没有分栏、没有弹窗——点一下就读。

🔗 **[在线体验 → ovid.ink](https://ovid.ink)**

[English](README.md) | 简体中文

## 功能

- **点击切换** — 点任意段落，原文 ↔ 译文即时切换
- **EPUB 导入** — 上传 EPUB，后台自动翻译
- **书架 UI** — 书脊、AI 生成封面、悬停预览——像一个真正的书架
- **阅读进度** — 自动记录阅读位置，云端同步
- **无限滚动** — 上下滑动自动加载上一章/下一章
- **多语言** — EN ↔ 中文、西语、法语、德语、日语、韩语、俄语
- **CJK 排版** — 霞鹜文楷屏幕阅读版，精调行高和字间距
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

**上传流程：** 上传 EPUB → Worker 解析并存入 D1 → webhook 通知 Railway → Railway 逐章翻译（Claude Sonnet via OpenRouter）并写回 D1。翻译完成后自动出现在书架上。

**阅读流程：** 点击段落 → 在原文和译文之间切换。基于 XPath 的映射保证段落级精确对齐。

## 快速开始

```bash
git clone https://github.com/GabrielDrapor/ovid.git && cd ovid
yarn install
cp wrangler.toml.example wrangler.toml   # 填入你的 D1 数据库 ID
npm run db:init                           # 建表
npm run preview                           # http://localhost:8787
```

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run preview` | 本地全栈开发（Worker + React，端口 8787） |
| `npm run deploy` | 构建 + 部署到 Cloudflare Workers |
| `npm test` | 单元测试（Vitest） |
| `npm run test:visual` | 视觉回归测试（Playwright） |
| `yarn import-book -- --file="book.epub" --target="zh"` | CLI 导入并翻译书籍 |
| `yarn list-books:local` / `remote` | 列出本地/线上书籍 |
| `yarn remove-book:local` / `remote -- --uuid="..."` | 删除书籍 |

## 项目结构

```
src/
  components/        React 组件 — BookShelf, BilingualReaderV2, ErrorBoundary
  worker/            CF Worker — 认证、书籍处理、封面生成、积分、数据库
  utils/             公共工具（翻译模块）
services/
  translator/        Railway 翻译服务（Hono + Sharp + D1 客户端）
scripts/             CLI 工具 — 导入、列表、删除、同步、生成封面
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
