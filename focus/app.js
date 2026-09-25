import { breakdown, reason, daysUntil, SEVERITY } from './priority.js';
import {
  store, uid, studySeconds, breakSeconds, isOnBreak, breakRemaining,
  totals, todaySeconds, streak, xpFromSeconds, levelProgress, hhmm, clock,
} from './store.js';

const $ = (id) => document.getElementById(id);
const screens = { home: $('home'), desk: $('desk'), done: $('done'), history: $('history') };
const COLORS = ['7FB2FF', '8FD6C0', 'E3B36F', 'E48D8D', 'B49BE0', '7FC8E8', 'C9CF7F', '9AA4B2'];
const DEFAULT_SETTINGS = {
  timerMode: 'stopwatch', countdownMinutes: 25, usePlannedEnd: false,
  plannedEnd: '18:00', breakSuggestAfter: 60, dimAfter: 60, keepAwake: true,
};

let state = normalize(store.get());
let tick = null;
let wakeLock = null;
let lastInteraction = Date.now();
let newKind = 'study';

function normalize(raw) {
  const next = raw ?? {};
  next.subjects = (next.subjects ?? []).map((s, index) => ({
    colorHex: COLORS[index % COLORS.length], dailyGoalMinutes: 0, kind: 'study', ...s,
  }));
  next.sessions ??= [];
  next.active ??= null;
  next.xp ??= 0;
  next.settings = { ...DEFAULT_SETTINGS, ...(next.settings ?? {}) };
  return next;
}

function save() { store.set(state); }

function show(name) {
  Object.entries(screens).forEach(([key, el]) => el.classList.toggle('hidden', key !== name));
  document.body.classList.toggle('desk-mode', name === 'desk');
  $('topbar').classList.toggle('hidden', name === 'desk');
  if (name === 'desk') {
    lastInteraction = Date.now();
    startTicking();
    requestWakeLock();
  } else {
    stopTicking();
    releaseWakeLock();
  }
  if (name === 'history') renderHistory();
  if (name === 'home') renderHome();
}

