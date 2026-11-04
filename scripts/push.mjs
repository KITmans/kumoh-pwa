// scripts/push.mjs
// 새 학교 공지 / LMS 새 공지·과제를 확인해서 내 폰으로 웹 푸시를 보낸다.
// GitHub Actions(update-data.yml)에서 5분마다 실행된다.
//
// 필요한 Secrets (GitHub 저장소 Settings > Secrets and variables > Actions)
//   PUSH_SECRET  내가 정하는 긴 아무 글자(16자 이상). 이 글자로 푸시용 인증키를 자동으로 만든다 (직접 키 생성 불필요)
//   PUSH_SUB     앱의 "알림 > 이 기기 푸시 등록"에서 복사한 구독 정보
//   LMS_TOKEN    (선택) Canvas 액세스 토큰. 없으면 LMS 확인은 건너뜀
//
// 환경변수
//   DATA_DIR    크롤링 결과 폴더 (pub)        STATE_FILE  이미 알린 목록 파일
//   TEST_PUSH   true 면 테스트 알림 1건만 발송   DRY_RUN=1  발송 없이 로그만 출력
//   LMS_BASE    기본 https://canvas.kumoh.ac.kr

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import webpush from 'web-push';

const env = process.env;
const DATA_DIR = env.DATA_DIR || 'pub';
const STATE_FILE = env.STATE_FILE || 'push-state.json';
const DRY = env.DRY_RUN === '1';
const TEST = env.TEST_PUSH === 'true' || env.TEST_PUSH === '1';
const LMS_BASE = (env.LMS_BASE || 'https://canvas.kumoh.ac.kr').replace(/\/+$/, '');
const LMS_TOKEN = (env.LMS_TOKEN || '').trim();
const MAX_SEND = 5; // 한 번에 보내는 알림 최대 개수 (넘으면 마지막에 "그 외 N건"으로 묶음)

const CATS = [
  { key: 'academic', label: '학사안내' },
  { key: 'event', label: '행사안내' },
  { key: 'news', label: '일반소식' },
];

