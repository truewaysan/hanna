/* store.js — ハンナ用データ層（v2: ローカル＋クラウド家族共有）
 *
 * 役割: 記録(イベント)・ルーティン・設定・薬リストの保存と取り出し。
 *
 * 2つのモードを自動で切り替える:
 *  - ローカルモード（未設定）: この端末の localStorage だけ。今まで通り。
 *  - クラウドモード（設定済み）: localStorage を「正本キャッシュ」にしつつ
 *      Supabase と双方向同期＋リアルタイム購読。家族の複数端末で同じ記録を共有。
 *
 * 設計のキモ:
 *  - 画面(app.js)は今まで通り「同期的」に getEvents() 等を呼ぶ → キャッシュから即返す。
 *  - 書き込みはキャッシュを即更新（UIは即反映）＋ クラウドへは outbox 経由で非同期送信。
 *    オフライン時は outbox に貯まり、再接続時に flush。記録を取りこぼさない。
 *  - クラウドの変更は realtime で受信 → キャッシュ更新 → onChange() で画面再描画。
 *
 * 接続情報(URL/anonキー/世帯コード)は localStorage のみに保存。公開リポには入れない。
 */
(function (global) {
  'use strict';

  const KEYS = {
    events: 'hanna.events.v1',
    routine: 'hanna.routine.v1',
    settings: 'hanna.settings.v1',
    meds: 'hanna.meds.v1',
    notify: 'hanna.notify.v1',
    cloud: 'hanna.cloud.v1',     // {url, anonKey, household}
    outbox: 'hanna.outbox.v1',   // 未送信の書き込み待ち
  };
  // テーブル名 → キャッシュキー
  const TABLE_KEY = { events: KEYS.events, routine: KEYS.routine, meds: KEYS.meds };

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function nowISO() { return new Date().toISOString(); }
  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? clone(fallback) : JSON.parse(raw);
    } catch (e) { console.warn('[store] read failed', key, e); return clone(fallback); }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { console.error('[store] write failed', key, e); }
  }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function stripMeta(row) { const { household, updated_at, ...rest } = row; return rest; }
  function upsertArr(key, row) {
    const list = read(key, []); const i = list.findIndex((x) => x.id === row.id);
    if (i < 0) list.push(row); else list[i] = row; write(key, list);
  }
  function removeArr(key, id) { write(key, read(key, []).filter((x) => x.id !== id)); }

  // ---- 既定値 ----
  const DEFAULT_SETTINGS = {
    name: 'ハンナ', breed: 'トイプードル', sex: 'female',
    birthday: '2026-04-19', arrival: '2026-07-03',
    reminders: { routine: true, toilet: true, toiletIntervalMin: 120, quietStart: '22:00', quietEnd: '07:00' },
  };
  const DEFAULT_ROUTINE = [
    { time: '07:00', title: '起床・トイレ', kind: 'toilet' },
    { time: '07:30', title: '朝ごはん',     kind: 'meal' },
    { time: '08:00', title: '遊び・トイレ', kind: 'play' },
    { time: '09:30', title: 'お昼寝',       kind: 'sleep' },
    { time: '12:00', title: '昼ごはん',     kind: 'meal' },
    { time: '12:30', title: '遊び・トイレ', kind: 'play' },
    { time: '13:30', title: 'お昼寝',       kind: 'sleep' },
    { time: '16:00', title: '遊び・トイレ', kind: 'play' },
    { time: '17:30', title: '夜ごはん',     kind: 'meal' },
    { time: '18:00', title: '遊び・トイレ', kind: 'play' },
    { time: '21:30', title: '寝る前トイレ', kind: 'toilet' },
    { time: '22:00', title: '就寝',         kind: 'sleep' },
  ].map((r) => ({ id: uid(), ...r }));
  const DEFAULT_MEDS = [];

  // ============================================================
  // クラウド同期エンジン
  // ============================================================
  let sb = null;            // Supabase クライアント
  let cfg = null;           // {url, anonKey, household}
  let channel = null;
  let status = 'local';     // local | connecting | online | offline
  const changeCbs = [];
  const statusCbs = [];

  function setStatus(s) { status = s; statusCbs.forEach((cb) => { try { cb(s); } catch (e) {} }); }
  function emitChange() { changeCbs.forEach((cb) => { try { cb(); } catch (e) {} }); }

  function hasSDK() { return !!(global.supabase && global.supabase.createClient); }

  function makeClient() {
    return global.supabase.createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: false },
      realtime: { params: { eventsPerSecond: 5 } },
    });
  }

  // ---- outbox（未送信キュー）----
  function enqueue(op) {
    const o = read(KEYS.outbox, []); o.push(op); write(KEYS.outbox, o);
  }
  async function flush() {
    if (!sb) return;
    let pending = read(KEYS.outbox, []);
    if (!pending.length) { return; }
    const remain = [];
    for (const op of pending) {
      try { await applyRemote(op); }
      catch (e) { console.warn('[store] sync retry later', e); remain.push(op); }
    }
    write(KEYS.outbox, remain);
    setStatus(remain.length ? 'offline' : 'online');
  }
  async function applyRemote(op) {
    if (op.op === 'upsert') {
      const { error } = await sb.from(op.table).upsert(op.row);
      if (error) throw error;
    } else if (op.op === 'delete') {
      const { error } = await sb.from(op.table).delete().eq('id', op.id).eq('household', cfg.household);
      if (error) throw error;
    }
  }
  // 書き込み: キャッシュは呼び出し側で更新済み。クラウド分を queue して送信を試みる。
  function queueUpsert(table, row) {
    if (!cfg) return;
    enqueue({ op: 'upsert', table, row: { ...row, household: cfg.household, updated_at: nowISO() } });
    flush();
  }
  function queueDelete(table, id) {
    if (!cfg) return;
    enqueue({ op: 'delete', table, id });
    flush();
  }

  // ---- 取得＆マージ ----
  async function pull(replace) {
    // replace=true: 参加時。ローカルをクラウドで置き換える。
    // replace=false: 通常接続。union（クラウド＋未送信のローカル）。
    const h = cfg.household;
    for (const [table, key] of Object.entries(TABLE_KEY)) {
      const { data, error } = await sb.from(table).select('*').eq('household', h);
      if (error) throw error;
      const remote = (data || []).map(stripMeta);
      if (replace) { write(key, remote); continue; }
      const pendingIds = new Set(
        read(KEYS.outbox, []).filter((o) => o.table === table && o.op === 'upsert').map((o) => o.row.id)
      );
      const map = new Map(remote.map((r) => [r.id, r]));
      read(key, []).forEach((c) => { if (pendingIds.has(c.id)) map.set(c.id, c); });
      write(key, [...map.values()]);
    }
    // settings（1行）
    const { data: srow } = await sb.from('settings').select('*').eq('household', h).maybeSingle();
    const pendingSettings = read(KEYS.outbox, []).some((o) => o.table === 'settings');
    if (srow && srow.data && (replace || !pendingSettings)) write(KEYS.settings, srow.data);
    emitChange();
  }

  // ---- ローカル全データをクラウドへ（オーナー新規作成時）----
  function pushAllLocal() {
    const h = cfg.household;
    read(KEYS.events, []).forEach((r) => enqueue({ op: 'upsert', table: 'events', row: { ...r, household: h, updated_at: nowISO() } }));
    read(KEYS.routine, []).forEach((r) => enqueue({ op: 'upsert', table: 'routine', row: { ...r, household: h, updated_at: nowISO() } }));
    read(KEYS.meds, []).forEach((r) => enqueue({ op: 'upsert', table: 'meds', row: { ...r, household: h, updated_at: nowISO() } }));
    enqueue({ op: 'upsert', table: 'settings', row: { household: h, data: Store.getSettings(), updated_at: nowISO() } });
  }

  // ---- リアルタイム購読 ----
  function subscribe() {
    const h = cfg.household;
    if (channel) { try { sb.removeChannel(channel); } catch (e) {} }
    channel = sb.channel('hanna-' + h);
    for (const [table, key] of Object.entries(TABLE_KEY)) {
      channel.on('postgres_changes',
        { event: '*', schema: 'public', table, filter: `household=eq.${h}` },
        (p) => {
          if (p.eventType === 'DELETE') removeArr(key, p.old.id);
          else upsertArr(key, stripMeta(p.new));
          emitChange();
        });
    }
    channel.on('postgres_changes',
      { event: '*', schema: 'public', table: 'settings', filter: `household=eq.${h}` },
      (p) => { if (p.new && p.new.data) { write(KEYS.settings, p.new.data); emitChange(); } });
    channel.subscribe((st) => { if (st === 'SUBSCRIBED') setStatus('online'); });
  }

  // ============================================================
  // 公開API
  // ============================================================
  const Store = {
    KEYS, uid,

    // ---- ライフサイクル ----
    onChange(cb) { changeCbs.push(cb); },
    onStatus(cb) { statusCbs.push(cb); cb(status); },
    getStatus() { return status; },

    // 起動時: 設定済みならクラウド接続（失敗してもキャッシュで動く）
    async init() {
      cfg = read(KEYS.cloud, null);
      if (!cfg) { setStatus('local'); return; }
      if (!hasSDK()) { setStatus('offline'); return; }
      setStatus('connecting');
      try {
        sb = makeClient();
        await flush();
        await pull(false);
        subscribe();
        setStatus('online');
      } catch (e) { console.warn('[store] cloud init failed', e); setStatus('offline'); }
    },

    cloud: {
      isConfigured() { return !!cfg; },
      getConfig() { return cfg ? { ...cfg } : null; },

      // オーナーが新規に共有を開始（コード自動生成→ローカル記録をアップ）
      async create(url, anonKey) {
        if (!hasSDK()) throw new Error('ネット接続が必要です（Supabaseライブラリ未読込）');
        const household = 'h-' + uid() + uid();
        cfg = { url: String(url).trim().replace(/\/+$/, ''), anonKey: String(anonKey).trim(), household };
        write(KEYS.cloud, cfg);
        setStatus('connecting');
        sb = makeClient();
        pushAllLocal();
        await flush();
        await pull(false);
        subscribe();
        setStatus('online');
        return cfg;
      },

      // 家族が共有リンク/コードで参加（ローカルをクラウドで置き換え）
      async join(url, anonKey, household) {
        if (!hasSDK()) throw new Error('ネット接続が必要です（Supabaseライブラリ未読込）');
        cfg = { url: String(url).trim().replace(/\/+$/, ''), anonKey: String(anonKey).trim(), household: String(household).trim() };
        write(KEYS.cloud, cfg);
        setStatus('connecting');
        sb = makeClient();
        await flush();          // 念のため未送信があれば送る
        await pull(true);       // 置き換え
        subscribe();
        setStatus('online');
        return cfg;
      },

      // 共有リンクを生成（接続情報をURLハッシュに埋め込む）
      shareLink() {
        if (!cfg) return '';
        const payload = btoa(unescape(encodeURIComponent(JSON.stringify(cfg))));
        const base = location.origin + location.pathname;
        return base + '#join=' + payload;
      },
      decodeLink(payload) {
        return JSON.parse(decodeURIComponent(escape(atob(payload))));
      },

      // 共有を解除（ローカルモードに戻す。記録は端末に残る）
      disconnect() {
        if (channel && sb) { try { sb.removeChannel(channel); } catch (e) {} }
        channel = null; sb = null; cfg = null;
        localStorage.removeItem(KEYS.cloud);
        localStorage.removeItem(KEYS.outbox);
        setStatus('local');
      },
      pendingCount() { return read(KEYS.outbox, []).length; },
    },

    // ---- 設定 ----
    getSettings() {
      const s = read(KEYS.settings, DEFAULT_SETTINGS);
      return Object.assign(clone(DEFAULT_SETTINGS), s, {
        reminders: Object.assign(clone(DEFAULT_SETTINGS.reminders), s.reminders || {}),
      });
    },
    saveSettings(s) {
      write(KEYS.settings, s);
      if (cfg) queueUpsert('settings', { household: cfg.household, data: s });
      return s;
    },

    // ---- ルーティン ----
    getRoutine() {
      const r = read(KEYS.routine, DEFAULT_ROUTINE);
      // 初回（既定値）のときも保存しておく（クラウド作成時に拾えるように）
      if (localStorage.getItem(KEYS.routine) == null) write(KEYS.routine, r);
      return [...r].sort((a, b) => a.time.localeCompare(b.time));
    },
    saveRoutine(list) {
      const prev = read(KEYS.routine, []);
      write(KEYS.routine, list);
      if (cfg) {
        const ids = new Set(list.map((x) => x.id));
        list.forEach((r) => queueUpsert('routine', r));
        prev.forEach((p) => { if (!ids.has(p.id)) queueDelete('routine', p.id); });
      }
      return list;
    },

    // ---- 薬・サプリ ----
    getMeds() { return read(KEYS.meds, DEFAULT_MEDS); },
    saveMeds(list) {
      const prev = read(KEYS.meds, []);
      write(KEYS.meds, list);
      if (cfg) {
        const ids = new Set(list.map((x) => x.id));
        list.forEach((m) => queueUpsert('meds', m));
        prev.forEach((p) => { if (!ids.has(p.id)) queueDelete('meds', p.id); });
      }
      return list;
    },
    addMed(name, note) {
      const meds = Store.getMeds();
      const med = { id: uid(), name: name.trim(), note: (note || '').trim() };
      meds.push(med); Store.saveMeds(meds); return med;
    },
    deleteMed(id) { Store.saveMeds(Store.getMeds().filter((m) => m.id !== id)); },

    // ---- 記録(イベント) ----
    getEvents() { return read(KEYS.events, []).sort((a, b) => b.ts - a.ts); },
    addEvent(ev) {
      const full = { id: uid(), ts: ev.ts || Date.now(), type: ev.type, note: ev.note || '', data: ev.data || {} };
      upsertArr(KEYS.events, full);
      queueUpsert('events', full);
      return full;
    },
    updateEvent(id, patch) {
      const list = read(KEYS.events, []);
      const i = list.findIndex((e) => e.id === id);
      if (i < 0) return null;
      list[i] = Object.assign({}, list[i], patch, { data: Object.assign({}, list[i].data, patch.data || {}) });
      write(KEYS.events, list);
      queueUpsert('events', list[i]);
      return list[i];
    },
    deleteEvent(id) {
      removeArr(KEYS.events, id);
      queueDelete('events', id);
    },
    lastOf(type) { return Store.getEvents().find((e) => e.type === type) || null; },

    // ---- 通知メモ ----
    getNotifyState() { return read(KEYS.notify, {}); },
    saveNotifyState(s) { write(KEYS.notify, s); },

    // ---- バックアップ ----
    exportAll() {
      return {
        exportedAt: nowISO(), app: 'hanna', version: 2,
        settings: Store.getSettings(), routine: Store.getRoutine(),
        meds: Store.getMeds(), events: Store.getEvents(),
      };
    },
    importAll(obj) {
      if (!obj || obj.app !== 'hanna') throw new Error('ハンナのバックアップファイルではありません');
      if (obj.settings) Store.saveSettings(obj.settings);
      if (obj.routine) Store.saveRoutine(obj.routine);
      if (obj.meds) Store.saveMeds(obj.meds);
      if (obj.events) {
        write(KEYS.events, obj.events);
        if (cfg) obj.events.forEach((e) => queueUpsert('events', e));
      }
    },
  };

  global.Store = Store;
})(window);
