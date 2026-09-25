// 旅程の保存と、天気・場所の取得。
//
// サーバーは使わない。旅程はブラウザの localStorage に入る。
// 天気は Open-Meteo（登録もキーも要らない）、場所は OpenStreetMap の Nominatim。
// どちらも CORS が開いているのでブラウザから直接呼べる。

const KEY = new URLSearchParams(location.search).get('private') === '1'
  ? 'tavimaps.private.v1'
  : 'tavimaps.v1';
const EMPTY = { trips: [], activeId: null, deleted: [] };

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(EMPTY);
    return { ...structuredClone(EMPTY), ...JSON.parse(raw) };
  } catch { return structuredClone(EMPTY); }
}
function write(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); }
  catch (e) { console.warn('保存できませんでした', e); }
}

export const store = {
  get: read,
  set(next) { write(next); return next; },
  update(fn) { const s = read(); fn(s); write(s); return s; },
  reset() { write(structuredClone(EMPTY)); },
};

export const uid = () => 'x' + Math.random().toString(36).slice(2, 10);

// MARK: - 旅程を作る

export function makeTrip({ title, start, end }) {
  const name = (title ?? '').trim();
  if (!name) return null;
  const from = new Date(start + 'T00:00:00');
  const to = new Date(end + 'T00:00:00');
  if (isNaN(from) || isNaN(to)) return null;
  const span = Math.round((to - from) / 86400000);
  if (span < 0 || span > 60) return null;

  const days = [];
  for (let i = 0; i <= span; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    days.push({ id: 'day-' + iso(d), date: iso(d), title: `${i + 1}日目`, stops: [], note: '' });
  }
  return { id: uid(), title: name, days };
}

export const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// MARK: - 場所（OpenStreetMap / Nominatim）
//
// 見つけたものは「自動でついた場所」として入れ、人が確定したものとは分ける。
// 地名検索は同名の別施設を返すことがあり、両方が同じ見た目だと間違いに気づけない。

export async function searchPlaces(query, near) {
  const q = (query ?? '').trim();
  if (!q) return [];
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '8');
  url.searchParams.set('accept-language', 'ja');
  if (near) {
    // 近くを優先する。広げると別県の同名施設を拾いやすくなる。
    const d = 0.6;
    url.searchParams.set('viewbox',
      [near.lon - d, near.lat + d, near.lon + d, near.lat - d].join(','));
  }
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('検索できませんでした');
  const rows = await res.json();
  return rows.map((r) => ({
    name: r.name || r.display_name.split(',')[0],
    address: r.display_name,
    lat: Number(r.lat),
    lon: Number(r.lon),
  }));
}

// MARK: - 天気（Open-Meteo）
//
// 無料・登録なし・キーなし。ただし**ここだけは外と通信する**。
// 渡すのは地点の緯度経度だけで、旅程の中身は送らない。

export async function fetchWeather(lat, lon, dateISO) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lat.toFixed(4));
  url.searchParams.set('longitude', lon.toFixed(4));
  url.searchParams.set('hourly', 'temperature_2m,precipitation,weather_code');
  url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '7');
  const res = await fetch(url);
  if (!res.ok) throw new Error('天気を取れませんでした');
  const data = await res.json();

  let day = null;
  if (dateISO && data.daily?.time) {
    const i = data.daily.time.indexOf(dateISO);
    if (i >= 0) {
      day = {
        date: dateISO,
        max: data.daily.temperature_2m_max[i],
        min: data.daily.temperature_2m_min[i],
        rain: data.daily.precipitation_probability_max[i],
        code: data.daily.weather_code[i],
      };
    }
  }
  return { raw: data, day };
}

// 予報の絵文字。天気アイコンだけのために画像を足したくない。
export function weatherFace(code) {
  if (code === 0) return '☀️';
  if (code <= 2) return '🌤';
  if (code === 3) return '☁️';
  if (code <= 48) return '🌫';
  if (code <= 67) return '🌧';
  if (code <= 77) return '🌨';
  if (code <= 82) return '🌦';
  if (code <= 86) return '🌨';
  return '⛈';
}

export function weatherWord(code) {
  if (code === 0) return '快晴';
  if (code <= 2) return '晴れ時々くもり';
  if (code === 3) return 'くもり';
  if (code <= 48) return '霧';
  if (code <= 67) return '雨';
  if (code <= 77) return '雪';
  if (code <= 82) return 'にわか雨';
  if (code <= 86) return 'にわか雪';
  return '雷雨';
}

// MARK: - 判断
//
// 「で、結局いつ出ればいいのか」だけを出す。単純な引き算。
// 移動時間は道路の形も渋滞も見ていないので、余裕を多めに取る。

export const BUFFER_MINUTES = 30;

export function departureAdvice({ deadlineISO, travelMinutes, weatherRain, now = new Date() }) {
  if (!deadlineISO) return null;
  const deadline = new Date(deadlineISO);
  if (isNaN(deadline)) return null;

  let buffer = BUFFER_MINUTES;
  // 雨の予報があれば、さらに足す。濡れると人は遅くなる。
  if (typeof weatherRain === 'number' && weatherRain >= 50) buffer += 15;

  const leaveAt = new Date(deadline.getTime() - (travelMinutes + buffer) * 60000);
  const leftMs = leaveAt - now;
  const leftMin = Math.floor(leftMs / 60000);

  let level = 'ok';
  if (leftMin < 0) level = 'late';
  else if (leftMin <= 15) level = 'soon';

  return { leaveAt, leftMin, level, buffer, travelMinutes };
}

export function hhmmOf(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function humanLeft(minutes) {
  if (minutes < 0) return `${Math.abs(minutes)}分 過ぎています`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `あと ${h}時間${String(m).padStart(2, '0')}分` : `あと ${m}分`;
}

/** 大圏距離(km)。粗い把握にだけ使う。 */
export function distanceKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
