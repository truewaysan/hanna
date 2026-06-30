/* app.js — ハンナ お世話手帳 画面ロジック
 * 役割: 画面描画・記録の入力・ルーティン・リマインド通知。
 * データの読み書きはすべて Store(store.js)経由。
 */
(function () {
  'use strict';

  // ---- イベント種別のメタ情報 ----
  const META = {
    pee:    { label: 'おしっこ', emoji: '💧', cls: 'pee' },
    poop:   { label: 'うんち',   emoji: '💩', cls: 'poop' },
    meal:   { label: 'ごはん',   emoji: '🍚', cls: 'meal' },
    weight: { label: '体重',     emoji: '⚖️', cls: 'weight' },
    med:    { label: 'くすり',   emoji: '💊', cls: 'med' },
    vet:    { label: '通院',     emoji: '🏥', cls: 'vet' },
  };
  const KIND_ICON = { toilet: '🚽', meal: '🍚', play: '🎾', sleep: '😴', walk: '🐾', other: '🔖' };
  const ATE = { all: '完食', some: '半分', none: '食べない' };
  const STOOL = { soft: 'ゆるい', normal: '普通', hard: '硬い' };
  const VETKIND = { vaccine: 'ワクチン', checkup: '健診', other: 'その他' };

  // ---- ショートカット ----
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const pad = (n) => String(n).padStart(2, '0');

  // ---- 時刻フォーマット ----
  function fmtTime(ts) {
    const d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function todayKey() { return dayKey(Date.now()); }
  function dayLabel(ts) {
    const d = new Date(ts);
    const wd = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
    if (dayKey(ts) === todayKey()) return '今日';
    const y = new Date(Date.now() - 86400000);
    if (dayKey(ts) === dayKey(y.getTime())) return '昨日';
    return `${d.getMonth() + 1}/${d.getDate()}(${wd})`;
  }
  function relTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return 'たった今';
    const m = Math.floor(diff / 60000);
    if (m < 60) return `${m}分前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}時間${m % 60 ? (m % 60) + '分' : ''}前`;
    return `${Math.floor(h / 24)}日前`;
  }
  function ageStr(birthday) {
    if (!birthday) return '';
    const b = new Date(birthday + 'T00:00:00');
    const now = new Date();
    if (now < b) {
      const days = Math.ceil((b - now) / 86400000);
      return `誕生まであと${days}日`;
    }
    let months = (now.getFullYear() - b.getFullYear()) * 12 + (now.getMonth() - b.getMonth());
    let days = now.getDate() - b.getDate();
    if (days < 0) {
      months -= 1;
      const prev = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
      days += prev;
    }
    const totalDays = Math.floor((now - b) / 86400000);
    return `生後${months}ヶ月${days}日（${totalDays}日）`;
  }

  // ---- ルーティン達成チェック(1日でリセット) ----
  const DONE_KEY = 'hanna.routineDone.v1';
  function getDone() {
    let d;
    try { d = JSON.parse(localStorage.getItem(DONE_KEY)) || {}; } catch (e) { d = {}; }
    if (d.date !== todayKey()) d = { date: todayKey(), ids: {} };
    return d;
  }
  function setDone(d) { localStorage.setItem(DONE_KEY, JSON.stringify(d)); }

  // ===================================================================
  // ナビゲーション
  // ===================================================================
  function nav(name) {
    $$('.view').forEach((v) => v.classList.remove('active'));
    $('#view-' + name).classList.add('active');
    $$('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.nav === name));
    window.scrollTo(0, 0);
    if (name === 'home') renderHome();
    if (name === 'routine') renderRoutine();
    if (name === 'records') renderRecords();
    if (name === 'settings') renderSettings();
  }

  // ===================================================================
  // ホーム
  // ===================================================================
  function renderHeader() {
    const s = Store.getSettings();
    $('#petName').textContent = s.name || 'ハンナ';
    $('#petAge').textContent = ageStr(s.birthday);
  }

  function renderHome() {
    renderHeader();
    renderStatus();
    renderTodayTimeline();
    updateNotifBanner();
  }

  function renderStatus() {
    const s = Store.getSettings();
    const items = [
      { type: 'pee', warn: true },
      { type: 'poop', warn: false },
      { type: 'meal', warn: false },
    ];
    const grid = $('#statusGrid');
    grid.innerHTML = items.map((it) => {
      const m = META[it.type];
      const last = Store.lastOf(it.type);
      const val = last ? relTime(last.ts) : 'まだ';
      const sub = last ? fmtTime(last.ts) : '記録なし';
      let warn = '';
      if (it.warn && last) {
        const mins = (Date.now() - last.ts) / 60000;
        if (mins > s.reminders.toiletIntervalMin) warn = 'warn';
      }
      return `<div class="status ${warn}">
        <div class="ico">${m.emoji}</div>
        <div class="lbl">前回の${m.label}</div>
        <div class="val">${val}<br><small>${sub}</small></div>
      </div>`;
    }).join('');
  }

  function eventLine(ev) {
    const m = META[ev.type];
    let meta = '';
    if (ev.type === 'meal') {
      const bits = [];
      if (ev.data.grams) bits.push(ev.data.grams + 'g');
      if (ev.data.ate) bits.push(ATE[ev.data.ate]);
      meta = bits.join(' ・ ');
    } else if (ev.type === 'poop' && ev.data.stool) {
      meta = STOOL[ev.data.stool];
    } else if (ev.type === 'weight') {
      meta = ev.data.grams ? ev.data.grams + 'g' : '';
    } else if (ev.type === 'med') {
      meta = ev.data.name || '';
    } else if (ev.type === 'vet') {
      meta = [VETKIND[ev.data.vetKind] || '', ev.data.name || ''].filter(Boolean).join('：');
      if (ev.data.next) meta += ` ／ 次回 ${ev.data.next}`;
    }
    if (ev.note) meta = meta ? meta + ' ・ ' + ev.note : ev.note;
    return `<div class="tl-item" data-id="${ev.id}">
      <div class="dot tag-${m.cls}">${m.emoji}</div>
      <div class="body"><div class="ttl">${m.label}</div>${meta ? `<div class="meta">${esc(meta)}</div>` : ''}</div>
      <div class="time">${fmtTime(ev.ts)}</div>
      <button class="edit" data-edit="${ev.id}" aria-label="編集">⋯</button>
    </div>`;
  }

  function renderTodayTimeline() {
    const today = todayKey();
    const evs = Store.getEvents().filter((e) => dayKey(e.ts) === today);
    const box = $('#todayTimeline');
    if (!evs.length) {
      box.innerHTML = `<div class="tl-empty">まだ今日の記録はありません。<br>上のボタンから記録してね 🐾</div>`;
      return;
    }
    box.innerHTML = evs.map(eventLine).join('');
  }

  // ===================================================================
  // ルーティン
  // ===================================================================
  function renderRoutine() {
    const list = Store.getRoutine();
    const done = getDone();
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    // 次の予定(未来で一番近い)を「now」に
    let nextId = null, best = Infinity;
    list.forEach((r) => {
      const [h, mm] = r.time.split(':').map(Number);
      const t = h * 60 + mm;
      if (t >= nowMin && t - nowMin < best) { best = t - nowMin; nextId = r.id; }
    });
    const box = $('#routineList');
    box.innerHTML = list.map((r) => {
      const isDone = !!done.ids[r.id];
      return `<div class="r-item ${isDone ? 'done' : ''} ${r.id === nextId ? 'now' : ''}" data-rid="${r.id}">
        <div class="r-time" data-redit="${r.id}">${r.time}</div>
        <div class="r-kind">${KIND_ICON[r.kind] || '🔖'}</div>
        <div class="r-title" data-redit="${r.id}">${esc(r.title)}</div>
        <button class="r-check" data-rcheck="${r.id}">✓</button>
      </div>`;
    }).join('');
    const total = list.length;
    const doneCount = list.filter((r) => done.ids[r.id]).length;
    $('#routineProgress').textContent = `${doneCount}/${total}`;
  }

  function toggleRoutineDone(id) {
    const d = getDone();
    d.ids[id] = !d.ids[id];
    setDone(d);
    renderRoutine();
  }

  function editRoutine(id) {
    const list = Store.getRoutine();
    const r = id ? list.find((x) => x.id === id) : { id: '', time: '12:00', title: '', kind: 'play' };
    const isNew = !id;
    openSheet(`
      <h3>${isNew ? '予定を追加' : '予定を編集'}</h3>
      <div class="field"><label>時刻</label><input id="rTime" type="time" value="${r.time}"></div>
      <div class="field"><label>内容</label><input id="rTitle" type="text" value="${esc(r.title)}" placeholder="例: 朝ごはん"></div>
      <div class="field"><label>種類</label>
        <select id="rKind">
          ${Object.entries(KIND_ICON).map(([k, ic]) => `<option value="${k}" ${k === r.kind ? 'selected' : ''}>${ic} ${kindLabel(k)}</option>`).join('')}
        </select>
      </div>
      <button class="btn" id="rSave">保存</button>
      ${isNew ? '' : '<button class="btn danger" id="rDel" style="margin-top:8px">削除</button>'}
    `);
    $('#rSave').onclick = () => {
      const time = $('#rTime').value;
      const title = $('#rTitle').value.trim();
      if (!title) { return; }
      let cur = Store.getRoutine();
      if (isNew) cur.push({ id: Store.uid(), time, title, kind: $('#rKind').value });
      else cur = cur.map((x) => (x.id === id ? { ...x, time, title, kind: $('#rKind').value } : x));
      Store.saveRoutine(cur);
      closeSheet(); renderRoutine();
    };
    if (!isNew) $('#rDel').onclick = () => {
      Store.saveRoutine(Store.getRoutine().filter((x) => x.id !== id));
      closeSheet(); renderRoutine();
    };
  }
  function kindLabel(k) {
    return { toilet: 'トイレ', meal: 'ごはん', play: '遊び', sleep: 'ねんね', walk: 'お散歩', other: 'その他' }[k] || k;
  }

  // ===================================================================
  // きろく（記録一覧 / 体重グラフ / 通院）
  // ===================================================================
  let historyFilter = 'all';
  function renderRecords() {
    renderWeightChart();
    renderVetList();
    renderFilterChips();
    renderHistory();
  }

  function renderWeightChart() {
    const ws = Store.getEvents().filter((e) => e.type === 'weight' && e.data.grams).sort((a, b) => a.ts - b.ts);
    const svg = $('#weightChart');
    const info = $('#weightInfo');
    if (ws.length < 2) {
      svg.innerHTML = '';
      const last = ws[ws.length - 1];
      info.innerHTML = last ? `現在 <b>${last.data.grams}g</b>（${dayLabel(last.ts)}）` : '体重を2回以上記録するとグラフが出ます';
      return;
    }
    const W = 320, H = 160, pad = { l: 8, r: 8, t: 14, b: 18 };
    const xs = ws.map((w) => w.ts), ys = ws.map((w) => w.data.grams);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const sx = (t) => pad.l + ((t - minX) / (maxX - minX || 1)) * (W - pad.l - pad.r);
    const sy = (v) => H - pad.b - ((v - minY) / (maxY - minY || 1)) * (H - pad.t - pad.b);
    const pts = ws.map((w) => `${sx(w.ts).toFixed(1)},${sy(w.data.grams).toFixed(1)}`);
    const dots = ws.map((w) => `<circle cx="${sx(w.ts).toFixed(1)}" cy="${sy(w.data.grams).toFixed(1)}" r="3" fill="#46B3A6"/>`).join('');
    svg.innerHTML = `
      <polyline points="${pts.join(' ')}" fill="none" stroke="#46B3A6" stroke-width="2.5" stroke-linejoin="round"/>
      ${dots}
      <text x="${pad.l}" y="11" font-size="9" fill="#9B8B7E">${maxY}g</text>
      <text x="${pad.l}" y="${H - 6}" font-size="9" fill="#9B8B7E">${minY}g</text>`;
    const first = ws[0], last = ws[ws.length - 1];
    const diff = last.data.grams - first.data.grams;
    info.innerHTML = `現在 <b>${last.data.grams}g</b> ・ 記録開始から ${diff >= 0 ? '+' : ''}${diff}g`;
  }

  function renderVetList() {
    const vs = Store.getEvents().filter((e) => e.type === 'vet');
    const box = $('#vetList');
    if (!vs.length) { box.innerHTML = `<div class="tl-empty">通院・ワクチンの記録はまだありません</div>`; return; }
    // 次回予定を上に出す
    const upcoming = vs.filter((v) => v.data.next).map((v) => v.data.next).sort();
    let head = '';
    if (upcoming.length) {
      const nextDate = upcoming.find((d) => d >= todayKey()) || upcoming[upcoming.length - 1];
      head = `<div class="banner"><span>📅</span><div>次の予定：<b>${nextDate}</b></div></div>`;
    }
    box.innerHTML = head + vs.map(eventLine).join('');
  }

  function renderFilterChips() {
    const types = ['all', 'pee', 'poop', 'meal', 'weight', 'med', 'vet'];
    $('#filterChips').innerHTML = types.map((t) => {
      const label = t === 'all' ? 'すべて' : META[t].emoji + META[t].label;
      return `<button class="chip ${historyFilter === t ? 'on' : ''}" data-filter="${t}">${label}</button>`;
    }).join('');
  }

  function renderHistory() {
    let evs = Store.getEvents();
    if (historyFilter !== 'all') evs = evs.filter((e) => e.type === historyFilter);
    const box = $('#historyTimeline');
    if (!evs.length) { box.innerHTML = `<div class="tl-empty">記録がありません</div>`; return; }
    let html = '', lastDay = '';
    evs.forEach((ev) => {
      const dk = dayKey(ev.ts);
      if (dk !== lastDay) { html += `<div class="day-head">${dayLabel(ev.ts)}</div>`; lastDay = dk; }
      html += eventLine(ev);
    });
    box.innerHTML = html;
  }

  // ===================================================================
  // 記録の入力（クイック / シート）
  // ===================================================================
  function quickLog(type) {
    if (type === 'pee') return instantLog('pee');
    if (type === 'poop') return instantLog('poop');
    if (type === 'meal') return mealSheet();
    if (type === 'weight') return weightSheet();
    if (type === 'med') return medSheet();
    if (type === 'vet') return vetSheet();
  }

  function instantLog(type) {
    const ev = Store.addEvent({ type });
    refreshAll();
    const m = META[type];
    showToast(`${m.emoji} ${m.label}を記録しました`, '元に戻す', () => {
      Store.deleteEvent(ev.id); refreshAll();
    });
  }

  function mealSheet() {
    const lastMeal = Store.lastOf('meal');
    const defG = (lastMeal && lastMeal.data.grams) || '';
    openSheet(`
      <h3>🍚 ごはんを記録</h3>
      <div class="field"><label>量（g・任意）</label><input id="mG" type="number" inputmode="numeric" value="${defG}" placeholder="例: 30"></div>
      <label style="font-size:12.5px;color:var(--muted);font-weight:600">食べた量</label>
      <div class="pick-row" id="atePick">
        ${Object.entries(ATE).map(([k, v], i) => `<div class="pick ${i === 0 ? 'on' : ''}" data-ate="${k}">${v}</div>`).join('')}
      </div>
      <button class="btn" id="mSave">記録する</button>
    `);
    pickGroup('#atePick', 'ate');
    $('#mSave').onclick = () => {
      const grams = parseInt($('#mG').value, 10);
      const ate = $('#atePick .pick.on').dataset.ate;
      Store.addEvent({ type: 'meal', data: { grams: grams || null, ate } });
      closeSheet(); refreshAll(); showToast('🍚 ごはんを記録しました');
    };
  }

  function weightSheet() {
    const last = Store.lastOf('weight');
    openSheet(`
      <h3>⚖️ 体重を記録</h3>
      ${last ? `<p class="hint">前回：${last.data.grams}g（${dayLabel(last.ts)}）</p>` : ''}
      <div class="field"><label>体重（g）</label><input id="wG" type="number" inputmode="numeric" placeholder="例: 750" autofocus></div>
      <button class="btn" id="wSave">記録する</button>
    `);
    $('#wSave').onclick = () => {
      const grams = parseInt($('#wG').value, 10);
      if (!grams) return;
      Store.addEvent({ type: 'weight', data: { grams } });
      closeSheet(); refreshAll(); showToast('⚖️ 体重を記録しました');
    };
  }

  function medSheet() {
    const meds = Store.getMeds();
    openSheet(`
      <h3>💊 くすり・サプリを記録</h3>
      ${meds.length ? `<div class="pick-row">${meds.map((m) => `<div class="pick" data-med="${m.id}">${esc(m.name)}</div>`).join('')}</div>`
        : `<p class="hint">登録された薬がありません。下から追加できます。</p>`}
      <div class="field"><label>または直接入力</label><input id="medFree" type="text" placeholder="薬・サプリ名"></div>
      <button class="btn" id="medSave">記録する</button>
      <p class="hint">よく使う薬は「設定 › 薬・サプリの登録」に入れておくとワンタップで記録できます。</p>
    `);
    $$('#sheetBody .pick[data-med]').forEach((p) => {
      p.onclick = () => {
        const med = meds.find((m) => m.id === p.dataset.med);
        Store.addEvent({ type: 'med', data: { name: med.name } });
        closeSheet(); refreshAll(); showToast(`💊 ${med.name}を記録しました`);
      };
    });
    $('#medSave').onclick = () => {
      const name = $('#medFree').value.trim();
      if (!name) return;
      Store.addEvent({ type: 'med', data: { name } });
      closeSheet(); refreshAll(); showToast('💊 くすりを記録しました');
    };
  }

  function vetSheet() {
    openSheet(`
      <h3>🏥 通院・ワクチンを記録</h3>
      <div class="pick-row" id="vetKind">
        ${Object.entries(VETKIND).map(([k, v], i) => `<div class="pick ${i === 0 ? 'on' : ''}" data-vk="${k}">${v}</div>`).join('')}
      </div>
      <div class="field"><label>内容（任意）</label><input id="vName" type="text" placeholder="例: 混合ワクチン2回目"></div>
      <div class="field"><label>次回予定（任意）</label><input id="vNext" type="date"></div>
      <button class="btn" id="vSave">記録する</button>
    `);
    pickGroup('#vetKind', 'vk');
    $('#vSave').onclick = () => {
      const vetKind = $('#vetKind .pick.on').dataset.vk;
      const name = $('#vName').value.trim();
      const next = $('#vNext').value || null;
      Store.addEvent({ type: 'vet', data: { vetKind, name, next } });
      closeSheet(); refreshAll(); showToast('🏥 通院を記録しました');
    };
  }

  // 既存イベントの編集
  function editEvent(id) {
    const ev = Store.getEvents().find((e) => e.id === id);
    if (!ev) return;
    const m = META[ev.type];
    const dt = new Date(ev.ts);
    const localDt = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    let extra = '';
    if (ev.type === 'poop') {
      extra = `<label style="font-size:12.5px;color:var(--muted);font-weight:600">うんちの状態</label>
        <div class="pick-row" id="ePoop">${Object.entries(STOOL).map(([k, v]) => `<div class="pick ${ev.data.stool === k ? 'on' : ''}" data-st="${k}">${v}</div>`).join('')}</div>`;
    } else if (ev.type === 'meal') {
      extra = `<div class="field"><label>量(g)</label><input id="eG" type="number" value="${ev.data.grams || ''}"></div>`;
    } else if (ev.type === 'weight') {
      extra = `<div class="field"><label>体重(g)</label><input id="eG" type="number" value="${ev.data.grams || ''}"></div>`;
    } else if (ev.type === 'med') {
      extra = `<div class="field"><label>薬名</label><input id="eName" type="text" value="${esc(ev.data.name || '')}"></div>`;
    }
    openSheet(`
      <h3>${m.emoji} ${m.label}を編集</h3>
      <div class="field"><label>日時</label><input id="eTs" type="datetime-local" value="${localDt}"></div>
      ${extra}
      <div class="field"><label>メモ</label><input id="eNote" type="text" value="${esc(ev.note || '')}" placeholder="ひとこと"></div>
      <button class="btn" id="eSave">保存</button>
      <button class="btn danger" id="eDel" style="margin-top:8px">削除</button>
    `);
    if (ev.type === 'poop') pickGroup('#ePoop', 'st');
    $('#eSave').onclick = () => {
      const patch = { note: $('#eNote').value.trim(), data: {} };
      const tsv = $('#eTs').value;
      if (tsv) patch.ts = new Date(tsv).getTime();
      if (ev.type === 'poop') { const sel = $('#ePoop .pick.on'); if (sel) patch.data.stool = sel.dataset.st; }
      if (ev.type === 'meal' || ev.type === 'weight') { const g = parseInt(($('#eG') || {}).value, 10); if (g) patch.data.grams = g; }
      if (ev.type === 'med') patch.data.name = ($('#eName') || {}).value.trim();
      Store.updateEvent(id, patch);
      closeSheet(); refreshAll();
    };
    $('#eDel').onclick = () => { Store.deleteEvent(id); closeSheet(); refreshAll(); };
  }

  // ===================================================================
  // 設定
  // ===================================================================
  function renderSettings() {
    const s = Store.getSettings();
    $('#setName').value = s.name || '';
    $('#setBirthday').value = s.birthday || '';
    $('#setArrival').value = s.arrival || '';
    $('#remRoutine').checked = s.reminders.routine;
    $('#remToilet').checked = s.reminders.toilet;
    $('#remInterval').value = String(s.reminders.toiletIntervalMin);
    renderMedMaster();
    updateNotifStatus();
    renderShareCard();
  }

  function renderMedMaster() {
    const meds = Store.getMeds();
    const box = $('#medMaster');
    if (!meds.length) { box.innerHTML = `<p class="hint">まだ登録がありません</p>`; return; }
    box.innerHTML = meds.map((m) => `<div class="row">
      <div><div class="r-label">${esc(m.name)}</div>${m.note ? `<div class="r-desc">${esc(m.note)}</div>` : ''}</div>
      <button class="btn sm danger" data-delmed="${m.id}">削除</button>
    </div>`).join('');
  }

  function saveReminderSettings() {
    const s = Store.getSettings();
    s.reminders.routine = $('#remRoutine').checked;
    s.reminders.toilet = $('#remToilet').checked;
    s.reminders.toiletIntervalMin = parseInt($('#remInterval').value, 10);
    Store.saveSettings(s);
  }

  // ===================================================================
  // 家族共有（クラウド）
  // ===================================================================
  function renderShareCard() {
    const card = $('#shareCard');
    if (!card) return;
    if (!Store.cloud.isConfigured()) {
      card.innerHTML = `
        <p class="hint">いまは <b>この端末だけ</b> に記録が保存されています。家族みんなで同じ記録を見るには共有をオンにします。</p>
        <button class="btn" id="shareStart">家族共有を始める</button>
        <button class="btn ghost sm" id="shareJoinManual" style="margin-top:8px">共有コードで参加する</button>
        <p class="hint">※ 最初に一度だけ Supabase（無料）の準備が必要です。</p>`;
      $('#shareStart').onclick = shareStartFlow;
      $('#shareJoinManual').onclick = shareJoinFlow;
    } else {
      const st = Store.getStatus();
      const label = st === 'online' ? '✅ 共有オン（リアルタイム同期）'
        : st === 'connecting' ? '接続中…'
        : '⚠️ オフライン（つながると自動で同期します）';
      const link = Store.cloud.shareLink();
      const pend = Store.cloud.pendingCount();
      card.innerHTML = `
        <div class="share-status">${label}</div>
        ${pend ? `<p class="hint">未送信の記録 ${pend} 件（オンライン復帰時に送信）</p>` : ''}
        <p class="hint">このリンクを家族に送ると、タップだけで同じ記録に参加できます。</p>
        <div class="share-link-box"><input id="shareLinkInput" readonly value="${esc(link)}"><button class="btn sm" id="copyLink">コピー</button></div>
        <p class="hint">世帯コード：<span class="code-pill">${esc(Store.cloud.getConfig().household)}</span></p>
        <button class="btn danger" id="shareOff" style="margin-top:6px">共有を解除（この端末をローカルに戻す）</button>`;
      $('#copyLink').onclick = () => copyText(link);
      $('#shareOff').onclick = () => {
        if (!confirm('この端末を共有から外します。記録は端末に残ります。よろしいですか？')) return;
        Store.cloud.disconnect(); renderSettings();
      };
    }
  }

  function shareStartFlow() {
    openSheet(`
      <h3>🔗 家族共有を始める</h3>
      <p class="hint">Supabase で作ったプロジェクトの「Settings › API」から<br>Project URL と <b>anon public</b> キーをコピペします。</p>
      <div class="field"><label>Project URL</label><input id="cfUrl" type="url" placeholder="https://xxxx.supabase.co"></div>
      <div class="field"><label>anon public キー</label><input id="cfKey" type="text" placeholder="eyJ..."></div>
      <button class="btn" id="cfCreate">共有を開始（この端末の記録をアップ）</button>
      <p class="hint">今この端末にある記録がクラウドへ送られ、共有の元になります。</p>`);
    $('#cfCreate').onclick = async () => {
      const url = $('#cfUrl').value.trim(), key = $('#cfKey').value.trim();
      if (!url || !key) return;
      const btn = $('#cfCreate'); btn.disabled = true; btn.textContent = '接続中…';
      try {
        await Store.cloud.create(url, key);
        closeSheet(); renderSettings(); showToast('家族共有を開始しました 🐾');
      } catch (e) {
        btn.disabled = false; btn.textContent = '共有を開始（この端末の記録をアップ）';
        showToast('接続に失敗：' + (e.message || 'URL/キーを確認してください'));
      }
    };
  }

  function shareJoinFlow() {
    openSheet(`
      <h3>🔗 共有コードで参加</h3>
      <p class="hint">オーナーから受け取った3つを入力します。<br>（共有リンクをタップできるならそちらが簡単です）</p>
      <div class="field"><label>Project URL</label><input id="jUrl" type="url" placeholder="https://xxxx.supabase.co"></div>
      <div class="field"><label>anon public キー</label><input id="jKey" type="text" placeholder="eyJ..."></div>
      <div class="field"><label>世帯コード</label><input id="jCode" type="text" placeholder="h-..."></div>
      <button class="btn danger" id="jJoin">参加する（この端末の記録は置き換わります）</button>`);
    $('#jJoin').onclick = async () => {
      const url = $('#jUrl').value.trim(), key = $('#jKey').value.trim(), code = $('#jCode').value.trim();
      if (!url || !key || !code) return;
      const btn = $('#jJoin'); btn.disabled = true; btn.textContent = '参加中…';
      try {
        await Store.cloud.join(url, key, code);
        closeSheet(); renderSettings(); renderActive(); showToast('参加しました 🐾');
      } catch (e) {
        btn.disabled = false; btn.textContent = '参加する（この端末の記録は置き換わります）';
        showToast('参加に失敗：' + (e.message || '入力を確認してください'));
      }
    };
  }

  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(() => showToast('コピーしました'), fallbackCopy);
    } else fallbackCopy();
    function fallbackCopy() {
      const i = $('#shareLinkInput'); if (!i) return;
      i.focus(); i.select();
      try { document.execCommand('copy'); showToast('コピーしました'); }
      catch (e) { showToast('リンクを長押ししてコピーしてください'); }
    }
  }

  // 同期ステータスのバッジ
  function updateSyncBadge(s) {
    const el = $('#syncBadge');
    if (!el) return;
    if (s === 'local') { el.hidden = true; return; }
    el.hidden = false;
    el.className = 'sync-badge ' + s;
    el.textContent = s === 'online' ? '共有オン' : s === 'connecting' ? '接続中…' : 'オフライン';
  }

  // クラウドの起動・共有リンク参加の処理
  async function bootstrapCloud() {
    const m = location.hash.match(/^#join=(.+)$/);
    if (m) {
      history.replaceState(null, '', location.pathname + location.search);
      try {
        const c = Store.cloud.decodeLink(m[1]);
        if (confirm('家族の共有に参加します。\nこの端末の既存の記録はクラウドの記録に置き換わります。\n（必要なら先に設定からバックアップを）\n\n参加しますか？')) {
          showToast('参加中…');
          await Store.cloud.join(c.url, c.anonKey, c.household);
          showToast('家族共有に参加しました 🐾');
          renderActive();
          return;
        }
      } catch (e) { showToast('共有リンクの読み込みに失敗しました'); }
    }
    await Store.init();
  }

  // ===================================================================
  // ボトムシート
  // ===================================================================
  function openSheet(html) {
    $('#sheetBody').innerHTML = html;
    $('#sheetMask').classList.add('open');
    requestAnimationFrame(() => $('#sheet').classList.add('open'));
  }
  function closeSheet() {
    $('#sheet').classList.remove('open');
    $('#sheetMask').classList.remove('open');
  }
  // pick-row の単一選択
  function pickGroup(sel, attr) {
    $$(sel + ' .pick').forEach((p) => {
      p.onclick = () => { $$(sel + ' .pick').forEach((x) => x.classList.remove('on')); p.classList.add('on'); };
    });
  }

  // ===================================================================
  // トースト
  // ===================================================================
  let toastTimer = null;
  function showToast(msg, actionLabel, actionFn) {
    const t = $('#toast');
    $('#toastMsg').textContent = msg;
    const btn = $('#toastAction');
    if (actionLabel) {
      btn.hidden = false; btn.textContent = actionLabel;
      btn.onclick = () => { actionFn(); hideToast(); };
    } else btn.hidden = true;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, actionLabel ? 5000 : 2200);
  }
  function hideToast() { $('#toast').classList.remove('show'); }

  // ===================================================================
  // 通知・リマインド
  // ===================================================================
  function notifyReady() { return 'Notification' in window && Notification.permission === 'granted'; }

  async function requestNotif() {
    if (!('Notification' in window)) { showToast('この端末は通知に対応していません'); return; }
    const p = await Notification.requestPermission();
    updateNotifBanner(); updateNotifStatus();
    if (p === 'granted') {
      sendNotify('ハンナ お世話手帳', 'これからお世話の時間をお知らせします 🐾', 'welcome');
    }
  }

  function sendNotify(title, body, tag) {
    if (!notifyReady()) return;
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'notify', title, body, tag });
    } else {
      try { new Notification(title, { body, tag }); } catch (e) { /* ignore */ }
    }
  }

  function inQuietHours(s) {
    const now = new Date(); const cur = pad(now.getHours()) + ':' + pad(now.getMinutes());
    const { quietStart, quietEnd } = s.reminders;
    if (quietStart <= quietEnd) return cur >= quietStart && cur < quietEnd;
    return cur >= quietStart || cur < quietEnd; // 日付またぎ
  }

  // 30秒ごとに点検
  function reminderTick() {
    if (!notifyReady()) return;
    const s = Store.getSettings();
    const st = Store.getNotifyState();
    const now = Date.now();

    // ルーティン通知
    if (s.reminders.routine) {
      const cur = new Date();
      const curMin = cur.getHours() * 60 + cur.getMinutes();
      Store.getRoutine().forEach((r) => {
        const [h, mm] = r.time.split(':').map(Number);
        const rMin = h * 60 + mm;
        const key = `r-${r.id}-${todayKey()}`;
        if (curMin >= rMin && curMin - rMin <= 1 && !st[key]) {
          sendNotify(`そろそろ「${r.title}」`, `${r.time} ${KIND_ICON[r.kind] || ''} の時間です`, key);
          st[key] = true;
        }
      });
    }

    // トイレ間隔通知
    if (s.reminders.toilet && !inQuietHours(s)) {
      const lastPee = Store.lastOf('pee');
      const lastPoop = Store.lastOf('poop');
      const lastToilet = Math.max(lastPee ? lastPee.ts : 0, lastPoop ? lastPoop.ts : 0);
      if (lastToilet) {
        const intervalMs = s.reminders.toiletIntervalMin * 60000;
        const overdue = now - lastToilet > intervalMs;
        const notifiedAfter = st.toiletNotifyTs || 0;
        if (overdue && now - notifiedAfter > intervalMs) {
          sendNotify('そろそろトイレかも 🚽', `前回のトイレから${Math.floor((now - lastToilet) / 60000)}分たちました`, 'toilet');
          st.toiletNotifyTs = now;
        }
      }
    }
    Store.saveNotifyState(st);
  }

  function updateNotifBanner() {
    const banner = $('#notifBanner');
    if (!banner) return;
    const show = ('Notification' in window) && Notification.permission === 'default';
    banner.style.display = show ? 'flex' : 'none';
  }
  function updateNotifStatus() {
    const el = $('#notifStatus');
    if (!el) return;
    if (!('Notification' in window)) { el.textContent = 'この端末は通知に対応していません。'; return; }
    const p = Notification.permission;
    if (p === 'granted') el.innerHTML = '✅ 通知オン。アプリを開いている間にお知らせします。';
    else if (p === 'denied') el.innerHTML = '通知がブロックされています。端末のブラウザ設定から許可してください。';
    else el.innerHTML = '<button id="askNotif" style="color:var(--primary-d);font-weight:700;text-decoration:underline">通知を許可する</button>';
    const ask = $('#askNotif'); if (ask) ask.onclick = requestNotif;
  }

  // ===================================================================
  // 全体更新
  // ===================================================================
  function refreshAll() {
    const active = $('.view.active').id.replace('view-', '');
    if (active === 'home') renderHome();
    if (active === 'routine') renderRoutine();
    if (active === 'records') renderRecords();
  }

  // 他端末の変更(realtime)で現在の画面を丸ごと再描画
  function renderActive() {
    renderHeader();
    const v = $('.view.active'); if (!v) return;
    const name = v.id.replace('view-', '');
    if (name === 'home') renderHome();
    else if (name === 'routine') renderRoutine();
    else if (name === 'records') renderRecords();
    else if (name === 'settings') renderSettings();
  }

  // HTMLエスケープ
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ===================================================================
  // データ書き出し / 読み込み / リセット
  // ===================================================================
  function exportData() {
    const data = Store.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `hanna-backup-${todayKey()}.json`;
    a.click(); URL.revokeObjectURL(url);
  }
  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        Store.importAll(JSON.parse(reader.result));
        showToast('読み込みました'); nav('home');
      } catch (e) { showToast('読み込みに失敗しました'); }
    };
    reader.readAsText(file);
  }

  // ===================================================================
  // 初期化 / イベント結線
  // ===================================================================
  function init() {
    // ナビ
    $$('.nav button').forEach((b) => (b.onclick = () => nav(b.dataset.nav)));

    // ホームのクイックボタン
    $$('[data-quick]').forEach((b) => (b.onclick = () => quickLog(b.dataset.quick)));

    // タイムライン等のタップ（イベント委譲）
    document.body.addEventListener('click', (e) => {
      const editBtn = e.target.closest('[data-edit]');
      if (editBtn) { editEvent(editBtn.dataset.edit); return; }
      const rcheck = e.target.closest('[data-rcheck]');
      if (rcheck) { toggleRoutineDone(rcheck.dataset.rcheck); return; }
      const redit = e.target.closest('[data-redit]');
      if (redit) { editRoutine(redit.dataset.redit); return; }
      const fil = e.target.closest('[data-filter]');
      if (fil) { historyFilter = fil.dataset.filter; renderFilterChips(); renderHistory(); return; }
      const delmed = e.target.closest('[data-delmed]');
      if (delmed) { Store.deleteMed(delmed.dataset.delmed); renderMedMaster(); return; }
    });

    // シート閉じる
    $('#sheetMask').onclick = closeSheet;

    // ルーティン追加
    $('#addRoutine').onclick = () => editRoutine(null);

    // 通知バナー / 設定
    $('#enableNotif').onclick = requestNotif;
    ['remRoutine', 'remToilet', 'remInterval'].forEach((id) => {
      $('#' + id).addEventListener('change', saveReminderSettings);
    });

    // プロフィール保存
    $('#saveProfile').onclick = () => {
      const s = Store.getSettings();
      s.name = $('#setName').value.trim() || 'ハンナ';
      s.birthday = $('#setBirthday').value;
      s.arrival = $('#setArrival').value;
      Store.saveSettings(s);
      renderHeader(); showToast('保存しました');
    };

    // 薬の追加
    $('#addMed').onclick = () => {
      openSheet(`
        <h3>💊 薬・サプリを追加</h3>
        <div class="field"><label>名前</label><input id="medName" type="text" placeholder="例: フィラリア予防薬"></div>
        <div class="field"><label>メモ（任意）</label><input id="medNote" type="text" placeholder="例: 月1回・第1日曜"></div>
        <button class="btn" id="medAddSave">追加</button>
      `);
      $('#medAddSave').onclick = () => {
        const name = $('#medName').value.trim();
        if (!name) return;
        Store.addMed(name, $('#medNote').value);
        closeSheet(); renderMedMaster();
      };
    };

    // データ
    $('#exportData').onclick = exportData;
    $('#importData').onclick = () => $('#importFile').click();
    $('#importFile').onchange = (e) => { if (e.target.files[0]) importData(e.target.files[0]); };
    $('#resetData').onclick = () => {
      if (!confirm('すべての記録・設定を消します。よろしいですか？')) return;
      Object.values(Store.KEYS).forEach((k) => localStorage.removeItem(k));
      localStorage.removeItem(DONE_KEY);
      showToast('消去しました'); nav('home'); renderSettings();
    };

    // Service Worker 登録（オフライン＆通知）
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW登録失敗', e));
    }

    // クラウド同期：状態バッジと、他端末の変更での再描画を結線
    Store.onStatus(updateSyncBadge);
    Store.onChange(renderActive);

    // 初期画面（まずローカルキャッシュで即描画）
    nav('home');

    // クラウド接続（共有リンク経由の参加もここで処理。完了すれば onChange で再描画）
    bootstrapCloud();

    // リマインド開始
    setInterval(reminderTick, 30000);
    setTimeout(reminderTick, 3000);

    // 日付が変わったらホーム更新（経過時間など）
    setInterval(() => { if ($('.view.active').id === 'view-home') renderHome(); }, 60000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
