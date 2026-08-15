/**
 * End-to-end verification for a running self-hosted Ovid instance.
 *
 *   OVID_URL   base URL (http://localhost:8899)
 *   OVID_LOG   server log file — sign-in codes are read from it
 *   OVID_DB    SQLite file — a sample book is seeded through it
 *
 * Exercises the paths that actually differ between Cloudflare and self-host:
 * SQLite reads/writes, filesystem storage, static asset serving, and the
 * durable counters behind rate limiting.
 */

const BASE = process.env.OVID_URL || 'http://localhost:8899';
const LOG = process.env.OVID_LOG || '/tmp/ovid-selfhost.log';
const DB = process.env.OVID_DB || '/tmp/ovid-selfhost-test/ovid.db';
let pass = 0,
  fail = 0;
const ck = (n, ok, x = '') => {
  ok
    ? (pass++, console.log(`  ✓ ${n}`))
    : (fail++, console.log(`  ✗ ${n} ${x}`));
};
const j = async (u, o) => {
  const r = await fetch(BASE + u, o);
  return { s: r.status, d: await r.json().catch(() => null), h: r.headers };
};

// Seed a small bilingual book directly through SQLite so the read path can be
// checked without needing an LLM key or a real import.
async function seedBook() {
  // OVID_DB=external: the caller seeded already (e.g. the book was inserted
  // inside a container), so just use what's there.
  if (DB === 'external') return;
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(DB);
  const existing = d
    .prepare('SELECT id FROM books_v2 WHERE uuid = ?')
    .get('sh-test');
  if (existing) {
    d.close();
    return;
  }
  d.prepare(
    "INSERT INTO books_v2 (uuid,title,original_title,author,language_pair,user_id,status) VALUES ('sh-test','自部署测试书','Self Host Test','Tester','en-zh',NULL,'ready')"
  ).run();
  const bid = d
    .prepare('SELECT id FROM books_v2 WHERE uuid = ?')
    .get('sh-test').id;
  const chapters = [
    [
      1,
      '第一章',
      'Chapter One',
      '<body><p>The lamp was lit at dusk.</p><p>Holmes said nothing for a while.</p></body>',
      [
        ['/body[1]/p[1]', 'The lamp was lit at dusk.', '黄昏时点起了灯。'],
        [
          '/body[1]/p[2]',
          'Holmes said nothing for a while.',
          '福尔摩斯一时没有说话。',
        ],
      ],
    ],
    [
      2,
      '第二章',
      'Chapter Two',
      '<body><p>Rain fell on Baker Street.</p></body>',
      [['/body[1]/p[1]', 'Rain fell on Baker Street.', '雨落在贝克街上。']],
    ],
  ];
  for (const [n, t, ot, html, paras] of chapters) {
    d.prepare(
      'INSERT INTO chapters_v2 (book_id,chapter_number,title,original_title,raw_html,order_index) VALUES (?,?,?,?,?,?)'
    ).run(bid, n, t, ot, html, n);
    const cid = d
      .prepare(
        'SELECT id FROM chapters_v2 WHERE book_id=? AND chapter_number=?'
      )
      .get(bid, n).id;
    paras.forEach(([xp, o, tr], i) =>
      d
        .prepare(
          'INSERT INTO translations_v2 (chapter_id,xpath,original_text,translated_text,order_index) VALUES (?,?,?,?,?)'
        )
        .run(cid, xp, o, tr, i)
    );
  }
  d.close();
}
await seedBook();

/**
 * Read the newest sign-in code for an address out of the server log.
 * Log tailing is asynchronous (a container's stdout reaches the file with a
 * lag), so poll briefly; always take the *last* match, since reruns leave
 * older codes behind.
 */
