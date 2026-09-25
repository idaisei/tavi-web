// 科目の優先順位。iOS版 SubjectPriority.swift と同じ式にしてある。
//
//   score = urgency(残り日数) × importanceFactor(重大度) × manual.factor
//
// 加算ではなく乗算なのは、加算だと「明日の軽い小テスト」より
// 「10日後の留年試験」が上に来て、直前の試験を取りこぼすから（iOS版 D-004）。

export const SEVERITY = {
  1: { label: '軽い', short: '軽', factor: 0.55 },
  2: { label: '普通', short: '普', factor: 0.70 },
  3: { label: '重い', short: '重', factor: 0.85 },
  4: { label: '落とせない', short: '必', factor: 1.00 },
};

export const MANUAL = {
  0: { label: '自動', factor: 1.0, pinsToTop: false },
  1: { label: '低い', factor: 0.5, pinsToTop: false },
  2: { label: 'ふつう', factor: 1.0, pinsToTop: false },
  3: { label: '高い', factor: 1.6, pinsToTop: false },
  4: { label: '最優先', factor: 1.0, pinsToTop: true },
};

// 残り日数 → 緊急度。ここだけ触れば体感を調整できる。
const ANCHORS = [
  [0, 100], [1, 98], [2, 93], [3, 88], [5, 78], [7, 70],
  [10, 60], [14, 50], [21, 36], [30, 25], [60, 11], [90, 5],
];

const NO_EXAM_URGENCY = 4;      // 期限なし。期限ありより必ず下、終了済みより上
const FINISHED_URGENCY = 1;     // 終わった試験
const TOP_BASE = 1000;          // 「最優先」を固定で持ち上げる下駄

export function urgencyScore(daysUntil) {
  if (daysUntil === null || daysUntil === undefined) return NO_EXAM_URGENCY;
  if (daysUntil < 0) return FINISHED_URGENCY;
  const d = Number(daysUntil);
  if (d <= ANCHORS[0][0]) return ANCHORS[0][1];
  const last = ANCHORS[ANCHORS.length - 1];
  if (d >= last[0]) return Math.max(NO_EXAM_URGENCY + 0.5, last[1] * (90 / d));
  for (let i = 1; i < ANCHORS.length; i++) {
    const [loD, loS] = ANCHORS[i - 1];
    const [hiD, hiS] = ANCHORS[i];
    if (d <= hiD) return loS + (hiS - loS) * ((d - loD) / (hiD - loD));
  }
  return NO_EXAM_URGENCY;
}

export function importanceFactor(severity) {
  if (severity === null || severity === undefined) return 0.7;
  return (SEVERITY[severity] ?? SEVERITY[2]).factor;
}

export function breakdown({ daysUntil = null, severity = null, manual = 0 }) {
  const urgency = urgencyScore(daysUntil);
  const factor = importanceFactor(severity);
  const m = MANUAL[manual] ?? MANUAL[0];
  const score = m.pinsToTop ? TOP_BASE + urgency * factor : urgency * factor * m.factor;
  return { score, urgency, factor, daysUntil, severity, manual };
}

/** 画面に出す短い理由。なぜ上位なのかが分からないと並び順を信用できない。 */
export function reason(b, deadlineLabel) {
  let base;
  if (b.daysUntil !== null && b.daysUntil !== undefined && b.severity) {
    const sev = SEVERITY[b.severity].label;
    if (b.daysUntil < 0) base = `${deadlineLabel}は終了`;
    else if (b.daysUntil === 0) base = `今日が${deadlineLabel}（${sev}）`;
    else base = `あと${b.daysUntil}日・${sev}`;
  } else {
    base = `${deadlineLabel}未登録`;
  }
  if (b.manual === 4) return '最優先・' + base;
  if (b.manual !== 0) return `${base}・優先度${MANUAL[b.manual].label}`;
  return base;
}

/** 残り日数。日付の差だけを見る（時刻は無視）。 */
export function daysUntil(dateISO, now = new Date()) {
  if (!dateISO) return null;
  const target = new Date(dateISO + 'T00:00:00');
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86400000);
}
