// TAGO(국토교통부) 버스도착정보를 읽어 bus.json 으로 저장한다. (GitHub Actions에서 5분마다 실행)
// 필요한 것: GitHub Secret 'TAGO_API_KEY' (공공데이터포털 인증키)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const OUT = path.join(DATA_DIR, 'bus.json');
const API = 'https://apis.data.go.kr/1613000';
const MAX_ARRIVALS = 8;

const config = JSON.parse(await readFile(path.resolve('config/bus.json'), 'utf8'));
const rawKey = (process.env.TAGO_API_KEY || '').trim();

async function save(obj) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), ...obj }) + '\n', 'utf8');
}

if (!rawKey) {
  console.warn('TAGO_API_KEY 가 없어서 교통정보를 건너뜁니다.');
  await save({ message: '교통정보를 준비하고 있어요. (API 키 설정 필요)', groups: [] });
  process.exit(0);
}
// 포털에서 복사한 키가 인코딩(%2B 등)된 것이든 아니든 동작하도록 한 번 풀어서 다시 인코딩한다.
const key = rawKey.includes('%') ? decodeURIComponent(rawKey) : rawKey;

async function call(service, op, params) {
  const qs = new URLSearchParams({ _type: 'json', pageNo: '1', ...params }).toString();
  const url = `${API}/${service}/${op}?serviceKey=${encodeURIComponent(key)}&${qs}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`${op}: JSON이 아닌 응답 (키/신청 상태 확인) ${text.slice(0, 200)}`); }
  const header = json?.response?.header;
  if (header && header.resultCode !== '00') throw new Error(`${op}: ${header.resultCode} ${header.resultMsg}`);
  const item = json?.response?.body?.items?.item;
  if (!item) return [];
  return Array.isArray(item) ? item : [item];
}

const arrivalsOf = (nodeId) => call('ArvlInfoInqireService', 'getSttnAcctoArvlPrearngeInfoList',
  { cityCode: config.cityCode, nodeId, numOfRows: '50' });

const toArrival = (x) => ({
  routeNo: String(x.routeno),
  routeType: x.routetp || '',
  sec: Number(x.arrtime),
  stopsLeft: x.arrprevstationcnt != null ? Number(x.arrprevstationcnt) : null,
});

async function buildGroup(title, nodeIds) {
  const all = [];
  let stopName = '', stopNo = '';
  for (const id of nodeIds) {
    const items = await arrivalsOf(id);
    for (const x of items) {
      stopName ||= x.nodenm || '';
      all.push(toArrival(x));
    }
  }
  all.sort((a, b) => a.sec - b.sec);
  return { title, stopName, stopNo, arrivals: all.slice(0, MAX_ARRIVALS) };
}

const configured = config.groups.filter((g) => g.nodeIds?.length);
let groups = [];

if (configured.length) {
  for (const g of configured) groups.push(await buildGroup(g.title, g.nodeIds));
} else {
  // 아직 정류장 ID를 지정하지 않았다면: 이름으로 정류장을 찾아서 전부 보여준다. (로그에 ID가 출력됨)
  const stops = await call('BusSttnInfoInqireService', 'getSttnNoList',
    { cityCode: config.cityCode, nodeNm: config.searchKeyword, numOfRows: '50' });
  console.log('--- 찾은 정류장 (config/bus.json 의 nodeIds 에 넣을 값은 nodeid) ---');
  for (const s of stops) console.log(`${s.nodenm} | 번호 ${s.nodeno} | nodeid ${s.nodeid}`);
  for (const s of stops) {
    const g = await buildGroup(s.nodenm, [s.nodeid]);
    g.stopNo = String(s.nodeno ?? '');
    g.stopName = '';
    groups.push(g);
  }
  if (!groups.length) groups = [];
}

await save({ groups, message: groups.length ? '' : '금오공대 정류장을 찾지 못했어요.' });
console.log(`bus: ${groups.length} groups saved`);