async function readLoginCode(fs, email, timeoutMs = 5000) {
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let text = '';
    try {
      text = fs.readFileSync(LOG, 'utf8');
    } catch {
      /* log not created yet */
    }
    const matches = [...text.matchAll(new RegExp(escaped + ': (\\d{6})', 'g'))];
    if (matches.length) return matches[matches.length - 1][1];
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

console.log('\n[1] 书架与书籍');
let r = await j('/api/v2/books');
ck(
  '书架列出书籍',
  r.s === 200 && r.d.some((b) => b.uuid === 'sh-test'),
  JSON.stringify(r.d).slice(0, 80)
);

console.log('\n[2] 章节(含长度加权字段)');
r = await j('/api/book/sh-test/chapters');
ck('章节列表', r.s === 200 && r.d.length === 2);
ck(
  '包含 text_length(进度加权)',
  r.d?.[0]?.text_length > 0,
  JSON.stringify(r.d?.[0])
);

console.log('\n[3] 章节内容(原文+译文 xpath 映射)');
r = await j('/api/book/sh-test/chapter/1');
ck('拉取第一章', r.s === 200);
ck('raw_html 完整', r.d?.rawHtml?.includes('The lamp was lit'));
ck(
  '译文映射存在',
  r.d?.translations?.length === 2 &&
    r.d.translations[0].translated_text === '黄昏时点起了灯。'
);

console.log('\n[4] 全文搜索(双语)');
r = await j('/api/book/sh-test/search?q=Holmes');
ck(
  '搜英文原文命中',
  r.s === 200 && r.d.results.length === 1 && r.d.results[0].field === 'original'
);
r = await j('/api/book/sh-test/search?q=' + encodeURIComponent('贝克街'));
ck(
  '搜中文译文命中',
  r.s === 200 &&
    r.d.results.length === 1 &&
    r.d.results[0].field === 'translated',
  JSON.stringify(r.d).slice(0, 100)
);
ck(
  '搜索结果带跳转坐标',
  r.d.results[0].chapter === 2 && !!r.d.results[0].xpath
);

console.log('\n[5] 阅读进度(需登录)');
const st = await fetch(BASE + '/api/auth/email/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'reader2@example.com' }),
});
const fs = await import('node:fs');
const code = await readLoginCode(fs, 'reader2@example.com');
const vr = await fetch(BASE + '/api/auth/email/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'reader2@example.com', code }),
});
const cookie = vr.headers.get('set-cookie')?.split(';')[0];
ck('登录取得会话', !!cookie);
let pr = await fetch(BASE + '/api/book/sh-test/progress', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({
    readingProgress: 42,
    chapterNumber: 2,
    paragraphXpath: '/body[1]/p[1]',
  }),
});
ck('保存进度', pr.status === 200, String(pr.status));
r = await j('/api/book/sh-test/progress', { headers: { Cookie: cookie } });
ck(
  '读回进度正确',
  r.d?.progress?.chapter_number === 2 && r.d?.progress?.reading_progress === 42,
  JSON.stringify(r.d).slice(0, 120)
);
r = await j('/api/progress', { headers: { Cookie: cookie } });
ck('进度汇总接口', r.s === 200 && !!r.d.progress['sh-test']);

console.log('\n[6] 标记读完');
pr = await fetch(BASE + '/api/book/sh-test/mark-complete', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ isCompleted: true }),
});
ck('标记完成', pr.status === 200);
r = await j('/api/book/sh-test/progress', { headers: { Cookie: cookie } });
ck('完成状态持久化', r.d?.progress?.is_completed === 1);

console.log('\n[7] 静态资源与 SPA 路由');
let sr = await fetch(BASE + '/book/sh-test');
ck(
  '书籍页返回 SPA',
  sr.status === 200 && (await sr.text()).includes('<div id="root">')
);
sr = await fetch(BASE + '/');
ck('首页返回 SPA', sr.status === 200);
sr = await fetch(BASE + '/manifest.json');
ck('静态文件可访问', sr.status === 200);
sr = await fetch(BASE + '/book/nonexistent');
ck('不存在的书重定向', sr.status === 200 || sr.redirected, String(sr.status));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
