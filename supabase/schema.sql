-- =========================================================
-- دفتر الفواتير — مخطط Supabase مع عزل المستخدمين عبر RLS
-- نفّذ هذا الملف كاملًا من: Supabase Dashboard → SQL Editor
-- =========================================================

-- 1) جدول الفواتير: كل صف مرتبط تلقائيًا بالمستخدم صاحبه
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  name text not null,
  number text not null,
  amount numeric not null check (amount > 0),
  inv_date date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

-- إن أنشأت الجدول قبل إضافة عمود التاريخ، نفّذ هذا السطر فقط:
-- alter table public.invoices add column if not exists inv_date date not null default current_date;

-- 2) تفعيل حماية الصفوف (RLS) — هذا هو اشتراط الورشة
alter table public.invoices enable row level security;

-- 3) السياسات: المستخدم يرى ويعدّل بياناته هو فقط
drop policy if exists "select own" on public.invoices;
create policy "select own" on public.invoices
  for select using (auth.uid() = user_id);

drop policy if exists "insert own" on public.invoices;
create policy "insert own" on public.invoices
  for insert with check (auth.uid() = user_id);

drop policy if exists "update own" on public.invoices;
create policy "update own" on public.invoices
  for update using (auth.uid() = user_id);

drop policy if exists "delete own" on public.invoices;
create policy "delete own" on public.invoices
  for delete using (auth.uid() = user_id);

-- 4) منع تكرار رقم الفاتورة لنفس المستخدم (فهرس فريد جزئي)
create unique index if not exists invoices_user_number_uidx
  on public.invoices (user_id, number);
