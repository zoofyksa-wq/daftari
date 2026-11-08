import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, sendEmailVerification, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const $ = (id) => document.getElementById(id);

/* ---------- setup check ---------- */
if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith('PASTE')) {
  $('setupView').hidden = false;
  throw new Error('firebase-config.js is not filled in');
}

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
auth.languageCode = 'ar';
const db = getFirestore(fbApp);

/* =========================================================
   Account screen
   ========================================================= */
let authMode = 'login';

const AUTH_ERRORS = {
  'auth/invalid-email': 'البريد الإلكتروني غير صحيح. تأكد من كتابته.',
  'auth/missing-email': 'اكتب بريدك الإلكتروني.',
  'auth/missing-password': 'اكتب كلمة المرور.',
  'auth/email-already-in-use': 'هذا البريد مسجّل من قبل. سجّل الدخول بدلًا من ذلك.',
  'auth/weak-password': 'كلمة المرور قصيرة. استخدم ٦ أحرف على الأقل.',
  'auth/invalid-credential': 'البريد أو كلمة المرور غير صحيحة.',
  'auth/invalid-login-credentials': 'البريد أو كلمة المرور غير صحيحة.',
  'auth/wrong-password': 'البريد أو كلمة المرور غير صحيحة.',
  'auth/user-not-found': 'لا يوجد حساب بهذا البريد. أنشئ حسابًا جديدًا.',
  'auth/too-many-requests': 'محاولات كثيرة. انتظر قليلًا ثم حاول مجددًا.',
  'auth/network-request-failed': 'لا يوجد اتصال بالإنترنت. تحقق من الشبكة وحاول مجددًا.',
  'auth/operation-not-allowed': 'التسجيل بالبريد غير مفعّل في إعدادات Firebase.',
};
const authError = (e) => AUTH_ERRORS[e?.code] || 'حدث خطأ غير متوقع. حاول مجددًا.';

function showAuthMsg(text, kind = 'error') {
  const m = $('authMsg');
  m.textContent = text; m.className = 'form-msg ' + kind; m.hidden = !text;
}

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === 'signup';
  $('tabLogin').setAttribute('aria-selected', String(!signup));
  $('tabSignup').setAttribute('aria-selected', String(signup));
  $('confirmField').hidden = !signup;
  $('pwHint').hidden = !signup;
  $('forgotBtn').hidden = signup;
  $('password').autocomplete = signup ? 'new-password' : 'current-password';
  $('authSubmit').textContent = signup ? 'إنشاء الحساب' : 'دخول';
  showAuthMsg('');
}
$('tabLogin').addEventListener('click', () => setAuthMode('login'));
$('tabSignup').addEventListener('click', () => setAuthMode('signup'));

$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('email').value.trim();
  const pw = $('password').value;
  if (!email) return showAuthMsg('اكتب بريدك الإلكتروني.');
  if (!pw) return showAuthMsg('اكتب كلمة المرور.');
  if (authMode === 'signup') {
    if (pw.length < 6) return showAuthMsg('كلمة المرور قصيرة. استخدم ٦ أحرف على الأقل.');
    if (pw !== $('password2').value) return showAuthMsg('كلمتا المرور غير متطابقتين.');
  }
  const btn = $('authSubmit');
  btn.disabled = true;
  showAuthMsg('');
  try {
    if (authMode === 'signup') {
      const cred = await createUserWithEmailAndPassword(auth, email, pw);
      sendEmailVerification(cred.user).catch(() => {});
    } else {
      await signInWithEmailAndPassword(auth, email, pw);
    }
  } catch (err) {
    showAuthMsg(authError(err));
  } finally {
    btn.disabled = false;
  }
});

$('forgotBtn').addEventListener('click', async () => {
  const email = $('email').value.trim();
  if (!email) return showAuthMsg('اكتب بريدك الإلكتروني أولًا، ثم اضغط "نسيت كلمة المرور؟".');
  try {
    await sendPasswordResetEmail(auth, email);
    showAuthMsg('أرسلنا رابط إعادة تعيين كلمة المرور إلى ' + email + '. تحقق من البريد، وانظر في مجلد الرسائل غير المرغوبة أيضًا.', 'ok');
  } catch (err) {
    showAuthMsg(authError(err));
  }
});

/* ---------- account menu ---------- */
const menuBtn = $('menuBtn'), menuEl = $('userMenu');
function setMenu(open) {
  menuEl.hidden = !open;
  menuBtn.setAttribute('aria-expanded', String(open));
  if (open) $('logoutBtn').focus();
}
menuBtn.addEventListener('click', (e) => { e.stopPropagation(); setMenu(menuEl.hidden); });
document.addEventListener('click', (e) => { if (!menuEl.hidden && !menuEl.contains(e.target)) setMenu(false); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !menuEl.hidden) { setMenu(false); menuBtn.focus(); }
});

$('logoutBtn').addEventListener('click', () => { setMenu(false); signOut(auth); });

/* =========================================================
   Notebook
   ========================================================= */
