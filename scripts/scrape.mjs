// 금오공대 식단/공지를 크롤링해서 data/*.json 으로 저장한다. (GitHub Actions에서 주기적으로 실행)
import { load } from 'cheerio';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://www.kumoh.ac.kr';
const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const DAYS = ['월', '화', '수', '목', '금', '토', '일'];

const RESTAURANTS = [
  { name: '일품식당', url: `${BASE}/ko/restaurant01.do` },
  { name: '정찬식당', url: `${BASE}/ko/restaurant02.do` },
];

const NOTICE_CATEGORIES = [
  { key: 'academic', url: `${BASE}/ko/sub06_01_01_01.do` },
  { key: 'event', url: `${BASE}/ko/sub06_01_01_02.do` },
  { key: 'news', url: `${BASE}/ko/sub06_01_01_03.do` },
];

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

async function fetchHtml(url, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kumoh-pwa-bot)', 'Accept-Language': 'ko' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length < 50) throw new Error('empty response');
      return text;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw new Error(`${url}: ${lastErr?.message}`);
}

// 내용(updatedAt 제외)이 바뀐 경우에만 파일을 쓴다 → 불필요한 커밋 방지
async function writeJsonIfChanged(file, obj) {
  const strip = (o) => JSON.stringify({ ...o, updatedAt: undefined });
  try {
    const prev = JSON.parse(await readFile(file, 'utf8'));
    if (strip(prev) === strip(obj)) return false;
  } catch {}
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(obj) + '\n', 'utf8');
  return true;
}

const exists = (f) => readFile(f).then(() => true, () => false);

// KST 기준 오늘 날짜 (YYYY-MM-DD)
function todayKst() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
}

// ===================== 식단 =====================
function parseWeekDates($) {
  const dates = {};
  $('table.smu-table thead th').each((idx, th) => {
    const m = clean($(th).text()).match(/\(([\d.]+)\)/);
    if (m && DAYS[idx]) dates[DAYS[idx]] = m[1];
  });
  return dates;
}

function parseRestaurantMenu($, hallName) {
  const byDay = {};
  $('table.smu-table tbody tr').each((_, tr) => {
    $(tr).find('td').each((idx, td) => {
      const $td = $(td);
      const meal = clean($td.find('p').first().text()) || '메뉴';
      let price = '';
      const items = [];
      $td.find('ul.s-dot li').each((_, li) => {
        const t = clean($(li).text());
        if (!t) return;
        if (/^\(?\d{1,2}:\d{2}\s*~\s*\d{1,2}:\d{2}\)?$/.test(t)) return; // 운영시간 표기 제외
        if (/^-{2,}$/.test(t)) return; // 구분선 제외
        const pm = t.match(/^\[(.+)\]$/);
        if (pm) { price = pm[1]; return; }
        items.push(t);
      });
      const day = DAYS[idx];
      if (!day) return;
      (byDay[day] ??= []).push({ hall: hallName, meal, items: items.length ? items : ['정보 없음'], price });
    });
  });
  return byDay;
}

async function scrapeMenu() {
  const srDt = todayKst();
  const results = await Promise.all(RESTAURANTS.map(async (r) => {
    const $ = load(await fetchHtml(`${r.url}?mode=menuList&srDt=${srDt}`));
    return { byDay: parseRestaurantMenu($, r.name), dates: parseWeekDates($) };
  }));

  const days = {};
  for (const d of DAYS) days[d] = results.flatMap((r) => r.byDay[d] ?? []);
  const dates = results.find((r) => Object.keys(r.dates).length)?.dates ?? {};

  if (!Object.values(days).some((l) => l.length)) throw new Error('menu: parsed nothing');
  const changed = await writeJsonIfChanged(path.join(DATA_DIR, 'menu.json'), {
    updatedAt: new Date().toISOString(),
    dates,
    days,
  });
  console.log(`menu: ${changed ? 'updated' : 'unchanged'}`);
}

// ===================== 공지 =====================
function parseNoticeList($) {
  const list = [];
  $('table tbody tr').each((_, tr) => {
    const link = $(tr).find('a[href*="mode=view"]').first();
    if (!link.length) return;
    const m = (link.attr('href') || '').match(/articleNo=(\d+)/);
    if (!m) return;

    let title;
    const tw = link.find('.title-wrapper').first();
    if (tw.length) {
      const c = tw.clone();
      c.find('.mobile-info, .mobile-icon-notice').remove();
      title = clean(c.text());
    } else {
      title = clean(link.attr('title') || link.text());
    }

    const spans = link.find('.mobile-info > span').filter((_, s) => $(s).attr('class') !== 'icon-bar');
    const at = (i) => clean($(spans[i]).text());
    list.push({
      articleNo: m[1],
      title,
      dept: at(0),
      date: at(1),
      hit: at(2),
      pinned: $(tr).find('.mobile-icon-notice').length > 0,
    });
  });
  return list;
}

const abs = (href, base) => { try { return new URL(href, base).href; } catch { return href; } };

