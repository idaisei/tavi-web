import { breakdown, reason, daysUntil, SEVERITY, MANUAL } from './priority.js';
import {
  store, uid, studySeconds, breakSeconds, isOnBreak, breakRemaining,
  totals, todaySeconds, streak, xpFromSeconds, levelProgress, hhmm, clock,
} from './store.js';

const $ = (id) => document.getElementById(id);
const screens = { home: $('home'), desk: $('desk'), done: $('done'), history: $('history') };

let state = store.get();
let tick = null;

function show(name) {
  for (const [key, el] of Object.entries(screens)) el.classList.toggle('hidden', key !== name);
  if (name === 'desk') startTicking(); else stopTicking();
  if (name === 'history') renderHistory();
  if (name === 'home') renderHome();
}

function save() { store.set(state); }

// MARK: - ホーム

function deadlineWord(subject) { return subject.kind === 'task' ? '締め切り' : '試験'; }

function rankedSubjects(now = new Date()) {
  return state.subjects
    .map((s) => {
      const d = daysUntil(s.examDate, now);
      const b = breakdown({ daysUntil: d, severity: s.examDate ? s.severity : null, manual: s.manual });
      return { subject: s, b };
    })
    .sort((a, b) => b.b.score - a.b.score);
}

function renderHome() {
  const secs = todaySeconds(state.sessions);
  $('todayTotal').textContent = hhmm(secs);

  const p = levelProgress(state.xp);
  $('levelLine').textContent =
    `レベル ${p.level}・次まで ${Math.max(0, p.span - p.into)}XP（1分＝1XP）`;

  const list = $('subjectList');
  list.innerHTML = '';
  const ranked = rankedSubjects();
  if (ranked.length === 0) {
    list.innerHTML = '<div class="empty">まだ何も入っていません。<br>「科目・タスクを足す」から始めてください。</div>';
    return;
  }
  for (const { subject, b } of ranked) {
    const btn = document.createElement('button');
    btn.className = 'subject-row';
    const sev = subject.examDate && subject.severity ? SEVERITY[subject.severity].short : '—';
    btn.innerHTML = `
      <span>
        <span class="nm"></span><br>
        <span class="why"></span>
      </span>
      <span class="pill ${b.daysUntil !== null && b.daysUntil <= 3 ? 'warn' : ''}">${sev}</span>`;
    btn.querySelector('.nm').textContent = subject.name;
    btn.querySelector('.why').textContent = reason(b, deadlineWord(subject));
    btn.addEventListener('click', () => startSession(subject.id));
    list.appendChild(btn);
  }
}

// MARK: - セッション

function startSession(subjectId) {
  if (state.active) return;
  state.active = { id: uid(), subjectId, start: Date.now(), breaks: [], end: null };
  save();
  show('desk');
}

function endSession() {
  const s = state.active;
  if (!s) return;
  // 休憩したまま終わっても、休憩は閉じてから数える。
  const last = s.breaks.at(-1);
  if (last && !last.end) last.end = Date.now();
  s.end = Date.now();

  const study = studySeconds(s);
  state.sessions.push(s);
  state.xp += xpFromSeconds(study);
  state.active = null;
  save();

  $('doneTime').textContent = hhmm(study);
  const brk = breakSeconds(s);
  $('doneDetail').textContent =
    brk > 0 ? `休憩 ${hhmm(brk)} は別に数えています。` : '休憩なしでした。';
  show('done');
}

function startBreak(minutes) {
  const s = state.active;
  if (!s || isOnBreak(s)) return;
  s.breaks.push({ start: Date.now(), end: null, plannedMinutes: minutes });
  save();
  renderDesk();
}

function endBreak() {
  const s = state.active;
  const last = s?.breaks.at(-1);
  if (!last || last.end) return;
  last.end = Date.now();
  save();
  renderDesk();
}

function startTicking() {
  stopTicking();
  renderDesk();
  tick = setInterval(renderDesk, 1000);
}
function stopTicking() { if (tick) clearInterval(tick); tick = null; }