const warn = (m) => console.log(`::warning::${m}`);
const setOutput = (k, v) => {
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`);
};
const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};

function fmtKST(iso) {
  try {
    const parts = new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(iso));
    const g = (t) => parts.find((p) => p.type === t)?.value || '';
    return `${g('month')}월 ${g('day')}일 ${g('hour')}:${g('minute')}`;
  } catch { return ''; }
}

// ---------- 푸시 인증키 (PUSH_SECRET 에서 자동 생성) ----------
const b64u = (buf) => Buffer.from(buf).toString('base64url');
function deriveVapid(secret) {
  for (let i = 0; i < 10; i++) {
    const priv = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.from('kit-push-v1'), Buffer.from(`vapid-p256-${i}`), 32));
    try {
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.setPrivateKey(priv);
      return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(priv) };
    } catch { /* 드물게 유효하지 않은 값이면 다음 번호로 */ }
  }
  throw new Error('키 생성 실패');
}
// 공개키는 비밀이 아니므로 data 브랜치에 올려서 앱이 자동으로 받아가게 한다
function publishPublicKey(publicKey) {
  const file = path.join(DATA_DIR, 'push-key.json');
  const body = JSON.stringify({ publicKey });
  try { if (fs.readFileSync(file, 'utf8') === body) return; } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, body);
}

// ---------- 구독 정보 ----------
function loadSubs() {
  const raw = (env.PUSH_SUB || '').trim();
  if (!raw) return [];
  let j;
  try { j = JSON.parse(raw); } catch { warn('PUSH_SUB 이 올바른 JSON 이 아니에요. 앱에서 다시 복사해 붙여넣어 주세요.'); return []; }
  return (Array.isArray(j) ? j : [j]).filter(
    (s) => s && typeof s.endpoint === 'string' && s.keys && s.keys.p256dh && s.keys.auth,
  );
}

// ---------- 상태(이미 알린 것) ----------
let state = readJson(STATE_FILE) || {};
state.notices ||= {};
state.lms ||= {};
const stateBefore = JSON.stringify(state);

// ---------- 1) 학교 공지 ----------
// 구조: pub/notices/{분류}/index.json (buckets: 큰 번호부터) + b{구간}.json (items: 글번호 내림차순)
function checkNotices(events) {
  for (const { key, label } of CATS) {
    const idx = readJson(path.join(DATA_DIR, 'notices', key, 'index.json'));
    const bucket = idx?.buckets?.[0];
    if (bucket == null) continue;
    const items = readJson(path.join(DATA_DIR, 'notices', key, `b${bucket}.json`))?.items || [];
    const nums = items.map((n) => Number(n.articleNo)).filter(Number.isFinite);
    if (!nums.length) continue;
    const max = Math.max(...nums);
    const last = state.notices[key];
    if (last == null) { state.notices[key] = max; continue; } // 처음 실행: 기준만 저장 (알림 폭탄 방지)
    items
      .filter((n) => Number(n.articleNo) > last)
      .sort((a, b) => Number(a.articleNo) - Number(b.articleNo))
      .forEach((n) => events.push({
        kind: `notice:${key}`,
        title: `[${label}] 새 공지`,
        body: n.title || '(제목 없음)',
        tag: `notice-${key}-${n.articleNo}`,
      }));
    if (max > last) state.notices[key] = max;
  }
}

// ---------- 2) LMS (Canvas) ----------
async function lmsAll(p, maxPages = 3) {
  const origin = new URL(LMS_BASE).origin;
  let url = LMS_BASE + p;
  let out = [];
  for (let i = 0; i < maxPages && url; i++) {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${LMS_TOKEN}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 401) throw Object.assign(new Error('AUTH'), { auth: true });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${p.split('?')[0]}`);
    const j = await res.json();
    out = out.concat(Array.isArray(j) ? j : [j]);
    const m = (res.headers.get('link') || '').match(/<([^>]+)>;\s*rel="next"/);
    // 토큰이 다른 주소로 새지 않도록 같은 사이트의 다음 페이지만 따라간다
    url = m && new URL(m[1]).origin === origin ? m[1] : null;
  }
  return out;
}

async function checkLms(events) {
  if (!LMS_TOKEN) return;
  const lms = state.lms;
  const courses = (await lmsAll('/api/v1/courses?enrollment_state=active&per_page=50')).filter((c) => c && c.id && c.name);
  const nameOf = Object.fromEntries(courses.map((c) => [String(c.id), c.name]));
  const known = (lms.courses ||= {});
  const knownBefore = { ...known }; // 이번에 처음 보는 과목은 기준만 저장 (기존 과제가 한꺼번에 울리지 않게)
  const firstRun = !lms.inited;
  const seenAnn = new Set(lms.ann || []);
  const seenAsg = new Set(lms.asg || []);

  // 새 과목 공지 (최근 30일)
  if (courses.length) {
    try {
      const ctx = courses.slice(0, 20).map((c) => `context_codes[]=course_${c.id}`).join('&');
      const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      const anns = await lmsAll(`/api/v1/announcements?${ctx}&start_date=${since}&per_page=50`, 2);
      for (const a of anns) {
        const cid = String(a.context_code || '').replace('course_', '');
        if (!cid || a.id == null) continue;
        const k = `${cid}|${a.id}`;
        if (seenAnn.has(k)) continue;
        seenAnn.add(k);
        if (!firstRun && knownBefore[cid]) {
          events.push({ kind: 'lmsAnn', title: `[LMS 새 공지] ${nameOf[cid] || '과목'}`, body: a.title || '(제목 없음)', tag: `lms-ann-${cid}-${a.id}` });
        }
      }
    } catch (e) {
      if (e.auth) throw e;
      warn(`LMS 공지 조회 실패: ${e.message}`);
    }
  }

  // 새 과제
  for (const c of courses) {
    const cid = String(c.id);
    try {
      const asgs = await lmsAll(`/api/v1/courses/${c.id}/assignments?per_page=50`, 2);
      for (const a of asgs) {
        if (a.id == null) continue;
        const k = `${cid}|${a.id}`;
        if (seenAsg.has(k)) continue;
        seenAsg.add(k);
        if (!firstRun && knownBefore[cid]) {
          const due = a.due_at ? ` · 마감 ${fmtKST(a.due_at)}` : '';
          events.push({ kind: 'lmsAsg', title: `[LMS 새 과제] ${c.name}`, body: `${a.name || '과제'}${due}`, tag: `lms-asg-${cid}-${a.id}` });
        }
      }
      known[cid] = 1;
    } catch (e) {
      if (e.auth) throw e;
      warn(`LMS 과제 조회 실패 (과목 ID ${cid}): ${e.message}`); // 공개 저장소 로그에 과목명이 남지 않게 ID만 출력
    }
  }

  lms.inited = true;
  lms.ann = [...seenAnn].slice(-1000);
  lms.asg = [...seenAsg].slice(-1000);
}

