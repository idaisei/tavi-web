import {
  store, uid, makeTrip, iso, searchPlaces, fetchWeather, weatherFace, weatherWord,
  departureAdvice, hhmmOf, humanLeft, distanceKm,
} from './trip.js';
import { isSyncConfigured, syncRequest } from '../assets/sync.js';

const $ = (id) => document.getElementById(id);
let state = normalizeState(store.get());
let map = null, marker = null, picking = null;
let syncTimer = null;
let syncRunning = false;

const activeTrip = () => state.trips.find((t) => t.id === state.activeId) ?? state.trips[0] ?? null;
const save = () => {
  const trip = activeTrip();
  if (trip) trip.updatedAt = Date.now();
  store.set(state);
  if (trip) scheduleTripUpload(trip);
};

function normalizeState(raw) {
  const next = raw ?? {};
  next.trips ??= [];
  next.deleted ??= [];
  next.activeId ??= null;
  next.trips.forEach((trip) => { trip.updatedAt ||= 0; });
  return next;
}

function scheduleTripUpload(trip) {
  if (!isSyncConfigured()) return;
  clearTimeout(syncTimer);
  const snapshot = structuredClone(trip);
  syncTimer = setTimeout(() => { void pushTrip(snapshot); }, 1200);
}

async function pushTrip(trip) {
  try {
    await syncRequest(`/tavi/trips/${encodeURIComponent(trip.id)}`, { method: 'PUT', body: trip });
    setSyncStatus('Notionに保存しました');
  } catch (error) {
    setSyncStatus(`${error.message}。端末には保存済みです`);
  }
}

function setSyncStatus(message) { $('syncStatus').textContent = message; }

async function syncTrips({ quiet = false } = {}) {
  if (syncRunning || !isSyncConfigured()) return;
  syncRunning = true;
  if (!quiet) setSyncStatus('同期しています…');
  try {
    const remote = await syncRequest('/tavi/trips');
    const remoteItems = Array.isArray(remote.items) ? remote.items : [];
    const localItems = [...state.trips, ...state.deleted.map((item) => ({ ...item, deleted: true }))];
    const localById = new Map(localItems.map((item) => [item.id, item]));
    const remoteById = new Map(remoteItems.filter((item) => item?.id).map((item) => [item.id, item]));
    const ids = new Set([...localById.keys(), ...remoteById.keys()]);
    const mergedTrips = [];
    const mergedDeleted = [];

    for (const id of ids) {
      const local = localById.get(id);
      const other = remoteById.get(id);
      const winner = !other || Number(local?.updatedAt || 0) > Number(other.updatedAt || 0) ? local : other;
      if (!winner) continue;
      if (winner.deleted) mergedDeleted.push({ id, updatedAt: winner.updatedAt });
      else mergedTrips.push(winner);
      if (local && (!other || Number(local.updatedAt || 0) > Number(other.updatedAt || 0))) {
        const method = local.deleted ? 'DELETE' : 'PUT';
        await syncRequest(`/tavi/trips/${encodeURIComponent(id)}`, { method, body: local });
      }
    }

    state.trips = mergedTrips;
    state.deleted = mergedDeleted;
    if (!state.trips.some((trip) => trip.id === state.activeId)) state.activeId = state.trips[0]?.id ?? null;
    store.set(state);
    renderAll();
    setSyncStatus(`同期済み（${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}）`);
  } catch (error) {
    setSyncStatus(error.message);
  } finally {
    syncRunning = false;
  }
}

// MARK: - サンプル（公開用。実在の宿名・決済額は入れない）

function sampleTrip() {
  const today = new Date();
  const d0 = iso(today);
  const t1 = new Date(today); t1.setDate(t1.getDate() + 1);
  const trip = makeTrip({ title: '海沿いの2日間（サンプル）', start: d0, end: iso(t1) });
  trip.days[0].stops = [
    { id: uid(), name: '港（到着）', at: '09:10', lat: 33.4256, lon: 132.0947, source: 'sample' },
    { id: uid(), name: '海沿いの道の駅', at: '10:00', lat: 33.4630, lon: 132.4230, source: 'sample' },
    { id: uid(), name: '海の見える駅', at: '11:40', lat: 33.6160, lon: 132.6220, source: 'sample' },
  ];
  trip.days[0].note = '屋外が多い日。雨なら順番を入れ替える。';
  trip.days[1].stops = [
    { id: uid(), name: '温泉街', at: '10:00', lat: 33.8520, lon: 132.7860, source: 'sample' },
    { id: uid(), name: '駅（出発）', at: '18:30', lat: 33.8390, lon: 132.7650, source: 'sample' },
  ];
  // 最終日の出発を締切にする。ここが「で、結局いつ出ればいいのか」の的。
  trip.days[1].deadline = { label: '特急 出発', atISO: `${trip.days[1].date}T18:30:00` };
  return trip;
}

