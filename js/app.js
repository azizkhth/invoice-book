/* =========================================================
   دفتر الفواتير — منطق الواجهة
========================================================= */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls = '', text = '') => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};

// ---------- التنسيقات ----------
const LOC = 'ar-u-nu-latn';
const fmtN = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const money = (n) => fmtN.format(Number(n) || 0);
const fmtC = new Intl.NumberFormat(LOC, { notation: 'compact', maximumFractionDigits: 1 });
const fmtDate = new Intl.DateTimeFormat(LOC, { dateStyle: 'medium' });
const fmtMonth = new Intl.DateTimeFormat(LOC, { month: 'long' });
const isoDate = (ms) => {
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const invDateOf = (i) => i.inv_date ?? i.created_at; // تاريخ الفاتورة (البديل: تاريخ التسجيل)

let CURRENT = null;     // المستخدم الحالي
let EDITING = null;     // معرف الفاتورة قيد التعديل
let PENDING_DELETE = null;
let toastTimer = null;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
const showErr = (node, msg) => { node.textContent = msg; node.hidden = false; };

// ---------- المظهر (ليلي/نهاري) ----------
function applyThemeIcon() {
  $('#themeBtn').textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙';
}
function toggleTheme() {
  const dark = document.documentElement.getAttribute('data-theme') !== 'dark';
  if (dark) document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('ib_theme', dark ? 'dark' : 'light'); } catch (e) {}
  applyThemeIcon();
}

// ---------- شارة الوضع ----------
function updateModeBadges() {
  const isSbx = DB.mode() === 'supabase';
  const txt = isSbx ? '🔌 Supabase + RLS' : '💾 قاعدة بيانات محلية (localStorage)';
  const short = isSbx ? '🔌 Supabase' : '💾 محلي';
  $('#modeBadge').textContent = txt;
  $('#modeBadgeApp').textContent = short;
  $('#demoBtn').hidden = isSbx;
  $('#authNote').textContent = isSbx
    ? '🔌 الوضع الحالي: Supabase — كل مستخدم يرى بياناته فقط بفضل سياسات RLS.'
    : '🔐 الوضع المحلي: البيانات تُحفظ داخل متصفحك فقط — لكل مستخدم مساحة مستقلة عن الآخرين.';
}

// ---------- العرض ----------
function renderStats(list) {
  $('#stCount').textContent = money(list.length);
  const total = list.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  $('#stTotal').textContent = money(total);
  let maxIt = null;
  for (const i of list) if (!maxIt || Number(i.amount) > Number(maxIt.amount)) maxIt = i;
  $('#stMax').textContent = maxIt ? money(maxIt.amount) : '—';
  $('#stMax').title = maxIt ? maxIt.name : '';
  const now = new Date();
  const monthCount = list.filter((i) => {
    const d = new Date(invDateOf(i));
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }).length;
  $('#stMonth').textContent = money(monthCount);
}

function renderChart(list) {
  const chart = $('#chart');
  chart.textContent = '';
  const now = new Date();
  const months = [];
  for (let k = 5; k >= 0; k--) months.push({ date: new Date(now.getFullYear(), now.getMonth() - k, 1), sum: 0 });
  for (const it of list) {
    const d = new Date(invDateOf(it));
    const m = months.find((m) => m.date.getFullYear() === d.getFullYear() && m.date.getMonth() === d.getMonth());
    if (m) m.sum += Number(it.amount) || 0;
  }
  const max = Math.max(...months.map((m) => m.sum));
  if (max <= 0) {
    const p = el('p', 'chart-empty', 'لا توجد مبالغ ضمن آخر 6 أشهر — أضف فاتورة لتظهر البيانات.');
    chart.appendChild(p);
    return;
  }
  for (const m of months) {
    const col = el('div', 'col');
    const area = el('div', 'area');
    const pct = Math.round((m.sum / max) * 100);
    const bar = el('div', 'bar' + (m.sum <= 0 ? ' zero' : ''));
    bar.style.setProperty('--h', pct + '%');
    bar.title = `${fmtMonth.format(m.date)}: ${money(m.sum)}`;
    const val = el('span', 'val', m.sum > 0 ? fmtC.format(m.sum) : '');
    val.style.setProperty('--h', pct + '%');
    const lbl = el('div', 'lbl', fmtMonth.format(m.date));
    area.append(bar, val);
    col.append(area, lbl);
    chart.append(col);
  }
}