// ---------- 발송 ----------
// 방해금지 시간(한국 시간). prefs.quiet = { on, start:'23:00', end:'07:00' }, 자정을 넘겨도 된다.
function nowKstMin() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const g = (t) => Number(parts.find((p) => p.type === t)?.value);
  return (g('hour') % 24) * 60 + g('minute');
}
const toMin = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
function inQuiet(sub) {
  const q = sub.prefs?.quiet;
  if (!q || !q.on) return false;
  const s = toMin(q.start), e = toMin(q.end);
  if (s == null || e == null || s === e) return false;
  const n = nowKstMin();
  return s < e ? (n >= s && n < e) : (n >= s || n < e);
}

// 앱의 알림 설정(prefs)이 구독 정보에 같이 들어있다. 없으면 전부 받는다.
function wants(sub, kind = '') {
  const p = sub.prefs;
  if (!p || typeof p !== 'object') return true;
  if (kind.startsWith('notice:')) return p.notice?.[kind.slice(7)] !== false;
  if (kind === 'lmsAnn') return p.lmsAnn !== false;
  if (kind === 'lmsAsg') return p.lmsAsg !== false;
  return true;
}

async function sendAll(subs, events) {
  let ok = 0;
  let attempted = 0;
  const dead = new Set();
  for (const sub of subs) {
    const mine = events.filter((e) => wants(sub, e.kind));
    const list = mine.length > MAX_SEND
      ? [...mine.slice(0, MAX_SEND - 1), { title: '새 소식', body: `그 외 ${mine.length - (MAX_SEND - 1)}건이 더 있어요`, tag: `more-${Date.now()}` }]
      : mine;
    const target = { endpoint: sub.endpoint, keys: sub.keys };
    for (const ev of list) {
      attempted++;
      const payload = JSON.stringify({ title: ev.title, body: ev.body, tag: ev.tag, url: './' });
      try {
        await webpush.sendNotification(target, payload, { TTL: 60 * 60 * 24, urgency: 'normal' });
        ok++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) dead.add(sub.endpoint);
        else warn(`푸시 발송 실패 (${e.statusCode || ''}) ${String(e.body || e.message).slice(0, 200)}${e.statusCode === 403 ? ' — 앱에서 "다시 등록"한 뒤 PUSH_SUB 를 갱신하거나, PUSH_SECRET 이 바뀌지 않았는지 확인하세요' : ''}`);
      }
    }
  }
  return { ok, attempted, dead: [...dead] };
}