// MARK: - 判断

function firstKnown(trip) {
  for (const d of trip.days) for (const s of d.stops) if (s.lat != null) return { lat: s.lat, lon: s.lon };
  return null;
}

function nextDeadline(trip, now = new Date()) {
  for (const d of trip.days) {
    if (!d.deadline?.atISO) continue;
    const at = new Date(d.deadline.atISO);
    if (at > now) return { day: d, deadline: d.deadline, at };
  }
  return null;
}

/** ざっくりの移動時間。道の形も渋滞も見ていないので、余裕を多めに取る前提。 */
function travelMinutesTo(from, target) {
  if (!from || !target) return 25;
  const km = distanceKm(from, target);
  return Math.max(10, Math.round((km / 35) * 60)); // 平均35km/h の粗い当て
}

/** どこから出るのか。現在地が取れていればそれ、無ければ締切の日のひとつ前の立ち寄り。 */
function originFor(trip, day) {
  if (myLocation) return myLocation;
  const known = day.stops.filter((s) => s.lat != null);
  // 最後の立ち寄り＝締切の場所なので、そのひとつ前から測る。
  if (known.length >= 2) return { lat: known.at(-2).lat, lon: known.at(-2).lon };
  return firstKnown(trip);
}

let lastRain = null;
let myLocation = null;

/** 現在地。押されたときだけ聞く。勝手に聞かない。 */
function askLocation() {
  if (!navigator.geolocation) { $('locLine').textContent = 'この端末では現在地を取れません。'; return; }
  $('locLine').textContent = '現在地を聞いています…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      myLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      $('locLine').textContent = '現在地から逆算しています。';
      renderVerdict();
      renderWeather();
    },
    () => { $('locLine').textContent = '現在地を取れませんでした。旅程の地点から逆算します。'; },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 });
}

function renderVerdict() {
  const trip = activeTrip();
  const card = $('verdict');
  card.className = 'card verdict';
  if (!trip) {
    $('verdictLabel').textContent = '次の締切';
    $('verdictHead').textContent = '旅程がまだありません';
    $('verdictSub').textContent = '「旅行」から作るか、サンプルを読み込んでください。';
    return;
  }
  $('tripTitle').textContent = trip.title;

  const next = nextDeadline(trip);
  if (!next) {
    $('verdictLabel').textContent = 'この旅程';
    $('verdictHead').textContent = `${trip.days.length}日間・${trip.days.reduce((n, d) => n + d.stops.length, 0)}か所`;
    $('verdictSub').textContent = '出発の締切はまだ入っていません。日のカードから足せます。';
    return;
  }

  const known = next.day.stops.filter((s) => s.lat != null);
  const lastStop = known.at(-1);
  const minutes = travelMinutesTo(
    originFor(trip, next.day),
    lastStop ? { lat: lastStop.lat, lon: lastStop.lon } : null);
  const advice = departureAdvice({
    deadlineISO: next.deadline.atISO, travelMinutes: minutes, weatherRain: lastRain,
  });
  if (!advice) return;

  card.classList.add(advice.level);
  $('verdictLabel').textContent = `${next.deadline.label}　${hhmmOf(next.at)}`;
  $('verdictHead').textContent =
    advice.level === 'late' ? 'いま出ても間に合わない見込みです'
    : advice.level === 'soon' ? 'そろそろ出てください'
    : humanLeft(advice.leftMin) + ' 余裕があります';
  $('verdictSub').textContent =
    `推奨出発 ${hhmmOf(advice.leaveAt)}　／　移動 概算${advice.travelMinutes}分 ＋ 余裕${advice.buffer}分`
    + (lastRain >= 50 ? '（雨の予報があるので余裕を足しています）' : '');
}

// MARK: - 天気