function renderTable(all) {
  const q = $('#search').value.trim().toLowerCase();
  const rows = all
    .filter((i) => !q || i.name.toLowerCase().includes(q) || String(i.number).toLowerCase().includes(q))
    .sort((a, b) => invDateOf(b) - invDateOf(a));

  const tbody = $('#tbody');
  tbody.textContent = '';

  for (const it of rows) {
    const tr = document.createElement('tr');
    const tdName = el('td', '', it.name);
    const tdNum = el('td', 'num', it.number);
    const tdAmt = el('td', 'amount', money(it.amount));
    const tdDate = el('td');
    tdDate.appendChild(el('span', 'date', fmtDate.format(new Date(invDateOf(it)))));
    const tdAct = el('td');
    const wrap = el('div', 'row-actions');
    const editBtn = el('button', 'mini-btn edit', 'تعديل');
    editBtn.type = 'button';
    editBtn.dataset.act = 'edit';
    editBtn.dataset.id = it.id;
    const delBtn = el('button', 'mini-btn del', 'حذف');
    delBtn.type = 'button';
    delBtn.dataset.act = 'del';
    delBtn.dataset.id = it.id;
    wrap.append(editBtn, delBtn);
    tdAct.appendChild(wrap);
    tr.append(tdName, tdNum, tdAmt, tdDate, tdAct);
    tbody.appendChild(tr);
  }

  $('#invTable').hidden = rows.length === 0;
  $('#emptyState').hidden = rows.length > 0;
  $('#emptyAddBtn').hidden = all.length > 0;
  $('#emptyText').textContent = all.length === 0
    ? 'لا توجد فواتير بعد — أضف أول فاتورة الآن ✨'
    : 'لا نتائج مطابقة للبحث 🔍';
}

async function renderData() {
  if (!CURRENT) return;
  const list = await DB.listInvoices();
  renderStats(list);
  renderChart(list);
  renderTable(list);
}

async function render() {
  CURRENT = await DB.currentUser();
  updateModeBadges();
  if (!CURRENT) {
    $('#authView').hidden = false;
    $('#appView').hidden = true;
    return;
  }
  $('#authView').hidden = true;
  $('#appView').hidden = false;
  $('#greet').textContent = `أهلًا ${CURRENT.name} 👋`;
  $('#userChip').textContent = `${CURRENT.name} · ${CURRENT.email}`;
  $('#userChip').title = CURRENT.email;
  await renderData();
}

// ---------- نافذة الفاتورة ----------
function openDlg(inv) {
  EDITING = inv ? inv.id : null;
  $('#invDlgTitle').textContent = inv ? 'تعديل الفاتورة' : 'فاتورة جديدة';
  $('#fName').value = inv ? inv.name : '';
  $('#fNum').value = inv ? inv.number : '';
  $('#fDate').value = inv ? isoDate(invDateOf(inv)) : isoDate(Date.now());
  $('#fAmt').value = inv ? inv.amount : '';
  $('#dlgErr').hidden = true;
  $('#dlgErr').textContent = '';
  $('#invDlg').showModal();
  $('#fName').focus();
}

