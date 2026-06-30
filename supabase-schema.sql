-- ============================================================
-- ハンナ お世話手帳 — 家族共有スキーマ
-- Supabase の「SQL Editor」に貼り付けて「Run」するだけ。
-- 何度実行しても安全（再実行OK）。
-- ============================================================

-- ---- テーブル ----
create table if not exists events (
  id         text primary key,
  household  text not null,
  ts         bigint not null,
  type       text not null,
  note       text default '',
  data       jsonb default '{}'::jsonb,
  updated_at timestamptz default now()
);
create index if not exists events_household_idx on events (household);

create table if not exists routine (
  id         text primary key,
  household  text not null,
  time       text not null,
  title      text not null,
  kind       text default 'other',
  updated_at timestamptz default now()
);
create index if not exists routine_household_idx on routine (household);

create table if not exists meds (
  id         text primary key,
  household  text not null,
  name       text not null,
  note       text default '',
  updated_at timestamptz default now()
);
create index if not exists meds_household_idx on meds (household);

create table if not exists settings (
  household  text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

-- ---- RLS（行レベルセキュリティ）----
-- 匿名キーでの読み書きを許可。世帯コード(household)でアプリ側がスコープする。
-- ※ 接続情報は家族にだけ共有リンクで配る前提。子犬の記録向けの軽い保護。
--    より強固にしたい場合は後でメール認証(Supabase Auth)に置き換え可能。
alter table events   enable row level security;
alter table routine  enable row level security;
alter table meds     enable row level security;
alter table settings enable row level security;

drop policy if exists anon_all on events;
drop policy if exists anon_all on routine;
drop policy if exists anon_all on meds;
drop policy if exists anon_all on settings;

create policy anon_all on events   for all to anon using (true) with check (true);
create policy anon_all on routine  for all to anon using (true) with check (true);
create policy anon_all on meds     for all to anon using (true) with check (true);
create policy anon_all on settings for all to anon using (true) with check (true);

-- ---- リアルタイム配信を有効化（再実行しても重複追加しない）----
do $$
declare t text;
begin
  foreach t in array array['events','routine','meds','settings'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end $$;