async function renderWeather() {
  const trip = activeTrip();
  const card = $('weatherCard');
  const here = myLocation ?? (trip && firstKnown(trip));
  if (!here) { card.classList.add('hidden'); return; }

  const today = iso(new Date());
  try {
    const { raw, day } = await fetchWeather(here.lat, here.lon, today);
    card.classList.remove('hidden');
    $('weatherWhere').textContent = myLocation ? '現在地' : '旅程のはじめの地点';

    const nowIdx = raw.hourly?.time?.findIndex((t) => new Date(t) >= new Date()) ?? -1;
    const temp = nowIdx >= 0 ? raw.hourly.temperature_2m[nowIdx] : day?.max;
    const code = nowIdx >= 0 ? raw.hourly.weather_code[nowIdx] : day?.code;
    $('weatherNow').textContent = `${weatherFace(code)} ${Math.round(temp)}°`;
    $('weatherLine').textContent = day
      ? `${weatherWord(day.code)}　最高${Math.round(day.max)}° / 最低${Math.round(day.min)}°　降水 ${day.rain ?? 0}%`
      : weatherWord(code);
    lastRain = day?.rain ?? null;

    const box = $('hourly');
    box.innerHTML = '';
    for (let i = nowIdx; i < Math.min(nowIdx + 6, raw.hourly.time.length); i++) {
      if (i < 0) break;
      const t = new Date(raw.hourly.time[i]);
      const el = document.createElement('div');
      el.innerHTML = `<div class="dim">${t.getHours()}時</div>
        <div style="font-size:18px">${weatherFace(raw.hourly.weather_code[i])}</div>
        <div class="num">${Math.round(raw.hourly.temperature_2m[i])}°</div>`;
      box.appendChild(el);
    }
    renderVerdict();
  } catch {
    card.classList.remove('hidden');
    $('weatherNow').textContent = '—';
    $('weatherLine').textContent = '天気を取れませんでした。通信を確認してください。';
    $('hourly').innerHTML = '';
  }
}

// MARK: - 旅程

function renderDays() {
  const box = $('days');
  box.innerHTML = '';
  const trip = activeTrip();
  if (!trip) return;

  trip.days.forEach((day, index) => {
    const det = document.createElement('details');
    det.className = 'card daycard';
    det.open = index === 0;
    const sum = document.createElement('summary');
    sum.innerHTML = `<span></span><span class="quiet"></span>`;
    sum.children[0].textContent = `${day.title}（${day.date}）`;
    sum.children[1].textContent = `${day.stops.length}か所`;
    det.appendChild(sum);

    for (const stop of day.stops) {
      const row = document.createElement('div');
      row.className = 'stop';
      row.innerHTML = `<div><div class="nm"></div><div class="meta"></div></div><div class="acts"></div>`;
      row.querySelector('.nm').textContent = stop.name;
      row.querySelector('.meta').textContent =
        (stop.at ? stop.at + '　' : '') +
        (stop.lat == null ? '場所が未確定'
          : stop.source === 'auto' ? '自動でついた場所（要確認）'
          : stop.source === 'confirmed' ? '自分で決めた場所' : '場所あり');

      const acts = row.querySelector('.acts');
      const place = document.createElement('button');
      place.textContent = stop.lat == null ? '場所を決める' : '場所';
      place.addEventListener('click', () => openPlace(day.id, stop.id));
      acts.appendChild(place);

      if (stop.lat != null) {
        const nav = document.createElement('a');
        nav.className = 'btn';
        nav.style.cssText = 'min-height:34px;padding:5px 10px;font-size:12px;text-decoration:none';
        nav.target = '_blank';
        nav.rel = 'noopener';
        nav.href = `https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lon}`;
        nav.textContent = '経路';
        acts.appendChild(nav);
      }

      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = '消';
      del.addEventListener('click', () => {
        if (!confirm(`「${stop.name}」を消しますか？`)) return;
        day.stops = day.stops.filter((s) => s.id !== stop.id);
        save(); renderAll();
      });
      acts.appendChild(del);
      det.appendChild(row);
    }

    if (day.stops.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'quiet';
      empty.textContent = 'この日の立ち寄りはまだありません。';
      det.appendChild(empty);
    }

    const add = document.createElement('div');
    add.className = 'row';
    add.style.marginTop = '10px';
    add.innerHTML = `<input placeholder="立ち寄りを足す"><button>追加</button>`;
    const [input, btn] = add.children;
    btn.addEventListener('click', () => {
      const name = input.value.trim();
      if (!name) return;
      day.stops.push({ id: uid(), name, at: '', lat: null, lon: null, source: null });
      input.value = '';
      save(); renderAll();
    });
    det.appendChild(add);

    const note = document.createElement('input');
    note.placeholder = 'この日のメモ';
    note.value = day.note ?? '';
    note.style.marginTop = '8px';
    note.addEventListener('change', () => { day.note = note.value.trim(); save(); });
    det.appendChild(note);

    box.appendChild(det);
  });
}

