// 保存と集計。
//
// **経過秒を数え上げない。** 保存するのは開始・休憩・終了の「時刻」だけで、
// 画面に出す時間はその引き算。だからタブを閉じても、翌日開いても、
// 端末を再起動しても正しい（iOS版と同じ作り）。
//
// 置き場所はブラウザの localStorage。サーバーには何も送らない。

const KEY = new URLSearchParams(location.search).get('private') === '1'
  ? 'focusdesk.private.v1'
  : 'focusdesk.v1';

const EMPTY = { subjects: [], sessions: [], active: null, xp: 0 };

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(EMPTY);
    const parsed = JSON.parse(raw);
    return { ...structuredClone(EMPTY), ...parsed };
  } catch {
    // 壊れていても落とさない。空で始めた方が、開けないより良い。
    return structuredClone(EMPTY);
  }
}

function write(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('保存できませんでした', e);
  }
}

export const store = {
  get() { return read(); },
  set(next) { write(next); return next; },
  update(fn) { const s = read(); fn(s); write(s); return s; },
  reset() { write(structuredClone(EMPTY)); },
};

export const uid = () => 'x' + Math.random().toString(36).slice(2, 10);

// MARK: - セッションの時間計算

/** 休憩の合計秒。終わっていない休憩は now までで数える。 */
export function breakSeconds(session, now = Date.now()) {
  return (session.breaks ?? []).reduce((sum, b) => {
    const end = b.end ?? now;
    return sum + Math.max(0, (end - b.start) / 1000);
  }, 0);
}

/** 勉強していた秒 ＝ 全体 − 休憩。数え上げではなく引き算。 */
export function studySeconds(session, now = Date.now()) {
  const end = session.end ?? now;
  const total = Math.max(0, (end - session.start) / 1000);
  return Math.max(0, total - breakSeconds(session, now));
}

export function isOnBreak(session) {
  const last = (session?.breaks ?? []).at(-1);
  return !!last && !last.end;
}

/** いま続いている休憩の残り秒。予定を過ぎたら負になる（催促に使う）。 */
export function breakRemaining(session, now = Date.now()) {
  const last = (session?.breaks ?? []).at(-1);
  if (!last || last.end || !last.plannedMinutes) return null;
  return last.plannedMinutes * 60 - (now - last.start) / 1000;
}

// MARK: - 集計

const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 日ごと・科目ごとの勉強秒。休憩は含めない。 */
export function totals(sessions, { days = 7, now = Date.now() } = {}) {
  const byDay = new Map();
  const bySubject = new Map();
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - (days - 1));

  for (const s of sessions) {
    if (!s.end) continue;
    if (s.start < from.getTime()) continue;
    const secs = studySeconds(s);
    const k = dayKey(s.start);
    byDay.set(k, (byDay.get(k) ?? 0) + secs);
    bySubject.set(s.subjectId, (bySubject.get(s.subjectId) ?? 0) + secs);
  }

  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const k = dayKey(d.getTime());
    series.push({ key: k, date: d, seconds: byDay.get(k) ?? 0 });
  }
  return { series, bySubject };
}

export function todaySeconds(sessions, now = Date.now()) {
  const k = dayKey(now);
  return sessions
    .filter((s) => s.end && dayKey(s.start) === k)
    .reduce((sum, s) => sum + studySeconds(s), 0);
}

/** 連続日数。今日がまだ0分でも、昨日まで続いていれば途切れていない扱い。 */
export function streak(sessions, now = Date.now()) {
  const done = new Set(sessions.filter((s) => s.end && studySeconds(s) >= 60).map((s) => dayKey(s.start)));
  let count = 0;
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  if (!done.has(dayKey(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1);
  while (done.has(dayKey(cursor.getTime()))) {
    count++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
}

// MARK: - XP とレベル（iOS版と同じ：1分 = 1XP、レベルは二次で伸びる）

export const xpFromSeconds = (seconds) => Math.floor(seconds / 60);
export const xpRequired = (level) => 60 * level * level;

export function levelProgress(xp) {
  let level = 1;
  while (xp >= xpRequired(level + 1)) level++;
  const base = xpRequired(level);
  const next = xpRequired(level + 1);
  return { level, xp, into: xp - base, span: next - base, ratio: (xp - base) / (next - base) };
}

// MARK: - 表示

export function hhmm(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}時間${String(m).padStart(2, '0')}分` : `${m}分`;
}

export function clock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