function renderDesk() {
  const s = state.active;
  if (!s) { show('home'); return; }
  const subject = state.subjects.find((x) => x.id === s.subjectId);
  $('deskSubject').textContent = subject?.name ?? '勉強';

  const study = studySeconds(s);
  $('deskElapsed').textContent = hhmm(study);
  $('deskClock').textContent = clock(Date.now());

  // 弧は 2時間 を満タンとして流れる。秒は出さない。
  // 毎秒動く数字が視界の真ん中にあると集中を削がれるので。
  const ratio = Math.min(1, study / (2 * 3600));
  $('arcFill').setAttribute('stroke-dasharray', `${(ratio * 100).toFixed(2)} 100`);

  const onBreak = isOnBreak(s);
  $('breakCard').classList.toggle('hidden', onBreak);
  $('onBreakCard').classList.toggle('hidden', !onBreak);

  if (onBreak) {
    const left = breakRemaining(s, Date.now());
    if (left === null) {
      $('breakLeft').textContent = hhmm(breakSeconds(s));
      $('breakNudge').textContent = '';
    } else if (left >= 0) {
      $('breakLeft').textContent = `残り ${Math.ceil(left / 60)}分`;
      $('breakNudge').textContent = '時間になったら静かに出します。';
    } else {
      // 5分おきに静かに催促する。10分のつもりが40分、を防ぐため。
      const over = Math.floor(-left / 60);
      $('breakLeft').textContent = `+${over}分`;
      $('breakNudge').textContent = over >= 5 ? 'そろそろ戻りませんか。' : '休憩の予定を過ぎました。';
    }
  }
}

// MARK: - 記録

function renderHistory() {
  const { series, bySubject } = totals(state.sessions, { days: 7 });
  const max = Math.max(60, ...series.map((d) => d.seconds));
  const bars = $('bars');
  const labels = $('barLabels');
  bars.innerHTML = '';
  labels.innerHTML = '';
  series.forEach((d, i) => {
    const bar = document.createElement('div');
    bar.className = 'bar' + (i === series.length - 1 ? ' today' : '');
    bar.style.height = `${Math.max(3, (d.seconds / max) * 92)}px`;
    bar.title = `${d.key}：${hhmm(d.seconds)}`;
    bars.appendChild(bar);

    const lab = document.createElement('div');
    lab.textContent = '日月火水木金土'[d.date.getDay()];
    labels.appendChild(lab);
  });

  const st = streak(state.sessions);
  $('streakLine').textContent = st > 0 ? `${st}日つづいています。` : 'まだ連続日数はありません。';

  const box = $('subjectTotals');
  box.innerHTML = '';
  const rows = [...bySubject.entries()].sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) {
    box.innerHTML = '<div class="empty">この7日間の記録はまだありません。</div>';
    return;
  }
  for (const [subjectId, secs] of rows) {
    const name = state.subjects.find((s) => s.id === subjectId)?.name ?? '（消した科目）';
    const row = document.createElement('div');
    row.className = 'spread';
    row.innerHTML = '<span></span><span class="num muted"></span>';
    row.children[0].textContent = name;
    row.children[1].textContent = hhmm(secs);
    box.appendChild(row);
  }
}

// MARK: - 科目を足す

const dialog = $('subjectDialog');
let newKind = 'study';

document.querySelectorAll('[role="tab"]').forEach((tab) => {
  tab.addEventListener('click', () => {
    newKind = tab.dataset.kind;
    document.querySelectorAll('[role="tab"]').forEach((t) =>
      t.setAttribute('aria-selected', String(t === tab)));
    document.querySelectorAll('.deadlineWord').forEach((el) => {
      el.textContent = newKind === 'task' ? '締め切り' : '試験';
    });
  });
});

$('addSubjectBtn').addEventListener('click', () => { $('subjectForm').reset(); dialog.showModal(); });
$('sjCancel').addEventListener('click', () => dialog.close());

$('subjectForm').addEventListener('submit', (e) => {
  const name = $('sjName').value.trim();
  if (!name) { e.preventDefault(); return; }
  state.subjects.push({
    id: uid(),
    name,
    kind: newKind,
    examDate: $('sjDate').value || null,
    severity: Number($('sjSeverity').value),
    manual: Number($('sjManual').value),
  });
  save();
  renderHome();
});

// MARK: - 配線

$('endBtn').addEventListener('click', endSession);
$('endBreakBtn').addEventListener('click', endBreak);
$('breakButtons').addEventListener('click', (e) => {
  const min = e.target.closest('[data-min]')?.dataset.min;
  if (min) startBreak(Number(min));
});
$('doneBack').addEventListener('click', () => show('home'));
$('goHistory').addEventListener('click', () => show('history'));
$('backHome').addEventListener('click', () => show('home'));
$('resetBtn').addEventListener('click', () => {
  if (!confirm('保存した科目と記録を全部消します。元に戻せません。')) return;
  store.reset();
  state = store.get();
  show('home');
});

// タブに戻ってきたら時刻を引き直す。数え上げていないので、ずれようがない。
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.active) renderDesk();
});

show(state.active ? 'desk' : 'home');