// MARK: - 場所を決める

const placeDialog = $('placeDialog');

function openPlace(dayId, stopId) {
  const trip = activeTrip();
  const day = trip.days.find((d) => d.id === dayId);
  const stop = day.stops.find((s) => s.id === stopId);
  picking = { day, stop, lat: stop.lat, lon: stop.lon };

  $('placeTitle').textContent = stop.name;
  $('placeState').textContent = stop.lat == null
    ? '場所が未確定です。決めると天気・経路・所要時間が使えます。'
    : '選び直すと上書きします。';
  $('placeQuery').value = stop.name;
  $('placeCands').innerHTML = '';
  $('placeError').textContent = '';
  placeDialog.showModal();

  const start = stop.lat != null ? [stop.lat, stop.lon]
    : (firstKnown(trip) ? [firstKnown(trip).lat, firstKnown(trip).lon] : [35.0, 135.0]);

  setTimeout(() => {
    if (!map) {
      map = L.map('map').setView(start, 14);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '© OpenStreetMap',
      }).addTo(map);
      map.on('moveend', () => {
        const c = map.getCenter();
        picking.lat = c.lat; picking.lon = c.lng;
        setMarker(c.lat, c.lng);
      });
    }
    map.invalidateSize();
    map.setView(start, 14);
    if (stop.lat != null) setMarker(stop.lat, stop.lon);
  }, 60);

  runSearch();
}

function setMarker(lat, lon) {
  if (!map) return;
  if (marker) marker.setLatLng([lat, lon]);
  else marker = L.marker([lat, lon]).addTo(map);
}

async function runSearch() {
  const q = $('placeQuery').value.trim();
  if (!q) return;
  $('placeError').textContent = '探しています…';
  $('placeCands').innerHTML = '';
  try {
    const trip = activeTrip();
    const rows = await searchPlaces(q, firstKnown(trip));
    $('placeError').textContent = rows.length ? '' : '見つかりませんでした。地図を動かして中心を合わせてください。';
    for (const r of rows) {
      const btn = document.createElement('button');
      btn.className = 'cand';
      btn.innerHTML = `<strong></strong><small></small>`;
      btn.querySelector('strong').textContent = r.name;
      btn.querySelector('small').textContent = r.address;
      btn.addEventListener('click', () => {
        picking.lat = r.lat; picking.lon = r.lon;
        map?.setView([r.lat, r.lon], 15);
        setMarker(r.lat, r.lon);
      });
      $('placeCands').appendChild(btn);
    }
  } catch {
    $('placeError').textContent = '検索できませんでした。地図を動かして中心を合わせてください。';
  }
}