// ---------- التهيئة ----------
function wire() {
  applyThemeIcon();
  $('#year').textContent = new Date().getFullYear();
  $('#today').textContent = new Intl.DateTimeFormat(LOC, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date());

  $('#themeBtn').addEventListener('click', toggleTheme);

  // تبويبات الدخول
  const setTab = (loginActive) => {
    $('#tabLogin').classList.toggle('is-active', loginActive);
    $('#tabRegister').classList.toggle('is-active', !loginActive);
    $('#loginForm').hidden = !loginActive;
    $('#registerForm').hidden = loginActive;
    $('#loginErr').hidden = true;
    $('#regErr').hidden = true;
  };
  $('#tabLogin').addEventListener('click', () => setTab(true));
  $('#tabRegister').addEventListener('click', () => setTab(false));

  // تسجيل الدخول
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#loginErr');
    err.hidden = true;
    try {
      const user = await DB.signIn($('#liEmail').value.trim().toLowerCase(), $('#liPass').value);
      $('#loginForm').reset();
      await render();
      toast(`أهلًا بك ${user.name} 👋`);
    } catch (ex) { showErr(err, ex.message); }
  });

  // إنشاء حساب
  $('#registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#regErr');
    err.hidden = true;
    if ($('#rgPass').value !== $('#rgPass2').value) {
      showErr(err, 'كلمتا المرور غير متطابقتين');
      return;
    }
    try {
      const res = await DB.signUp({
        name: $('#rgName').value.trim(),
        email: $('#rgEmail').value.trim().toLowerCase(),
        password: $('#rgPass').value,
      });
      $('#registerForm').reset();
      if (res.needsConfirm) {
        setTab(true);
        toast('تم إنشاء الحساب — أكّد بريدك الإلكتروني ثم سجّل الدخول 📩');
      } else {
        await render();
        toast('تم إنشاء الحساب 🎉 ابدأ بإضافة فاتورتك الأولى');
      }
    } catch (ex) { showErr(err, ex.message); }
  });

  // حساب تجريبي
  $('#demoBtn').addEventListener('click', async () => {
    try {
      await DB.seedDemo();
      await render();
      toast('تم الدخول بالحساب التجريبي ✨');
    } catch (ex) { toast('تعذر تشغيل الحساب التجريبي: ' + ex.message); }
  });

  // خروج
  $('#logoutBtn').addEventListener('click', async () => {
    await DB.signOut();
    $('#search').value = '';
    await render();
    toast('تم تسجيل الخروج');
  });

  // إضافة فاتورة
  $('#addBtn').addEventListener('click', () => openDlg(null));
  $('#emptyAddBtn').addEventListener('click', () => openDlg(null));

  // بحث
  $('#search').addEventListener('input', () => renderData());

  // حفظ الفاتورة (إضافة/تعديل)
  $('#invForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#dlgErr');
    err.hidden = true;
    const name = $('#fName').value.trim();
    const number = $('#fNum').value.trim();
    const invDateMs = new Date($('#fDate').value + 'T00:00:00').getTime();
    const amount = parseFloat($('#fAmt').value);
    if (!name) return showErr(err, 'أدخل اسم الفاتورة');
    if (!number) return showErr(err, 'أدخل رقم الفاتورة');
    if (Number.isNaN(invDateMs)) return showErr(err, 'اختر تاريخ فاتورة صحيحًا');
    if (!(amount > 0)) return showErr(err, 'أدخل مبلغًا أكبر من صفر');

    try {
      const list = await DB.listInvoices();
      if (list.some((i) => i.number === number && i.id !== EDITING)) {
        return showErr(err, 'رقم الفاتورة مستخدم مسبقًا — جرّب رقمًا آخر');
      }
      if (EDITING) {
        await DB.updateInvoice(EDITING, { name, number, amount, inv_date: invDateMs });
        toast('تم تحديث الفاتورة ✅');
      } else {
        await DB.addInvoice({ name, number, amount, inv_date: invDateMs });
        toast('تمت إضافة الفاتورة ✅');
      }
      $('#invDlg').close();
      EDITING = null;
      await renderData();
    } catch (ex) { showErr(err, ex.message); }
  });
  $('#dlgCancel').addEventListener('click', () => { $('#invDlg').close(); EDITING = null; });

  // إجراءات الصفوف
  $('#tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn || !CURRENT) return;
    const id = btn.dataset.id;
    const list = await DB.listInvoices();
    const it = list.find((i) => i.id === id);
    if (!it) return;
    if (btn.dataset.act === 'edit') {
      openDlg(it);
    } else {
      PENDING_DELETE = id;
      $('#confirmMsg').textContent = `هل أنت متأكد من حذف الفاتورة «${it.name}» رقم ${it.number}؟ لا يمكن التراجع.`;
      $('#confirmDlg').showModal();
    }
  });
  $('#confirmYes').addEventListener('click', async () => {
    $('#confirmDlg').close();
    if (PENDING_DELETE) {
      try {
        await DB.deleteInvoice(PENDING_DELETE);
        toast('تم حذف الفاتورة 🗑️');
      } catch (ex) { toast(ex.message); }
      PENDING_DELETE = null;
      await renderData();
    }
  });
  $('#confirmNo').addEventListener('click', () => { $('#confirmDlg').close(); PENDING_DELETE = null; });

  // ربط Supabase
  const sbxDlg = $('#sbxDlg');
  const openSbx = () => {
    const cfg = DB.cfg();
    $('#sbxUrl').value = cfg ? cfg.url : '';
    $('#sbxKey').value = cfg ? cfg.key : '';
    $('#sbxErr').hidden = true;
    sbxDlg.showModal();
  };
  $('#sbxBtn').addEventListener('click', openSbx);
  $('#modeBadgeApp').addEventListener('click', openSbx);
  $('#sbxCancel').addEventListener('click', () => sbxDlg.close());
  $('#sbxRemove').addEventListener('click', () => {
    DB.clearCfg();
    sbxDlg.close();
    toast('تمت إزالة الربط — العودة إلى القاعدة المحلية 💾');
  });
  $('#sbxSave').addEventListener('click', async () => {
    const err = $('#sbxErr');
    err.hidden = true;
    try {
      await DB.saveCfg($('#sbxUrl').value, $('#sbxKey').value);
      sbxDlg.close();
      toast('تم الربط بـ Supabase 🔌 — سجّل الدخول الآن');
      await render();
    } catch (ex) { showErr(err, ex.message); }
  });
}

(async function init() {
  wire();
  await DB.init();
  await render();
})();