async function requestWakeLock() {
  if (!state.settings.keepAwake || !('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* ブラウザ非対応でもタイマーは動く */ }
}

async function releaseWakeLock() {
  try { await wakeLock?.release(); } catch { /* no-op */ }
  wakeLock = null;
}

function deadlineWord(subject) { return subject.kind === 'task' ? '締め切り' : '試験'; }

function rankedSubjects(now = new Date()) {
  return state.subjects
    .map((subject) => {
      const d = daysUntil(subject.examDate, now);
      const b = breakdown({ daysUntil: d, severity: subject.examDate ? subject.severity : null, manual: subject.manual });
      return { subject, b };
    })
    .sort((a, b) => b.b.score - a.b.score);
}

function subjectTodaySeconds(subjectId, includeActive = true) {
  const now = Date.now();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  let value = state.sessions
    .filter((s) => s.subjectId === subjectId && s.end && s.start >= start.getTime())
    .reduce((sum, s) => sum + studySeconds(s, now), 0);
  if (includeActive && state.active?.subjectId === subjectId && state.active.start >= start.getTime()) value += studySeconds(state.active, now);
  return value;
}

function hasTasks() { return state.subjects.some((s) => s.kind === 'task'); }

function renderSubjectButton(container, item, { immediate = true } = {}) {
  const { subject, b } = item;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'subject-row';
  btn.innerHTML = '<span class="subject-dot"></span><span><span class="nm"></span><br><span class="why"></span></span><span class="today num"></span>';
  btn.querySelector('.subject-dot').style.background = `#${subject.colorHex}`;
  btn.querySelector('.nm').textContent = subject.name;
  const sev = subject.examDate && subject.severity ? SEVERITY[subject.severity].short : '';
  btn.querySelector('.why').textContent = [reason(b, deadlineWord(subject)), sev].filter(Boolean).join(' ・ ');
  const studied = subjectTodaySeconds(subject.id, false);
  btn.querySelector('.today').textContent = studied > 0 ? hhmm(studied) : '—';
  btn.addEventListener('click', () => {
    if (immediate) startSession(subject.id, state.settings.timerMode, state.settings.countdownMinutes, plannedEndTimestamp());
    else { $('startDialog').close(); startSession(subject.id, selectedMode(), Number($('countdownMinutes').value), plannedEndTimestamp(true)); }
  });
  container.appendChild(btn);
}

function renderHome() {
  const secs = todaySeconds(state.sessions);
  const goals = state.subjects.reduce((sum, s) => sum + Number(s.dailyGoalMinutes || 0), 0);
  $('todayLabel').textContent = hasTasks() ? '今日の合計時間' : '今日の勉強時間';
  $('todayTotal').textContent = hhmm(secs);
  $('goalLine').textContent = goals > 0 ? `科目の目標 合計 ${hhmm(goals * 60)}` : '科目ごとに1日の目標を設定できます';
  const goalRatio = goals > 0 ? Math.min(1, secs / (goals * 60)) : 0;
  $('goalRing').style.strokeDashoffset = String(100 - goalRatio * 100);

  const ranked = rankedSubjects();
  $('startSuggestion').textContent = ranked[0]?.subject.name ?? '';
  $('startLabel').textContent = hasTasks() ? '始める' : '勉強を始める';
  $('openStartBtn').disabled = ranked.length === 0;
  $('emptyState').classList.toggle('hidden', ranked.length > 0);
  $('prioritySection').classList.toggle('hidden', ranked.length === 0);
  $('priorityLabel').textContent = hasTasks() ? '優先度の高いもの' : '優先度の高い科目';

  const list = $('subjectList'); list.innerHTML = '';
  ranked.slice(0, 3).forEach((item) => renderSubjectButton(list, item));

  const p = levelProgress(state.xp);
  $('levelValue').textContent = p.level;
  $('xpValue').textContent = state.xp;
  $('streakValue').textContent = `${streak(state.sessions)}日`;
}

function selectedMode() {
  return $('timerMode').querySelector('[aria-selected="true"]')?.dataset.mode ?? 'stopwatch';
}

function suggestedEndTime() {
  const d = new Date(Date.now() + 2 * 3600 * 1000);
  const minutes = Math.ceil(d.getMinutes() / 15) * 15;
  if (minutes === 60) { d.setHours(d.getHours() + 1); d.setMinutes(0); } else d.setMinutes(minutes);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function plannedEndTimestamp(fromDialog = false) {
  const enabled = fromDialog ? $('usePlannedEnd').checked : state.settings.usePlannedEnd;
  const value = fromDialog ? $('plannedEnd').value : state.settings.plannedEnd;
  if (!enabled || !value) return null;
  const [hour, minute] = value.split(':').map(Number);
  const d = new Date(); d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function openStartDialog() {
  if (!state.subjects.length) return;
  $('countdownMinutes').value = String(state.settings.countdownMinutes);
  $('usePlannedEnd').checked = state.settings.usePlannedEnd;
  $('plannedEnd').value = state.settings.plannedEnd || suggestedEndTime();
  $('plannedEndRow').classList.toggle('hidden', !$('usePlannedEnd').checked);
  setTimerMode(state.settings.timerMode);
  const list = $('pickerList'); list.innerHTML = '';
  rankedSubjects().forEach((item) => renderSubjectButton(list, item, { immediate: false }));
  $('startDialog').showModal();
}

function setTimerMode(mode) {
  $('timerMode').querySelectorAll('[data-mode]').forEach((button) => button.setAttribute('aria-selected', String(button.dataset.mode === mode)));
  $('countdownRow').classList.toggle('hidden', mode !== 'countdown');
}

function startSession(subjectId, mode = 'stopwatch', countdownMinutes = 25, plannedEndAt = null) {
  if (state.active) return;
  state.settings.timerMode = mode;
  state.settings.countdownMinutes = countdownMinutes;
  state.settings.usePlannedEnd = !!plannedEndAt;
  if (plannedEndAt) state.settings.plannedEnd = clock(plannedEndAt);
  state.active = { id: uid(), subjectId, start: Date.now(), breaks: [], end: null, mode, countdownMinutes, plannedEndAt };
  save();
  show('desk');
}

function endSession() {
  const s = state.active;
  if (!s || !confirm('このセッションを終了して記録しますか？')) return;
  const last = s.breaks.at(-1);
  if (last && !last.end) last.end = Date.now();
  s.end = Date.now();
  const studied = studySeconds(s);
  const gained = xpFromSeconds(studied);
  state.sessions.push(s); state.xp += gained; state.active = null; save();
  const subject = state.subjects.find((x) => x.id === s.subjectId);
  $('doneTime').textContent = hhmm(studied);
  $('doneSubject').textContent = subject?.name ?? '科目なし';
  $('doneDetails').innerHTML = summaryRow('今日の合計', hhmm(todaySeconds(state.sessions))) + summaryRow('この科目の今日', hhmm(subjectTodaySeconds(s.subjectId, false))) + summaryRow('休憩', hhmm(breakSeconds(s)));
  $('doneXp').textContent = gained > 0 ? `+${gained} XP${streak(state.sessions) ? ` ・ ${streak(state.sessions)}日連続` : ''}` : '';
  show('done');
}

function summaryRow(label, value) { return `<div class="spread"><span class="quiet">${label}</span><strong class="num">${value}</strong></div>`; }

function startBreak(minutes) {
  const s = state.active;
  if (!s || isOnBreak(s)) return;
  s.breaks.push({ start: Date.now(), end: null, plannedMinutes: minutes });
  lastInteraction = Date.now(); save(); renderDesk();
}

function endBreak() {
  const last = state.active?.breaks.at(-1);
  if (!last || last.end) return;
  last.end = Date.now(); lastInteraction = Date.now(); save(); renderDesk();
}

function startTicking() { stopTicking(); renderDesk(); tick = setInterval(renderDesk, 1000); }
function stopTicking() { if (tick) clearInterval(tick); tick = null; }

function durationClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function shortCountdown(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function renderDesk() {
  const s = state.active;
  if (!s) { show('home'); return; }
  const now = Date.now();
  const subject = state.subjects.find((x) => x.id === s.subjectId);
  const onBreak = isOnBreak(s);
  const studied = studySeconds(s, now);
  const subjectToday = subjectTodaySeconds(s.subjectId);
  const countdown = s.mode === 'countdown' ? Number(s.countdownMinutes || 25) * 60 - studied : null;
  const primary = onBreak ? breakSeconds({ ...s, breaks: [s.breaks.at(-1)] }, now) : (countdown === null ? subjectToday : Math.abs(countdown));

  $('deskSubject').textContent = subject?.name ?? '科目なし';
  $('deskDot').style.background = `#${subject?.colorHex ?? COLORS[0]}`;
  $('breakBadge').classList.toggle('hidden', !onBreak);
  $('timerLabel').textContent = onBreak ? '休憩' : countdown === null ? '今日の経過時間' : countdown >= 0 ? '残り時間' : '超過';
  $('deskElapsed').textContent = durationClock(primary);
  $('deskElapsed').style.color = onBreak ? 'var(--rest)' : 'var(--text)';
  $('deskClock').textContent = clock(now);
  $('sessionMetric').textContent = hhmm(studied);
  $('breakMetric').textContent = hhmm(breakSeconds(s, now));
  const goal = Number(subject?.dailyGoalMinutes || 0);
  $('goalMetric').textContent = goal ? `${Math.round(subjectToday / (goal * 60) * 100)}%` : '—';

  const ratio = countdown === null ? (subjectToday % 3600) / 3600 : Math.min(1, studied / (Number(s.countdownMinutes || 25) * 60));
  $('arcFill').setAttribute('stroke-dasharray', `${Math.max(0, ratio * 100).toFixed(2)} 100`);
  $('arcFill').setAttribute('stroke', onBreak ? '#e5bd73' : '#71a9f0');
  $('breakCard').classList.toggle('hidden', onBreak);
  $('onBreakCard').classList.toggle('hidden', !onBreak);

  $('deskEndsAt').textContent = s.plannedEndAt ? `🔔 ${clock(s.plannedEndAt)}` : '';
  if (s.plannedEndAt) {
    $('plannedNotice').classList.remove('hidden');
    $('plannedNotice').textContent = now >= s.plannedEndAt ? '終わり予定の時刻を過ぎています' : `終わり予定 ${clock(s.plannedEndAt)}`;
  } else $('plannedNotice').classList.add('hidden');

  if (onBreak) {
    const left = breakRemaining(s, now);
    if (left >= 0) { $('breakLeft').textContent = shortCountdown(left); $('breakNudge').textContent = '時間になったら静かにお知らせします。'; }
    else { const over = Math.floor(-left / 60); $('breakLeft').textContent = `+${over}分`; $('breakNudge').textContent = over >= 5 ? 'そろそろ勉強に戻りませんか。' : '休憩の予定を過ぎました。'; }
  }

  const dimAfter = Number(state.settings.dimAfter || 0) * 1000;
  $('deskShell').classList.toggle('dimmed', !!dimAfter && now - lastInteraction >= dimAfter);
}

function renderHistory() {
  const { series, bySubject } = totals(state.sessions, { days: 7 });
  const max = Math.max(60, ...series.map((d) => d.seconds));
  $('bars').innerHTML = ''; $('barLabels').innerHTML = '';
  series.forEach((d, i) => {
    const bar = document.createElement('div'); bar.className = `bar${i === series.length - 1 ? ' today' : ''}`; bar.style.height = `${Math.max(3, d.seconds / max * 92)}px`; bar.title = `${d.key}：${hhmm(d.seconds)}`; $('bars').appendChild(bar);
    const label = document.createElement('div'); label.textContent = '日月火水木金土'[d.date.getDay()]; $('barLabels').appendChild(label);
  });
  const st = streak(state.sessions); $('streakLine').textContent = st ? `${st}日つづいています。` : 'まだ連続日数はありません。';
  const box = $('subjectTotals'); box.innerHTML = '';
  const rows = [...bySubject.entries()].sort((a, b) => b[1] - a[1]);
  if (!rows.length) box.innerHTML = '<div class="empty">この7日間の記録はまだありません。</div>';
  rows.forEach(([id, seconds]) => { const row = document.createElement('div'); row.className = 'spread'; row.innerHTML = '<span></span><strong class="num"></strong>'; row.children[0].textContent = state.subjects.find((s) => s.id === id)?.name ?? '（削除済み）'; row.children[1].textContent = hhmm(seconds); box.appendChild(row); });
}

function initColorOptions() {
  $('colorOptions').innerHTML = '';
  COLORS.forEach((color, i) => {
    const input = document.createElement('input'); input.type = 'radio'; input.name = 'subjectColor'; input.id = `color-${i}`; input.value = color; input.checked = i === 0;
    const label = document.createElement('label'); label.htmlFor = input.id; label.style.setProperty('--c', `#${color}`); label.ariaLabel = `色 ${i + 1}`;
    $('colorOptions').append(input, label);
  });
}

function openSubjectDialog() {
  const select = $('sjExisting');
  select.innerHTML = '<option value="">＋ 新しく追加</option>';
  state.subjects.forEach((subject) => {
    const option = document.createElement('option'); option.value = subject.id; option.textContent = subject.name; select.appendChild(option);
  });
  $('sjExistingRow').classList.toggle('hidden', state.subjects.length === 0);
  clearSubjectForm();
  $('subjectDialog').showModal();
}

function clearSubjectForm() {
  $('subjectForm').reset(); $('sjId').value = ''; $('sjExisting').value = ''; newKind = 'study'; setKind('study');
  $('colorOptions').querySelector('input').checked = true;
}

function loadSubjectIntoForm(id) {
  const subject = state.subjects.find((item) => item.id === id);
  if (!subject) { clearSubjectForm(); return; }
  $('sjId').value = subject.id; $('sjName').value = subject.name; setKind(subject.kind);
  $('sjGoal').value = String(subject.dailyGoalMinutes || 0); $('sjDate').value = subject.examDate || '';
  $('sjSeverity').value = String(subject.severity || 2); $('sjManual').value = String(subject.manual || 0);
  const color = document.querySelector(`input[name="subjectColor"][value="${subject.colorHex}"]`);
  if (color) color.checked = true;
}

function setKind(kind) {
  newKind = kind;
  $('kindTabs').querySelectorAll('[data-kind]').forEach((button) => button.setAttribute('aria-selected', String(button.dataset.kind === kind)));
  document.querySelectorAll('.deadlineWord').forEach((el) => { el.textContent = kind === 'task' ? '締め切り' : '試験'; });
}

function saveSettingsFromForm() {
  state.settings.breakSuggestAfter = Number($('breakSuggestAfter').value);
  state.settings.dimAfter = Number($('dimAfter').value);
  state.settings.keepAwake = $('keepAwake').checked;
  save();
}

function openSettings() {
  $('breakSuggestAfter').value = String(state.settings.breakSuggestAfter);
  $('dimAfter').value = String(state.settings.dimAfter);
  $('keepAwake').checked = state.settings.keepAwake;
  $('settingsDialog').showModal();
}

// MARK: - 操作の配線
$('openStartBtn').addEventListener('click', openStartDialog);
$('timerMode').querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => setTimerMode(button.dataset.mode)));
$('usePlannedEnd').addEventListener('change', () => $('plannedEndRow').classList.toggle('hidden', !$('usePlannedEnd').checked));
$('startDialog').addEventListener('close', () => {
  state.settings.timerMode = selectedMode(); state.settings.countdownMinutes = Number($('countdownMinutes').value);
  state.settings.usePlannedEnd = $('usePlannedEnd').checked; state.settings.plannedEnd = $('plannedEnd').value; save();
});
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $(button.dataset.close).close()));

[$('addSubjectBtn'), $('emptyAddBtn'), $('manageSubjectsBtn')].forEach((button) => button.addEventListener('click', openSubjectDialog));
$('sjCancel').addEventListener('click', () => $('subjectDialog').close());
$('sjExisting').addEventListener('change', () => loadSubjectIntoForm($('sjExisting').value));
$('kindTabs').querySelectorAll('[data-kind]').forEach((button) => button.addEventListener('click', () => setKind(button.dataset.kind)));
$('subjectForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('sjName').value.trim(); if (!name) return;
  const values = { name, kind: newKind, colorHex: document.querySelector('input[name="subjectColor"]:checked')?.value ?? COLORS[0], dailyGoalMinutes: Number($('sjGoal').value), examDate: $('sjDate').value || null, severity: Number($('sjSeverity').value), manual: Number($('sjManual').value) };
  const existing = state.subjects.find((subject) => subject.id === $('sjId').value);
  if (existing) Object.assign(existing, values); else state.subjects.push({ id: uid(), ...values });
  save(); $('subjectDialog').close(); renderHome();
});

document.querySelectorAll('#breakButtons [data-min]').forEach((button) => {
  button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); startBreak(Number(button.dataset.min)); });
});
$('endBreakBtn').addEventListener('click', endBreak);
$('endBtn').addEventListener('click', endSession);
$('doneBack').addEventListener('click', () => show('home'));
$('goHistory').addEventListener('click', () => show('history'));
$('backHome').addEventListener('click', () => show('home'));
$('settingsBtn').addEventListener('click', openSettings);
['breakSuggestAfter', 'dimAfter', 'keepAwake'].forEach((id) => $(id).addEventListener('change', saveSettingsFromForm));
$('resetBtn').addEventListener('click', () => {
  if (!confirm('保存した科目と記録を全部消します。元に戻せません。')) return;
  store.reset(); state = normalize(store.get()); $('settingsDialog').close(); show('home');
});

['pointerdown', 'keydown', 'touchstart'].forEach((name) => document.addEventListener(name, () => { lastInteraction = Date.now(); $('deskShell')?.classList.remove('dimmed'); }, { passive: true }));
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.active) { requestWakeLock(); renderDesk(); } });

initColorOptions();
show(state.active ? 'desk' : 'home');