const app = $('app'), listEl = $('list'), searchEl = $('search');
const titleEl = $('titleInput'), bodyEl = $('bodyInput');
const editorEl = $('editor'), toolbarEl = $('toolbar'), emptyEl = $('empty');

const notes = new Map();
const dirty = new Set();
const timers = new Map();
const saving = new Map();
let activeId = null;
let loading = true;
let notesCol = null;
let unsubscribe = null;

const fmtDate = new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' });
const fmtShort = new Intl.DateTimeFormat('ar', { day: 'numeric', month: 'short' });
const fmtNum = new Intl.NumberFormat('ar');

const newId = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const words = (s) => (s || '').trim().split(/\s+/).filter(Boolean).length;
const plain = (n) => ({ title: n.title || '', body: n.body || '', pinned: !!n.pinned, createdAt: n.createdAt, updatedAt: n.updatedAt });

function setStatus(s, text) {
  $('status').dataset.s = s;
  $('statusText').textContent = text || ({ saving: 'جارٍ الحفظ…', saved: 'محفوظ', error: 'تعذّر الحفظ' })[s];
}

async function save(id) {
  const s = saving.get(id) || { busy: false, again: false };
  saving.set(id, s);
  if (s.busy) { s.again = true; return; }
  s.busy = true;
  setStatus('saving');
  try {
    const n = notes.get(id);
    if (n) await setDoc(doc(notesCol, id), plain(n));
    if (!s.again) dirty.delete(id);
    setStatus('saved');
  } catch (e) {
    setStatus('error', e?.code === 'permission-denied'
      ? 'لا تملك صلاحية الحفظ. سجّل الدخول من جديد'
      : 'تعذّر الحفظ. سنحاول عند التعديل التالي');
  } finally {
    s.busy = false;
    if (s.again) { s.again = false; save(id); }
  }
}

function persist(id, immediate) {
  dirty.add(id);
  setStatus('saving');
  clearTimeout(timers.get(id));
  const run = () => { timers.delete(id); save(id); };
  if (immediate) run(); else timers.set(id, setTimeout(run, 700));
}

async function removeNote(id) {
  clearTimeout(timers.get(id)); timers.delete(id); dirty.delete(id);
  notes.delete(id);
  if (activeId === id) activeId = null;
  app.classList.remove('editing');
  render();
  try { await deleteDoc(doc(notesCol, id)); setStatus('saved', 'حُذفت الملاحظة'); }
  catch (e) { setStatus('error', 'تعذّر الحذف'); }
}

function createNote() {
  if (loading) return;
  const now = Date.now();
  const id = newId();
  notes.set(id, { id, title: '', body: '', pinned: false, createdAt: now, updatedAt: now });
  activeId = id;
  searchEl.value = '';
  persist(id, true);
  render();
  app.classList.add('editing');
  titleEl.focus();
}

function openNote(id) { activeId = id; render(); app.classList.add('editing'); }

function edit(field, value) {
  const n = notes.get(activeId);
  if (!n) return;
  n[field] = value;
  n.updatedAt = Date.now();
  persist(activeId);
  renderList();
  renderMeta(n);
}

/* ---------- render ---------- */
function sorted() {
  const q = searchEl.value.trim().toLowerCase();
  return [...notes.values()]
    .filter(n => !q || (n.title + ' ' + n.body).toLowerCase().includes(q))
    .sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
}

const pinSvg = '<svg class="pin" viewBox="0 0 24 24" fill="currentColor"><path d="M9 3h6l-1 6 3 3v2h-4v8h-2v-8H7v-2l3-3z"/></svg>';
const countLabel = (k) => fmtNum.format(k) + (k === 1 ? ' ملاحظة' : k === 2 ? ' ملاحظتان' : k <= 10 ? ' ملاحظات' : ' ملاحظة');
const wordLabel = (w) => fmtNum.format(w) + (w === 1 ? ' كلمة' : w === 2 ? ' كلمتان' : (w >= 3 && w <= 10) ? ' كلمات' : ' كلمة');

function msg(text) {
  const li = document.createElement('li'); li.className = 'list-msg'; li.textContent = text; listEl.appendChild(li);
}

function renderList() {
  listEl.textContent = '';
  $('count').textContent = notes.size ? countLabel(notes.size) : '';
  if (loading) return msg('جارٍ تحميل الملاحظات…');
  if (!notes.size) return msg('لا توجد ملاحظات بعد.');
  const items = sorted();
  if (!items.length) return msg('لا توجد نتائج لهذا البحث.');
  for (const n of items) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'note-item';
    b.setAttribute('aria-current', n.id === activeId ? 'true' : 'false');
    const row = document.createElement('div'); row.className = 'row';
    if (n.pinned) row.insertAdjacentHTML('beforeend', pinSvg);
    const t = document.createElement('span');
    t.className = 't' + (n.title.trim() ? '' : ' untitled');
    t.textContent = n.title.trim() || 'بلا عنوان';
    row.appendChild(t);
    const s = document.createElement('span'); s.className = 's';
    s.textContent = n.body.trim().replace(/\s+/g, ' ').slice(0, 90) || 'لا يوجد نص';
    const d = document.createElement('span'); d.className = 'd';
    d.textContent = fmtShort.format(new Date(n.updatedAt));
    b.append(row, s, d);
    b.addEventListener('click', () => openNote(n.id));
    li.appendChild(b);
    listEl.appendChild(li);
  }
}