function parseNoticeDetail($, detailUrl) {
  const title = clean($('.title-area h4').first().text()) || '제목 없음';
  let writer = '', hit = '', writeDate = '';
  $('.board-view-information dl').each((_, dl) => {
    const label = clean($(dl).find('dt').first().text());
    const value = clean($(dl).find('dd').first().text());
    if (label === '작성자') writer = value;
    else if (label === '조회') hit = value;
    else if (label === '작성일') writeDate = value;
  });

  const attachments = [];
  $('.attached-file-wrapper a.file-down-btn').each((_, a) => {
    attachments.push({ name: clean($(a).text()), href: abs($(a).attr('href') || '', detailUrl) });
  });

  const content = $('.board-contents').first();
  let contentHtml = '';
  if (content.length) {
    content.find('script, iframe, object, embed, style').remove();
    content.find('*').each((_, el) => {
      for (const name of Object.keys(el.attribs ?? {})) {
        if (/^on/i.test(name)) $(el).removeAttr(name);
      }
    });
    content.find('img[src]').each((_, el) => $(el).attr('src', abs($(el).attr('src'), detailUrl)));
    content.find('a[href]').each((_, el) => {
      const href = abs($(el).attr('href'), detailUrl);
      $(el).attr('href', /^\s*javascript:/i.test(href) ? '#' : href);
    });
    contentHtml = content.html() ?? '';
  }
  return { title, writer, writeDate, hit, attachments, contentHtml };
}

const BUCKET_SIZE = 5000;            // 글번호 5000개 단위로 파일을 나눈다 (새 글이 와도 기존 파일이 안 밀림)
const PAGE_LIMIT = 100;              // 학교 목록 한 페이지당 글 수
const MAX_PAGES = 400;
const DETAIL_PER_RUN = Number(process.env.DETAIL_PER_RUN || 200); // 1회 실행당 새로 받아올 본문 수 (최신 글부터)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function scrapeCategory(cat) {
  const dir = path.join(DATA_DIR, 'notices', cat.key);
  const index = await readJson(path.join(dir, 'index.json'));

  // 이미 저장된 목록 불러오기
  const known = new Map();
  for (const b of index?.buckets ?? []) {
    for (const it of (await readJson(path.join(dir, `b${b}.json`)))?.items ?? []) known.set(it.articleNo, it);
  }
  const wasComplete = !!index?.complete && known.size > 0;

  // 목록 크롤링: 처음(또는 이전에 끝까지 못 간 경우)엔 끝까지, 이후엔 아는 글이 나오면 중단
  let pinned = index?.pinned ?? [];
  let reachedEnd = false;
  let newCount = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${cat.url}?mode=list&articleLimit=${PAGE_LIMIT}&article.offset=${page * PAGE_LIMIT}`;
    const rows = parseNoticeList(load(await fetchHtml(url)));
    const normal = rows.filter((r) => !r.pinned);
    if (page === 0) pinned = rows.filter((r) => r.pinned).map(({ pinned: _p, ...r }) => r);
    if (normal.length === 0) { reachedEnd = true; break; }

    let pageNew = 0;
    for (const r of normal) {
      const { pinned: _p, ...item } = r;
      if (!known.has(item.articleNo)) { pageNew++; newCount++; }
      known.set(item.articleNo, item); // 조회수 등 최신값으로 갱신
    }
    if (wasComplete && pageNew === 0) break;
    await sleep(300);
  }
  for (const p of pinned) if (!known.has(p.articleNo)) known.set(p.articleNo, p);
  if (known.size === 0) throw new Error(`notice ${cat.key}: parsed nothing`);

  // 구간별 파일로 저장
  const buckets = new Map();
  for (const it of known.values()) {
    const b = Math.floor(Number(it.articleNo) / BUCKET_SIZE);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(it);
  }
  const bucketIds = [...buckets.keys()].sort((a, b) => b - a);
  for (const b of bucketIds) {
    const items = buckets.get(b).sort((x, y) => Number(y.articleNo) - Number(x.articleNo));
    await writeJsonIfChanged(path.join(dir, `b${b}.json`), { items });
  }
  await writeJsonIfChanged(path.join(dir, 'index.json'), {
    updatedAt: new Date().toISOString(),
    complete: wasComplete || reachedEnd,
    total: known.size,
    buckets: bucketIds,
    pinned,
  });

  // 본문: 아직 없는 글만, 최신 글부터 한 번에 DETAIL_PER_RUN개씩 (여러 번 실행되며 과거 글까지 채워짐)
  const sorted = [...known.values()].sort((x, y) => Number(y.articleNo) - Number(x.articleNo));
  let fetched = 0, remaining = 0;
  for (const it of sorted) {
    const file = path.join(dir, `${it.articleNo}.json`);
    if (await exists(file)) continue;
    if (fetched >= DETAIL_PER_RUN) { remaining++; continue; }
    const detailUrl = `${cat.url}?mode=view&articleNo=${it.articleNo}&article.offset=0&articleLimit=10`;
    try {
      const d = parseNoticeDetail(load(await fetchHtml(detailUrl)), detailUrl);
      await writeJsonIfChanged(file, { articleNo: it.articleNo, sourceUrl: detailUrl, ...d });
      fetched++;
    } catch (e) {
      console.warn(`detail ${cat.key}/${it.articleNo} failed: ${e.message}`);
      remaining++;
    }
    await sleep(150);
  }
  console.log(`notices ${cat.key}: total ${known.size}, new ${newCount}, details +${fetched}, details left ${remaining}, complete=${wasComplete || reachedEnd}`);
}

async function scrapeNotices() {
  let failed = null;
  for (const cat of NOTICE_CATEGORIES) {
    try { await scrapeCategory(cat); } catch (e) { failed = e; console.error(`notices ${cat.key} failed:`, e.message); }
  }
  if (failed) throw failed;
}
// 한쪽이 실패해도 다른 쪽은 저장되도록 개별 실행. 하나라도 실패하면 종료코드 1.
let failed = false;
for (const [name, fn] of [['menu', scrapeMenu], ['notices', scrapeNotices]]) {
  try { await fn(); } catch (e) { failed = true; console.error(`${name} failed:`, e.message); }
}
process.exit(failed ? 1 : 0);