// ---------- 실행 ----------
const subs = loadSubs();
const secret = (env.PUSH_SECRET || '').trim();
let vapid = null;
if (secret.length >= 16) {
  vapid = deriveVapid(secret);
  publishPublicKey(vapid.publicKey);           // 앱이 이 파일에서 공개키를 가져감
} else if (!DRY) {
  warn('PUSH_SECRET 시크릿이 없거나 너무 짧아요. 16자 이상 아무 글자로 저장해 주세요.');
  setOutput('changed', 'false');
  process.exit(0);
}
if (!DRY) {
  if (!subs.length) {
    warn('아직 PUSH_SUB 시크릿이 없어요. 앱의 알림 탭에서 기기를 등록하고, 복사한 내용을 PUSH_SUB 로 저장하세요.');
    setOutput('changed', 'false');
    process.exit(0);
  }
  webpush.setVapidDetails(
    env.VAPID_SUBJECT || (env.GITHUB_REPOSITORY ? `https://github.com/${env.GITHUB_REPOSITORY}` : 'mailto:admin@example.com'),
    vapid.publicKey,
    vapid.privateKey,
  );
}

// 모든 기기가 방해금지 시간이면 아무것도 확인/저장하지 않고 끝낸다.
// 상태를 갱신하지 않으므로, 시간이 끝난 첫 실행에서 그동안 쌓인 새 소식이 한꺼번에 발송된다.
if (!DRY && !TEST && subs.length && subs.every(inQuiet)) {
  console.log('방해금지 시간이라 이번 실행은 건너뛰어요 (끝나면 쌓인 소식을 알려드려요)');
  setOutput('changed', 'false');
  process.exit(0);
}

const events = [];
if (TEST) {
  events.push({ title: '테스트 알림', body: '푸시가 정상적으로 연결됐어요.', tag: `kit-test-${Date.now()}` });
} else {
  // 새 기기를 등록한 뒤 처음 실행되면 "연결 완료" 알림을 한 번 보낸다 (설정이 잘 됐는지 확인용)
  const subFp = crypto.createHash('sha256').update(env.PUSH_SUB || '').digest('hex').slice(0, 12);
  if (state.subFp !== subFp) {
    state.subFp = subFp;
    events.push({ title: '푸시 연결 완료', body: '이제 앱을 꺼도 새 공지와 LMS 소식을 알려드려요.', tag: 'kit-connected' });
  }
  checkNotices(events);
  try {
    await checkLms(events);
  } catch (e) {
    if (e.auth) {
      warn('LMS 토큰이 만료됐거나 올바르지 않아요. Canvas에서 새 토큰을 만들어 LMS_TOKEN 시크릿을 갱신하세요.');
      const last = state.lms.authWarnAt || 0;
      if (Date.now() - last > 24 * 3600 * 1000) { // 하루에 한 번만 폰으로도 알려줌
        state.lms.authWarnAt = Date.now();
        events.push({ title: 'LMS 토큰 확인 필요', body: '토큰이 만료된 것 같아요. 새 토큰으로 LMS_TOKEN 을 갱신해 주세요.', tag: 'lms-auth' });
      }
    } else {
      warn(`LMS 확인 실패: ${e.message}`);
    }
  }
}

let sendOk = 0;
let attempted = 0;
if (events.length) {
  if (DRY) {
    console.log(JSON.stringify(events, null, 2));
  } else {
    const r = await sendAll(subs, events);
    sendOk = r.ok;
    attempted = r.attempted;
    console.log(`알림 ${events.length}건 · 발송 시도 ${r.attempted}회 · 성공 ${r.ok}회`);
    if (r.dead.length) warn('푸시 구독이 만료됐어요. 앱에서 "다시 등록" 후 PUSH_SUB 시크릿을 갱신해 주세요.');
  }
} else {
  console.log('새 소식 없음');
}

// 발송에 모두 실패했다면 "알린 것"으로 처리하지 않고 다음 실행에서 다시 시도한다
// (앱 설정으로 전부 걸러져 보낼 게 없었던 경우도 "알린 것"으로 본다)
const advance = TEST ? false : DRY ? true : (attempted === 0 || sendOk > 0);
if (advance && JSON.stringify(state) !== stateBefore) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  setOutput('changed', 'true');
} else {
  setOutput('changed', 'false');
}