function renderMeta(n) {
  $('metaDate').textContent = 'آخر تعديل ' + fmtDate.format(new Date(n.updatedAt));
  $('metaWords').textContent = wordLabel(words(n.body));
}

function renderEditor() {
  const n = activeId && notes.get(activeId);
  if (!n) {
    editorEl.hidden = true; toolbarEl.hidden = true; emptyEl.hidden = false;
    if (loading) {
      $('emptyTitle').textContent = 'جارٍ فتح دفترك…'; $('emptyText').textContent = 'لحظة واحدة.'; $('emptyNew').hidden = true;
    } else if (!notes.size) {
      $('emptyTitle').textContent = 'دفترك فارغ';
      $('emptyText').textContent = 'كل ما تكتبه يُحفظ تلقائيًا في حسابك أثناء الكتابة.';
      $('emptyNew').hidden = false;
    } else {
      $('emptyTitle').textContent = 'اختر ملاحظة';
      $('emptyText').textContent = 'افتح ملاحظة من القائمة، أو ابدأ ملاحظة جديدة.';
      $('emptyNew').hidden = false;
    }
    return;
  }
  emptyEl.hidden = true; editorEl.hidden = false; toolbarEl.hidden = false;
  if (titleEl.dataset.id !== n.id) {
    titleEl.value = n.title; bodyEl.value = n.body; titleEl.dataset.id = n.id; resetDelete();
  } else {
    if (document.activeElement !== titleEl && titleEl.value !== n.title) titleEl.value = n.title;
    if (document.activeElement !== bodyEl && bodyEl.value !== n.body) bodyEl.value = n.body;
  }
  $('pinBtn').setAttribute('aria-pressed', n.pinned ? 'true' : 'false');
  $('pinText').textContent = n.pinned ? 'مثبّتة' : 'تثبيت';
  renderMeta(n);
}

function render() { renderList(); renderEditor(); }

/* ---------- delete with inline confirm ---------- */
let delTimer = null;
function resetDelete() {
  clearTimeout(delTimer);
  $('delBtn').classList.remove('confirming');
  $('delText').textContent = 'حذف';
}
$('delBtn').addEventListener('click', () => {
  const btn = $('delBtn');
  if (btn.classList.contains('confirming')) { resetDelete(); removeNote(activeId); return; }
  btn.classList.add('confirming');
  $('delText').textContent = 'اضغط مجددًا للحذف';
  delTimer = setTimeout(resetDelete, 3500);
});

/* ---------- events ---------- */
$('newBtn').addEventListener('click', createNote);
$('emptyNew').addEventListener('click', createNote);
$('backBtn').addEventListener('click', () => app.classList.remove('editing'));
searchEl.addEventListener('input', renderList);
titleEl.addEventListener('input', () => edit('title', titleEl.value));
bodyEl.addEventListener('input', () => edit('body', bodyEl.value));
titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); bodyEl.focus(); } });
$('pinBtn').addEventListener('click', () => {
  const n = notes.get(activeId); if (!n) return;
  n.pinned = !n.pinned; persist(activeId, true); render();
});

/* ---------- session ---------- */
function resetNotebook() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  for (const t of timers.values()) clearTimeout(t);
  timers.clear(); notes.clear(); dirty.clear(); saving.clear();
  activeId = null; loading = true; titleEl.dataset.id = '';
  searchEl.value = ''; $('banner').hidden = true;
  app.classList.remove('editing');
}

function openNotebook(user) {
  resetNotebook();
  $('userEmail').textContent = user.email || '';
  if (!user.emailVerified) {
    $('banner').textContent = 'أرسلنا رسالة تأكيد إلى بريدك. اضغط الرابط فيها لتأكيد حسابك.';
    $('banner').hidden = false;
  }
  notesCol = collection(db, 'users', user.uid, 'notes');
  render();
  unsubscribe = onSnapshot(notesCol, (snap) => {
    for (const ch of snap.docChanges()) {
      const id = ch.doc.id;
      if (dirty.has(id)) continue;
      if (ch.type === 'removed') { notes.delete(id); if (activeId === id) activeId = null; }
      else notes.set(id, Object.assign({ id }, ch.doc.data()));
    }
    loading = false;
    render();
  }, (err) => {
    loading = false;
    $('banner').textContent = err?.code === 'permission-denied'
      ? 'لا يمكن قراءة ملاحظاتك. تأكد من نشر قواعد Firestore.'
      : 'انقطع الاتصال بدفترك. أعد تحميل الصفحة.';
    $('banner').hidden = false;
    render();
  });
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    $('authView').hidden = true;
    app.hidden = false;
    openNotebook(user);
  } else {
    resetNotebook();
    app.hidden = true;
    $('authView').hidden = false;
    $('password').value = ''; $('password2').value = '';
    setAuthMode('login');
  }
});
