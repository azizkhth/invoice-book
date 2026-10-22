/* =========================================================
   دفتر الفواتير — طبقة البيانات (Data Layer)
   الوضع الافتراضي: قاعدة بيانات محلية localStorage
   (اختياري) ربط Supabase مع عزل عبر RLS: user_id = auth.uid()
========================================================= */
'use strict';

const DB = (() => {
  // ---------- مفاتيح التخزين المحلي ----------
  const K_USERS = 'ib_users';        // سجل المستخدمين المحليين
  const K_SESSION = 'ib_session';    // معرف المستخدم الحالي (محلي)
  const K_SBX = 'ib_supabase_cfg';   // إعدادات ربط Supabase
  const invKeyOf = (uid) => `ib_invoices_${uid}`; // فواتير كل مستخدم بمفتاح مستقل

  let sbx = null;            // عميل Supabase عند الربط
  let sbxCfg = null;         // { url, key }
  let currentUser = null;    // { id, name, email }

  // ---------- أدوات ----------
  const readJSON = (key, fallback) => {
    try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
  };
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));

  // هاش كلمة المرور (SHA-256) — للتعليم، ليس بديلاً عن مصادقة حقيقية
  async function hash(text) {
    if (crypto?.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    let h1 = 5381, h2 = 52711; // بديل بسيط للسياقات غير الآمنة
    for (const ch of text) { const x = ch.codePointAt(0); h1 = ((h1 * 33) ^ x) >>> 0; h2 = ((h2 * 31) ^ x) >>> 0; }
    return 's' + h1.toString(16) + h2.toString(16);
  }

  // ---------- ترجمة أخطاء Supabase للعربية ----------
  function sbxError(err) {
    const m = String(err?.message || err || '');
    if (/Invalid login credentials/i.test(m)) return 'البريد الإلكتروني أو كلمة المرور غير صحيحة';
    if (/already registered|already exists/i.test(m)) return 'هذا البريد مسجل مسبقًا — جرّب تسجيل الدخول';
    if (/not confirmed/i.test(m)) return 'لم يتم تأكيد البريد الإلكتروني بعد (عطّل تأكيد البريد في إعدادات Supabase للتجربة)';
    if (/Failed to fetch|fetch/i.test(m)) return 'تعذر الاتصال بـ Supabase — تحقق من الإنترنت ومن رابط المشروع';
    return 'خطأ من Supabase: ' + m;
  }

  // =============== الوضع المحلي ===============
  const local = {
    async signUp({ name, email, password }) {
      const users = readJSON(K_USERS, []);
      if (users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
        throw new Error('هذا البريد مسجل مسبقًا — جرّب تسجيل الدخول');
      }
      const user = { id: uid(), name, email, passHash: await hash(password), createdAt: Date.now() };
      users.push(user);
      localStorage.setItem(K_USERS, JSON.stringify(users));
      localStorage.setItem(K_SESSION, user.id);
      currentUser = { id: user.id, name: user.name, email: user.email };
      return { needsConfirm: false, user: currentUser };
    },
    async signIn(email, password) {
      const users = readJSON(K_USERS, []);
      const user = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
      if (!user || user.passHash !== (await hash(password))) {
        throw new Error('البريد الإلكتروني أو كلمة المرور غير صحيحة');
      }
      localStorage.setItem(K_SESSION, user.id);
      currentUser = { id: user.id, name: user.name, email: user.email };
      return currentUser;
    },
    async signOut() {
      localStorage.removeItem(K_SESSION);
      currentUser = null;
    },
    async currentUser() {
      const id = localStorage.getItem(K_SESSION);
      if (!id) return null;
      const user = readJSON(K_USERS, []).find((u) => u.id === id);
      if (!user) { localStorage.removeItem(K_SESSION); return null; }
      currentUser = { id: user.id, name: user.name, email: user.email };
      return currentUser;
    },
    async list() {
      return readJSON(invKeyOf(currentUser.id), []).map((i) => ({ ...i, amount: Number(i.amount) }));
    },
    async add({ name, number, amount }) {
      const list = readJSON(invKeyOf(currentUser.id), []);
      const row = { id: uid(), name, number, amount: Number(amount), created_at: Date.now() };
      list.push(row);
      localStorage.setItem(invKeyOf(currentUser.id), JSON.stringify(list));
      return row;
    },
    async update(id, patch) {
      const list = readJSON(invKeyOf(currentUser.id), []);
      const row = list.find((i) => i.id === id);
      if (row) { Object.assign(row, patch, { updated_at: Date.now() }); localStorage.setItem(invKeyOf(currentUser.id), JSON.stringify(list)); }
      return row;
    },
    async remove(id) {
      const list = readJSON(invKeyOf(currentUser.id), []).filter((i) => i.id !== id);
      localStorage.setItem(invKeyOf(currentUser.id), JSON.stringify(list));
    },
  };

  // =============== وضع Supabase (مع RLS) ===============
  const supabase = {
    async signUp({ name, email, password }) {
      const { data, error } = await sbx.auth.signUp({
        email, password,
        options: { data: { name }, emailRedirectTo: location.href },
      });
      if (error) throw new Error(sbxError(error));
      const needsConfirm = !data.session; // قد يتطلب المشروع تأكيد البريد أولًا
      if (data.session) await supabase.loadUser();
      return { needsConfirm, user: currentUser };
    },
    async signIn(email, password) {
      const { error } = await sbx.auth.signInWithPassword({ email, password });
      if (error) throw new Error(sbxError(error));
      await supabase.loadUser();
      return currentUser;
    },
    async loadUser() {
      const { data } = await sbx.auth.getSession();
      const u = data?.session?.user;
      if (!u) { currentUser = null; return null; }
      currentUser = { id: u.id, name: u.user_metadata?.name || u.email, email: u.email };
      return currentUser;
    },
    async signOut() { await sbx.auth.signOut(); currentUser = null; },
    async currentUser() { return supabase.loadUser(); },
    async list() {
      const { data, error } = await sbx.from('invoices').select('*').order('created_at', { ascending: false });
      if (error) throw new Error(sbxError(error));
      return (data || []).map((r) => ({ id: r.id, name: r.name, number: r.number, amount: Number(r.amount), created_at: new Date(r.created_at).getTime() }));
    },
    async add(inv) {
      const { data, error } = await sbx.from('invoices').insert([{ name: inv.name, number: inv.number, amount: Number(inv.amount) }]).select().single();
      if (error) throw new Error(sbxError(error));
      return { id: data.id, name: data.name, number: data.number, amount: Number(data.amount), created_at: new Date(data.created_at).getTime() };
    },
    async update(id, patch) {
      const p = {}; if ('name' in patch) p.name = patch.name; if ('number' in patch) p.number = patch.number; if ('amount' in patch) p.amount = Number(patch.amount);
      const { error } = await sbx.from('invoices').update(p).eq('id', id);
      if (error) throw new Error(sbxError(error));
    },
    async remove(id) {
      const { error } = await sbx.from('invoices').delete().eq('id', id);
      if (error) throw new Error(sbxError(error));
    },
  };

  // =============== الواجهة العامة ===============
  return {
    mode: () => (sbxCfg ? 'supabase' : 'local'),

    async init() {
      sbxCfg = readJSON(K_SBX, null);
      if (sbxCfg?.url && sbxCfg?.key && window.supabase?.createClient) {
        try { sbx = window.supabase.createClient(sbxCfg.url, sbxCfg.key); }
        catch { sbx = null; sbxCfg = null; }
      } else if (sbxCfg && !window.supabase?.createClient) {
        sbxCfg = null; // تعذر تحميل المكتبة
      }
      const backend = this.mode() === 'supabase' ? supabase : local;
      try { await backend.currentUser(); } catch { currentUser = null; }
      return currentUser;
    },

    backend: () => (sbxCfg ? supabase : local),
    cfg: () => sbxCfg,

    async saveCfg(url, key) {
      url = (url || '').trim(); key = (key || '').trim();
      if (!/^https:\/\/.+\.supabase\.(co|in)/.test(url)) throw new Error('رابط المشروع غير صالح (يجب أن يكون بصيغة https://xxxx.supabase.co)');
      if (!key || key.length < 20) throw new Error('مفتاح anon غير صالح');
      if (!window.supabase?.createClient) throw new Error('تعذر تحميل مكتبة Supabase — تحقق من الاتصال بالإنترنت');
      sbx = window.supabase.createClient(url, key);
      // اختبار سريع للاتصال
      const { error } = await sbx.from('invoices').select('id').limit(1);
      if (error) throw new Error(sbxError(error) + ' — تأكد من تنفيذ ملف supabase/schema.sql');
      sbxCfg = { url, key };
      localStorage.setItem(K_SBX, JSON.stringify(sbxCfg));
    },

    clearCfg() {
      sbxCfg = null; sbx = null;
      localStorage.removeItem(K_SBX);
    },

    // ---- عمليات موحّدة تُمرَّر للخلفية النشطة ----
    async signUp(info) { return this.backend().signUp(info); },
    async signIn(email, pass) { return this.backend().signIn(email, pass); },
    async signOut() { return this.backend().signOut(); },
    async currentUser() { return currentUser; },
    async listInvoices() { return this.backend().list(); },
    async addInvoice(inv) { return this.backend().add(inv); },
    async updateInvoice(id, patch) { return this.backend().update(id, patch); },
    async deleteInvoice(id) { return this.backend().remove(id); },

    // ---- بيانات الحساب التجريبي (الوضع المحلي فقط) ----
    async seedDemo() {
      if (this.mode() !== 'local') return;
      let user = readJSON(K_USERS, []).find((u) => u.email === 'demo@invoices.app');
      if (!user) {
        user = { id: uid(), name: 'مستخدم تجريبي', email: 'demo@invoices.app', passHash: await hash('123456'), createdAt: Date.now() };
        const users = readJSON(K_USERS, []);
        users.push(user);
        localStorage.setItem(K_USERS, JSON.stringify(users));
      }
      if (readJSON(invKeyOf(user.id), []).length === 0) {
        const mk = (monthsAgo, name, number, amount) => {
          const d = new Date(); d.setMonth(d.getMonth() - monthsAgo);
          return { id: uid(), name, number, amount, created_at: d.getTime() };
        };
        const samples = [
          mk(0, 'فاتورة كهرباء', 'ELC-1042', 8450),
          mk(0, 'فاتورة ماء', 'WTR-2087', 2210),
          mk(1, 'اشتراك إنترنت', 'NET-3312', 3500),
          mk(1, 'فاتورة زبون — متجر الوفاء', 'INV-2201', 127500),
          mk(2, 'فاتورة زبون — محل النور', 'INV-2156', 89250),
          mk(3, 'فاتورة صيانة دورية', 'SRV-2011', 15200),
          mk(4, 'فاتورة زبون — شركة الرحال', 'INV-2089', 54600),
          mk(5, 'اشتراك إنترنت', 'NET-2210', 3500),
        ];
        localStorage.setItem(invKeyOf(user.id), JSON.stringify(samples));
      }
      localStorage.setItem(K_SESSION, user.id);
      currentUser = { id: user.id, name: user.name, email: user.email };
      return currentUser;
    },
  };
})();
