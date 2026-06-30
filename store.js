/* store.js — ハンナ用データ層
 *
 * 役割: 記録(イベント)・ルーティン・設定・薬リストの保存と取り出し。
 * 現在の保存先: この端末の localStorage（=端末ごとに独立。家族共有はまだ無し）。
 *
 * 【将来クラウド共有にするとき】
 *  Store の各メソッド(getEvents / addEvent ...)の中身を Supabase 等の呼び出しに
 *  差し替えるだけで、画面側(app.js)は基本そのまま動くように分離してある。
 */
(function (global) {
  'use strict';

  const KEYS = {
    events: 'hanna.events.v1',
    routine: 'hanna.routine.v1',
    settings: 'hanna.settings.v1',
    meds: 'hanna.meds.v1',
    notify: 'hanna.notify.v1',
  };

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? clone(fallback) : JSON.parse(raw);
    } catch (e) {
      console.warn('[store] read failed', key, e);
      return clone(fallback);
    }
  }
  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.error('[store] write failed', key, e);
    }
  }
  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  // ---- 既定値 ----
  const DEFAULT_SETTINGS = {
    name: 'ハンナ',
    breed: 'トイプードル',
    sex: 'female',
    birthday: '2026-04-19',
    arrival: '2026-07-03',
    reminders: {
      routine: true,        // ルーティン時刻に通知
      toilet: true,         // トイレ間隔が空いたら通知
      toiletIntervalMin: 120, // 何分空いたら知らせるか
      quietStart: '22:00',  // この時間帯はトイレ通知を止める
      quietEnd: '07:00',
    },
  };

  // 生後約2.5ヶ月のトイプードル向け初期テンプレ（あとから編集可）
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

  const DEFAULT_MEDS = []; // 例: { id, name:'フィラリア予防', note:'月1回' }

  const Store = {
    KEYS,
    uid,

    // ---- 設定 ----
    getSettings() {
      const s = read(KEYS.settings, DEFAULT_SETTINGS);
      // 既定値とマージ（項目追加に強くする）
      return Object.assign(clone(DEFAULT_SETTINGS), s, {
        reminders: Object.assign(clone(DEFAULT_SETTINGS.reminders), s.reminders || {}),
      });
    },
    saveSettings(s) {
      write(KEYS.settings, s);
      return s;
    },

    // ---- ルーティン ----
    getRoutine() {
      const r = read(KEYS.routine, DEFAULT_ROUTINE);
      return [...r].sort((a, b) => a.time.localeCompare(b.time));
    },
    saveRoutine(list) {
      write(KEYS.routine, list);
      return list;
    },

    // ---- 薬・サプリ マスタ ----
    getMeds() {
      return read(KEYS.meds, DEFAULT_MEDS);
    },
    saveMeds(list) {
      write(KEYS.meds, list);
      return list;
    },
    addMed(name, note) {
      const meds = Store.getMeds();
      const med = { id: uid(), name: name.trim(), note: (note || '').trim() };
      meds.push(med);
      Store.saveMeds(meds);
      return med;
    },
    deleteMed(id) {
      Store.saveMeds(Store.getMeds().filter((m) => m.id !== id));
    },

    // ---- 記録(イベント) ----
    // ev: { type, ts(ms), note, data:{} }
    getEvents() {
      const list = read(KEYS.events, []);
      return list.sort((a, b) => b.ts - a.ts); // 新しい順
    },
    addEvent(ev) {
      const list = read(KEYS.events, []);
      const full = {
        id: uid(),
        ts: ev.ts || Date.now(),
        type: ev.type,
        note: ev.note || '',
        data: ev.data || {},
      };
      list.push(full);
      write(KEYS.events, list);
      return full;
    },
    updateEvent(id, patch) {
      const list = read(KEYS.events, []);
      const i = list.findIndex((e) => e.id === id);
      if (i < 0) return null;
      list[i] = Object.assign({}, list[i], patch, {
        data: Object.assign({}, list[i].data, patch.data || {}),
      });
      write(KEYS.events, list);
      return list[i];
    },
    deleteEvent(id) {
      write(KEYS.events, read(KEYS.events, []).filter((e) => e.id !== id));
    },

    // 指定タイプの最新イベント
    lastOf(type) {
      return Store.getEvents().find((e) => e.type === type) || null;
    },

    // ---- 通知の重複防止メモ ----
    getNotifyState() {
      return read(KEYS.notify, {});
    },
    saveNotifyState(s) {
      write(KEYS.notify, s);
    },

    // ---- バックアップ ----
    exportAll() {
      return {
        exportedAt: new Date().toISOString(),
        app: 'hanna',
        version: 1,
        settings: Store.getSettings(),
        routine: Store.getRoutine(),
        meds: Store.getMeds(),
        events: Store.getEvents(),
      };
    },
    importAll(obj) {
      if (!obj || obj.app !== 'hanna') throw new Error('ハンナのバックアップファイルではありません');
      if (obj.settings) write(KEYS.settings, obj.settings);
      if (obj.routine) write(KEYS.routine, obj.routine);
      if (obj.meds) write(KEYS.meds, obj.meds);
      if (obj.events) write(KEYS.events, obj.events);
    },
  };

  global.Store = Store;
})(window);