$('placeSearch').addEventListener('click', runSearch);
$('placeQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } });
$('placeClose').addEventListener('click', () => placeDialog.close());
$('placeConfirm').addEventListener('click', () => {
  if (!picking || picking.lat == null) return;
  picking.stop.lat = picking.lat;
  picking.stop.lon = picking.lon;
  picking.stop.source = 'confirmed';   // 自分で決めたもの。自動とは分ける
  save(); placeDialog.close(); renderAll();
});
$('placeClear').addEventListener('click', () => {
  if (!picking) return;
  picking.stop.lat = null; picking.stop.lon = null; picking.stop.source = null;
  save(); placeDialog.close(); renderAll();
});

// MARK: - 場所をまとめて自動でつける
//
// 当てたものは source:'auto' にして、自分で決めたものと見分けられるようにする。

$('autoPlacesBtn').addEventListener('click', async () => {
  const trip = activeTrip();
  if (!trip) return;
  const btn = $('autoPlacesBtn');
  btn.disabled = true; btn.textContent = '探しています…';
  const missed = [];
  let near = firstKnown(trip);

  for (const day of trip.days) {
    for (const stop of day.stops) {
      if (stop.lat != null) continue;
      try {
        const rows = await searchPlaces(stop.name, near);
        if (rows.length) {
          stop.lat = rows[0].lat; stop.lon = rows[0].lon; stop.source = 'auto';
          near = { lat: rows[0].lat, lon: rows[0].lon };
        } else missed.push(stop.name);
      } catch { missed.push(stop.name); }
      // Nominatim は1秒1件まで。行儀よく待つ。
      await new Promise((r) => setTimeout(r, 1100));
    }
  }
  save();
  btn.disabled = false; btn.textContent = '場所をまとめて自動でつける';
  $('autoResult').textContent = missed.length
    ? `見つからなかった：${missed.join('、')}`
    : '全部つきました。「自動でついた場所（要確認）」は念のため確かめてください。';
  renderAll();
});

$('addDayStopBtn').addEventListener('click', () => {
  document.querySelector('.daycard')?.setAttribute('open', '');
  document.querySelector('.daycard input')?.focus();
});

// MARK: - 旅行の管理

const tripsDialog = $('tripsDialog');

function renderTripList() {
  const box = $('tripList');
  box.innerHTML = '';
  if (state.trips.length === 0) {
    box.innerHTML = '<div class="empty">まだ旅行がありません。</div>';
    return;
  }
  for (const t of state.trips) {
    const row = document.createElement('div');
    row.className = 'spread';
    row.innerHTML = `<button class="ghost" style="flex:1;text-align:left"></button>
                     <button class="danger" style="min-height:36px">消す</button>`;
    row.children[0].textContent = t.title + (t.id === state.activeId ? '（表示中）' : '');
    row.children[0].addEventListener('click', () => {
      state.activeId = t.id; save(); tripsDialog.close(); renderAll();
    });
    row.children[1].addEventListener('click', () => {
      if (!confirm(`「${t.title}」を消しますか？元に戻せません。`)) return;
      const tombstone = { id: t.id, updatedAt: Date.now() };
      state.deleted = state.deleted.filter((item) => item.id !== t.id);
      state.deleted.push(tombstone);
      state.trips = state.trips.filter((x) => x.id !== t.id);
      if (state.activeId === t.id) state.activeId = state.trips[0]?.id ?? null;
      store.set(state);
      if (isSyncConfigured()) {
        void syncRequest(`/tavi/trips/${encodeURIComponent(t.id)}`, { method: 'DELETE', body: tombstone })
          .then(() => setSyncStatus('削除をNotionに反映しました'))
          .catch((error) => setSyncStatus(`${error.message}。次回の同期で再試行します`));
      }
      renderTripList(); renderAll();
    });
    box.appendChild(row);
  }
}

$('locBtn').addEventListener('click', askLocation);
$('tripsBtn').addEventListener('click', () => { renderTripList(); tripsDialog.showModal(); });
$('tripsClose').addEventListener('click', () => tripsDialog.close());

const syncDialog = $('syncDialog');
$('syncBtn').addEventListener('click', () => {
  const canSync = isSyncConfigured();
  $('syncNowBtn').disabled = !canSync;
  setSyncStatus(canSync ? '本人版：Notion同期を利用できます' : '公開体験版：この端末だけに保存します');
  syncDialog.showModal();
});
$('syncClose').addEventListener('click', () => syncDialog.close());
$('syncNowBtn').addEventListener('click', () => syncTrips());

$('newTripForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const trip = makeTrip({
    title: $('ntTitle').value, start: $('ntStart').value, end: $('ntEnd').value,
  });
  if (!trip) { alert('題名と日程を入れてください（60日以内）。'); return; }
  trip.updatedAt = Date.now();
  state.trips.push(trip);
  state.activeId = trip.id;
  save(); tripsDialog.close(); renderAll();
});

$('loadSample').addEventListener('click', () => {
  const trip = sampleTrip();
  trip.updatedAt = Date.now();
  state.trips.push(trip);
  state.activeId = trip.id;
  save(); tripsDialog.close(); renderAll();
});

// MARK: - 起動

function renderAll() {
  state = normalizeState(store.get());
  renderVerdict();
  renderDays();
  renderWeather();
}

const today = iso(new Date());
$('ntStart').value = today;
$('ntEnd').value = today;
renderAll();
void syncTrips({ quiet: true });
setInterval(renderVerdict, 30000);
