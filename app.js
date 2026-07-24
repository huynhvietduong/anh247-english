// ============================================================
// EnglishDaily — logic chính
// Tự động: xếp trình độ → tạo lộ trình → nạp bài học → theo dõi tiến độ
// ============================================================

const LEGACY_KEY = 'englishdaily_v1';          // dữ liệu bản cũ (một người dùng)
const USERS_KEY = 'englishdaily_users';        // cache tài khoản (để đăng nhập được khi offline)
const SESSION_KEY = 'englishdaily_session';    // ai đang đăng nhập
const STATE_PREFIX = 'englishdaily_state:';    // cache tiến độ học của từng tài khoản
const TOKEN_KEY = 'englishdaily_token';        // token đăng nhập từ máy chủ
const API = '/api';                            // API tài khoản + đồng bộ (nginx → 127.0.0.1:5003)
// ===== Bộ lập lịch LAI: thang cố định theo PHÚT (Memrise) cho giai đoạn đầu,
// rồi chuyển sang SM-2 đã vá (easiness có sàn/trần) cho giai đoạn dài hạn. =====
const LEARN_STEPS_MIN = [10, 240, 1440];   // 10 phút → 4 giờ → 24 giờ
const MIN_PER_DAY = 1440;
const MAX_IVL_MIN = 180 * MIN_PER_DAY;     // trần 6 tháng
const REVIEW_CAP = 40;                     // trần số thẻ ôn mỗi phiên (chống "cục review dồn")
const NEW_SOFT_CAP = 25;                   // ngưỡng cảnh báo số từ mới trong ngày
const SRS_INTERVALS_OLD = [0, 1, 3, 7, 16]; // dùng để nâng cấp dữ liệu cũ
const PUSH_API = '/api/push';           // backend đẩy thông báo trên VPS (nginx proxy → 127.0.0.1:5003)
const VAPID_PUBLIC = 'BBdmFi_CDVK3hK3pI_hp9bbJNq6f7xitjMQ86CHpf8N9zP4f1ckE6we8rJIGX1ghRGNdxGecWTANpqEJqajNw1g';

const App = (() => {

  // ---------- Tài khoản ----------
  let USERS = loadUsers();
  let CURRENT = localStorage.getItem(SESSION_KEY);
  let S = null;

  let TOKEN = localStorage.getItem(TOKEN_KEY) || null;
  let ROLE = null;           // 'admin' | 'student' — lấy từ máy chủ
  let online = true;         // gọi được máy chủ hay không
  let pendingSync = false;   // còn thay đổi chưa đẩy lên máy chủ

  function loadUsers() {
    try { return JSON.parse(localStorage.getItem(USERS_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveUsers() { localStorage.setItem(USERS_KEY, JSON.stringify(USERS)); }

  // ---------- Lớp gọi API máy chủ ----------
  async function api(path, { method = 'GET', body, auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
    const res = await fetch(API + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store',
    });
    let data = {};
    try { data = await res.json(); } catch (e) {}
    return { ok: res.ok, status: res.status, data };
  }

  // Đẩy tiến độ lên máy chủ (gộp nhiều lần lưu trong 1.5s thành 1 lần gửi)
  let pushTimer = null;
  function schedulePush() {
    if (!TOKEN) return;
    pendingSync = true;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushState, 1500);
  }

  async function pushState() {
    if (!TOKEN || !S) return;
    try {
      const r = await api('/state', { method: 'PUT', body: { state: S } });
      if (r.ok) {
        online = true; pendingSync = false;
        // Máy chủ có bản mới hơn (học ở thiết bị khác) → nhận bản đó về
        if (r.data.skipped && r.data.state) adoptState(r.data.state);
      } else if (r.status === 401) {
        forceLogout('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.');
      }
    } catch (e) {
      online = false;   // mất mạng: giữ pendingSync, thử lại ở lần lưu sau / khi có mạng
    }
    updateSyncBadge();
  }

  // Kéo tiến độ mới nhất từ máy chủ về (khi mở app / đổi thiết bị)
  async function pullState() {
    if (!TOKEN) return;
    try {
      const r = await api('/state');
      if (r.status === 401) { forceLogout('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.'); return; }
      if (!r.ok) return;
      online = true;
      const srv = r.data.state;
      const localAt = (S && S.updatedAt) || 0;
      if (srv && (srv.updatedAt || 0) > localAt) {
        adoptState(srv);
        toast('☁️ Đã tải tiến độ mới nhất từ máy chủ');
      } else if (!srv && S) {
        pushState();          // máy chủ chưa có → đẩy bản trên máy này lên
      } else if (pendingSync) {
        pushState();
      }
    } catch (e) { online = false; }
    updateSyncBadge();
  }

  function adoptState(srv) {
    // Đang làm quiz thì không thay dữ liệu giữa chừng — để lần đồng bộ sau
    if (document.getElementById('quiz-opts')) return;
    S = normalizeState(srv);
    localStorage.setItem(stateKey(CURRENT), JSON.stringify(S));
    const active = document.querySelector('.nav-item.active');
    const view = active && active.dataset.view;
    if (view && !document.getElementById('app').classList.contains('hidden')) go(view);
  }

  function updateSyncBadge() {
    const el = document.getElementById('sync-badge');
    if (!el) return;
    if (!TOKEN) { el.textContent = '📴 Chỉ lưu trên máy này'; el.className = 'sync-badge warn'; return; }
    if (!online) { el.textContent = '⚠️ Mất mạng — sẽ tự đồng bộ lại'; el.className = 'sync-badge warn'; }
    else if (pendingSync) { el.textContent = '⏳ Đang đồng bộ...'; el.className = 'sync-badge'; }
    else { el.textContent = '☁️ Đã đồng bộ'; el.className = 'sync-badge ok'; }
  }

  function forceLogout(msg) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(SESSION_KEY);
    TOKEN = null;
    if (msg) alert(msg);
    location.reload();
  }

  // Băm mật khẩu (che giấu cơ bản — app tĩnh không có máy chủ nên không phải bảo mật tuyệt đối)
  function hashPass(p) {
    const s = 'ed_salt::' + p;
    let h1 = 5381, h2 = 52711;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = (h1 * 33 + c) >>> 0;
      h2 = (h2 * 31 + c) >>> 0;
    }
    return h1.toString(16) + '.' + h2.toString(16);
  }

  // Tạo sẵn tài khoản quản trị lần đầu chạy
  function ensureAdmin() {
    if (!USERS['admin']) {
      USERS['admin'] = { pass: hashPass('admin123'), role: 'admin', created: todayStr() };
      saveUsers();
    }
  }

  const stateKey = u => STATE_PREFIX + u;

  // Bổ sung các trường mới cho dữ liệu cũ (dù đến từ localStorage hay máy chủ)
  function normalizeState(s) {
    if (!s) return null;
    if (!s.reminder) s.reminder = { enabled: false, time: '20:00' };
    if (!('lastNotified' in s)) s.lastNotified = null;
    if (!s.push) s.push = { enabled: false, times: ['07:00', '12:30', '20:00'] };
    if (!s.missions) s.missions = {};
    if (!s.weak) s.weak = {};                 // { "tid|w": số lần sai } — điểm yếu cần ôn thêm
    if (!s.mistakes) s.mistakes = {};         // { "tid|w": [đáp án sai đã gõ] } — dùng làm nhiễu
    if (!s.newToday) s.newToday = { d: '', n: 0 };
    if (!s.startView) s.startView = 'dashboard';   // màn hình hiện ra khi mở app
    if (!('minutesPerDay' in s)) s.minutesPerDay = 15;
    if (!('updatedAt' in s)) s.updatedAt = 0;
    // Nâng cấp thẻ SRS bản cũ {box, due:'YYYY-MM-DD'} → lịch theo phút có easiness
    Object.keys(s.srs || {}).forEach(k => {
      const c = s.srs[k];
      if (c && c.lvl === undefined) {
        const box = c.box || 0;
        s.srs[k] = {
          lvl: box, ef: 2.5, reps: box, ivl: (SRS_INTERVALS_OLD[box] || 1) * MIN_PER_DAY,
          due: c.due ? new Date(c.due + 'T08:00:00').getTime() : Date.now(),
          lapses: 0, hard: false, seen: box, ok: box,
        };
      }
    });
    return s;
  }

  function loadState(username) {
    try {
      const raw = localStorage.getItem(stateKey(username));
      if (raw) return normalizeState(JSON.parse(raw));
    } catch (e) {}
    return null;
  }

  function save() {
    if (!CURRENT || !S) return;
    S.updatedAt = Date.now();
    localStorage.setItem(stateKey(CURRENT), JSON.stringify(S));   // lưu ngay (dùng được offline)
    schedulePush();                                               // rồi đẩy lên máy chủ
  }

  function freshState(name, level) {
    return {
      name: name || 'bạn',
      level,                       // 1 | 2 | 3
      plan: buildPlan(level),      // lộ trình tự động
      done: [],                    // các ngày đã hoàn thành
      srs: {},                     // { "topicId|word": {box, due} }
      streak: 0,
      lastStudy: null,             // 'YYYY-MM-DD'
      quizStats: { total: 0, correct: 0 },
      reminder: { enabled: false, time: '20:00' },
      lastNotified: null,
      push: { enabled: false, times: ['07:00', '12:30', '20:00'] },
      missions: {},               // { 'YYYY-MM-DD': true } — thử thách đời thực đã làm
      weak: {},                   // { "tid|w": số lần sai } — ôn tập thích ứng ưu tiên chỗ yếu
      mistakes: {},               // { "tid|w": [đáp án sai] } — sinh phương án nhiễu thật
      newToday: { d: '', n: 0 },  // đếm từ mới trong ngày (chống dồn cục ôn tập)
      startView: 'dashboard',     // 'dashboard' | 'learn' | 'flashcards' | 'auto'
      minutesPerDay: 15,          // dùng cho Study Plan (ước tính ngày hoàn thành)
    };
  }

  const topicById = id => TOPICS.find(t => t.id === id);
  // Gộp từ vựng + cụm giao tiếp thành một "kho học liệu" chung cho SRS/quiz/thông báo
  const vocabOf = t => t.vocab.concat((t.chunks || []).map(k => ({ w: k.c, ipa: '', m: k.m, ex: k.ex })));
  function findItem(tid, w) {
    const t = topicById(tid);
    return t ? vocabOf(t).find(x => x.w === w) : null;
  }
  // Định dạng ngày theo giờ ĐỊA PHƯƠNG (không dùng toISOString vì lệch múi giờ UTC)
  const fmtDate = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const todayStr = () => fmtDate(new Date());

  // Các chủ đề "Thực chiến" (kỹ năng giao tiếp xuyên suốt)
  const FUNC_IDS = ['survival-basics', 'polite-requests', 'reactions', 'opinions', 'conversation-flow'];

  // ---------- CHẶNG (stages) — chia lộ trình theo mục tiêu "làm được gì", giống Duolingo/Busuu ----------
  const STAGES = [
    {
      name: 'Sinh tồn', en: 'Survival', icon: '🌱', color: '#2ecc8f',
      goal: 'Chào hỏi, giới thiệu bản thân, hỏi lại khi chưa hiểu và nhờ người khác giúp đỡ.',
      topics: ['greetings', 'family', 'numbers-time', 'making-friends', 'survival-basics', 'polite-requests'],
    },
    {
      name: 'Đời sống hằng ngày', en: 'Daily Life', icon: '🏙️', color: '#4f7cff',
      goal: 'Tự xoay xở khi ăn uống, mua sắm, hỏi đường và nói về thói quen, thời tiết.',
      topics: ['daily-routine', 'food', 'coffee-shop', 'shopping', 'online-order', 'directions', 'weather'],
    },
    {
      name: 'Giao tiếp xã hội', en: 'Social', icon: '💬', color: '#ffc94d',
      goal: 'Trò chuyện về công việc, sở thích, sức khỏe; đặt lịch hẹn; bày tỏ cảm xúc và ý kiến.',
      topics: ['hobbies', 'work', 'describing-people', 'health', 'phone', 'renting', 'travel', 'feelings', 'reactions', 'opinions'],
    },
    {
      name: 'Làm chủ hội thoại', en: 'Fluency', icon: '🚀', color: '#ff6b7a',
      goal: 'Xử lý tình huống phức tạp, giữ nhịp hội thoại tự nhiên và ứng phó khi khẩn cấp.',
      topics: ['money', 'study', 'job-interview', 'sports', 'party', 'technology', 'emergency', 'smalltalk', 'conversation-flow'],
    },
  ];

  // ---------- Tạo lộ trình tự động theo trình độ ----------
  function buildStage(stageIdx, level) {
    const st = STAGES[stageIdx];
    const stTopics = st.topics.map(topicById).filter(Boolean);
    const funcs = stTopics.filter(t => FUNC_IDS.includes(t.id));
    const regs = stTopics.filter(t => !FUNC_IDS.includes(t.id));

    const pair = arr => {
      const out = [];
      for (let i = 0; i < arr.length; i += 2) out.push(arr.slice(i, i + 2).map(t => t.id));
      return out;
    };

    // Nhịp học tùy trình độ: cao hơn thì ghép nhiều chủ đề vào 1 ngày (học nhanh hơn)
    let regGroups;
    if (level === 1) regGroups = regs.map(t => [t.id]);
    else if (level === 2) {
      const easy = regs.filter(t => t.level === 1), hard = regs.filter(t => t.level !== 1);
      regGroups = [...pair(easy), ...hard.map(t => [t.id])];
    } else regGroups = pair(regs);

    // Xen kẽ bài "Thực chiến": cứ 2 bài chủ đề → 1 bài kỹ năng
    const days = [];
    let fi = 0;
    regGroups.forEach((g, i) => {
      days.push({ t: 'lesson', topics: g, stage: stageIdx });
      if ((i + 1) % 2 === 0 && fi < funcs.length) days.push({ t: 'lesson', topics: [funcs[fi++].id], stage: stageIdx });
    });
    while (fi < funcs.length) days.push({ t: 'lesson', topics: [funcs[fi++].id], stage: stageIdx });

    // Chèn ngày ôn sau mỗi 3 ngày học
    const out = [];
    let lc = 0;
    days.forEach(d => {
      out.push(d);
      if (++lc % 3 === 0) out.push({ t: 'review', stage: stageIdx });
    });
    // Checkpoint cuối chặng
    out.push({ t: 'checkpoint', stage: stageIdx });
    return out;
  }

  function buildPlan(level) {
    const plan = [];
    STAGES.forEach((st, i) => plan.push(...buildStage(i, level)));
    plan.push({ t: 'final', kind: 'speaking', stage: STAGES.length - 1 });
    plan.push({ t: 'final', kind: 'quiz', stage: STAGES.length - 1 });
    return plan;
  }

  // Chỉ số chặng của một ngày (an toàn với dữ liệu cũ chưa có stage)
  const stageOf = d => (d && typeof d.stage === 'number') ? d.stage : 0;
  // Các ngày (index) thuộc một chặng
  const daysInStage = idx => S.plan.map((d, i) => stageOf(d) === idx ? i : -1).filter(i => i >= 0);
  // Chặng hiện tại đang học
  function currentStage() {
    const cur = currentDayIdx();
    return cur === -1 ? STAGES.length - 1 : stageOf(S.plan[cur]);
  }
  const stageDone = idx => daysInStage(idx).every(i => S.done.includes(i));

  // ---------- Đăng nhập / Đăng ký ----------
  let authMode = 'login';

  function showScreen(id) {
    ['screen-login', 'screen-onboard', 'app'].forEach(x =>
      document.getElementById(x).classList.toggle('hidden', x !== id));
  }

  function authTab(mode) {
    authMode = mode;
    document.getElementById('authtab-login').classList.toggle('active', mode === 'login');
    document.getElementById('authtab-reg').classList.toggle('active', mode === 'reg');
    document.getElementById('pass2-wrap').classList.toggle('hidden', mode === 'login');
    document.getElementById('auth-title').textContent = mode === 'login' ? 'Đăng nhập' : 'Tạo tài khoản mới';
    document.getElementById('auth-sub').textContent = mode === 'login'
      ? 'Đăng nhập để tiếp tục lộ trình học của bạn — trên điện thoại hay máy tính đều cùng một tiến độ.'
      : 'Tài khoản lưu trên máy chủ: học ở thiết bị nào cũng nối tiếp được tiến độ.';
    document.getElementById('auth-submit').textContent = mode === 'login' ? 'Đăng nhập' : 'Đăng ký & bắt đầu';
    authErr('');
  }

  function authErr(msg) { document.getElementById('auth-err').textContent = msg; }

  // Hiện / ẩn mật khẩu (nút con mắt)
  function togglePass(inputId, btn) {
    const inp = document.getElementById(inputId);
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    btn.textContent = show ? '🙈' : '👁️';
    inp.focus();
  }

  function authBusy(on, label) {
    const b = document.getElementById('auth-submit');
    if (!b) return;
    b.disabled = on;
    b.textContent = on ? (label || 'Đang xử lý...') : (authMode === 'login' ? 'Đăng nhập' : 'Đăng ký & bắt đầu');
  }

  // Đăng nhập thành công: lưu token/phiên rồi vào app
  function acceptSession(u, token, role, serverState) {
    CURRENT = u;
    TOKEN = token || null;
    ROLE = role || 'student';
    if (TOKEN) localStorage.setItem(TOKEN_KEY, TOKEN); else localStorage.removeItem(TOKEN_KEY);
    localStorage.setItem(SESSION_KEY, u);
    // Nếu máy chủ có bản mới hơn bản trên máy → dùng bản của máy chủ
    const local = loadState(u);
    const srv = normalizeState(serverState);
    if (srv && (!local || (srv.updatedAt || 0) > (local.updatedAt || 0))) {
      localStorage.setItem(stateKey(u), JSON.stringify(srv));
    }
    document.getElementById('auth-pass').value = '';
    document.getElementById('auth-pass2').value = '';
    enterApp();
    if (TOKEN && !srv && loadState(u)) pushState();   // máy chủ chưa có tiến độ → đẩy bản cũ lên
  }

  async function authSubmit() {
    const u = document.getElementById('auth-user').value.trim().toLowerCase();
    const p = document.getElementById('auth-pass').value;
    if (!u || !p) return authErr('Vui lòng nhập đủ tên đăng nhập và mật khẩu.');
    authErr('');

    if (authMode === 'reg') {
      const p2 = document.getElementById('auth-pass2').value;
      if (!/^[a-z0-9_.-]{3,24}$/.test(u)) return authErr('Tên đăng nhập: 3–24 ký tự, chỉ gồm chữ thường, số, dấu . _ -');
      if (p.length < 4) return authErr('Mật khẩu cần ít nhất 4 ký tự.');
      if (p !== p2) return authErr('Mật khẩu nhập lại không khớp.');
      authBusy(true, 'Đang tạo tài khoản...');
      try {
        const r = await api('/auth/register', { method: 'POST', auth: false, body: { username: u, password: p } });
        authBusy(false);
        if (!r.ok) return authErr(r.data.err || 'Không tạo được tài khoản.');
        // cache để đăng nhập được cả khi mất mạng
        USERS[u] = { pass: hashPass(p), role: 'student', created: todayStr() };
        saveUsers();
        // chuyển tiến độ bản cũ (trước khi có tài khoản) sang người đăng ký đầu tiên
        const legacy = localStorage.getItem(LEGACY_KEY);
        if (legacy && !localStorage.getItem(stateKey(u))) {
          localStorage.setItem(stateKey(u), legacy);
          localStorage.removeItem(LEGACY_KEY);
        }
        return acceptSession(u, r.data.token, r.data.role, r.data.state);
      } catch (e) {
        authBusy(false);
        return authErr('Không kết nối được máy chủ. Cần có mạng để tạo tài khoản mới.');
      }
    }

    // --- Đăng nhập ---
    authBusy(true, 'Đang đăng nhập...');
    let r;
    try {
      r = await api('/auth/login', { method: 'POST', auth: false, body: { username: u, password: p } });
    } catch (e) {
      authBusy(false);
      // Mất mạng: cho đăng nhập bằng bản lưu trên máy (chỉ khi máy này từng đăng nhập)
      if (USERS[u] && USERS[u].pass === hashPass(p) && loadState(u)) {
        online = false;
        toast('📴 Không có mạng — đang dùng dữ liệu lưu trên máy này');
        return acceptSession(u, null, USERS[u].role, null);
      }
      return authErr('Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.');
    }
    authBusy(false);

    if (r.ok) {
      USERS[u] = { pass: hashPass(p), role: r.data.role, created: (USERS[u] && USERS[u].created) || todayStr() };
      saveUsers();
      return acceptSession(u, r.data.token, r.data.role, r.data.state);
    }
    // Tài khoản cũ chỉ có trên máy này → tự chuyển lên máy chủ (giữ nguyên tiến độ)
    if (r.status === 404 && USERS[u] && USERS[u].pass === hashPass(p)) {
      authBusy(true, 'Đang chuyển tài khoản lên máy chủ...');
      try {
        const reg = await api('/auth/register', { method: 'POST', auth: false, body: { username: u, password: p } });
        authBusy(false);
        if (reg.ok) {
          toast('☁️ Đã chuyển tài khoản của bạn lên máy chủ — giờ đăng nhập được ở mọi thiết bị!');
          return acceptSession(u, reg.data.token, reg.data.role, null);
        }
      } catch (e) { authBusy(false); }
    }
    if (r.status === 404) return authErr('Tài khoản không tồn tại. Bấm "Đăng ký" để tạo mới.');
    return authErr(r.data.err || 'Đăng nhập thất bại.');
  }

  async function logout() {
    if (pendingSync) { try { await pushState(); } catch (e) {} }   // đẩy nốt tiến độ trước khi thoát
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(TOKEN_KEY);
    TOKEN = null;
    location.reload();
  }

  function isAdmin() {
    if (ROLE) return ROLE === 'admin';
    return !!(CURRENT && USERS[CURRENT] && USERS[CURRENT].role === 'admin');
  }

  function enterApp() {
    S = loadState(CURRENT);
    // Admin: không cần kiểm tra đầu vào — tạo sẵn hồ sơ học để mọi màn hình hoạt động
    if (!S && isAdmin()) {
      S = freshState(CURRENT, 1);
      save();
    }
    if (!S || !S.plan) {
      // học viên mới → làm kiểm tra đầu vào
      showScreen('screen-onboard');
      const inp = document.getElementById('inp-name');
      if (inp && !inp.value) inp.value = CURRENT;
      return;
    }
    showScreen('app');
    showUserChip();
    go(...openingView());
    pullState();                                 // lấy tiến độ mới nhất từ máy chủ (nếu có mạng)
    syncPush();                                  // làm mới nội dung thông báo theo tiến độ mới nhất
    if ('setAppBadge' in navigator) {            // huy hiệu số thẻ đến hạn trên icon app
      const n = dueCards().length;
      (n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
    }
  }

  // Màn hình hiện ra ngay khi mở app — người dùng tự chọn trong Cài đặt
  function openingView() {
    if (isAdmin() && (!S.startView || S.startView === 'dashboard')) return ['admin'];
    const cur = currentDayIdx();
    const due = dueCards().length;
    switch (S.startView) {
      case 'learn':                                     // vào thẳng bài học hôm nay
        return cur !== -1 ? ['day', cur] : ['flashcards'];
      case 'flashcards':                                // vào thẳng ôn flashcard
        return ['flashcards'];
      case 'auto':                                      // ưu tiên ôn thẻ đến hạn, hết thì học bài mới
        if (due > 0) return ['flashcards'];
        return cur !== -1 ? ['day', cur] : ['dashboard'];
      default:
        return ['dashboard'];
    }
  }

  function setStartView(v) {
    S.startView = v;
    save();
    const names = { dashboard: 'Tổng quan', learn: 'Bài học hôm nay', flashcards: 'Flashcard ôn tập', auto: 'Tự động chọn' };
    toast('✅ Lần sau mở app sẽ vào thẳng: ' + names[v]);
  }

  function showUserChip() {
    document.getElementById('nav-admin').classList.toggle('hidden', !isAdmin());
    const chip = document.getElementById('user-chip');
    if (chip) {
      chip.innerHTML = `👤 <b>${esc(CURRENT)}</b>${isAdmin() ? ' <span class="role-badge">admin</span>' : ''}`
        + `<div id="sync-badge" class="sync-badge">…</div>`;
    }
    updateSyncBadge();
  }

  // ---------- Onboarding ----------
  let obIdx = 0, obScore = { 1: 0, 2: 0, 3: 0 };

  function startPlacement() {
    obIdx = 0; obScore = { 1: 0, 2: 0, 3: 0 };
    document.getElementById('onboard-start').classList.add('hidden');
    document.getElementById('onboard-quiz').classList.remove('hidden');
    renderPlacementQ();
  }

  function renderPlacementQ() {
    const q = PLACEMENT_TEST[obIdx];
    document.getElementById('ob-bar').style.width = (obIdx / PLACEMENT_TEST.length * 100) + '%';
    document.getElementById('ob-qnum').textContent = `Câu ${obIdx + 1} / ${PLACEMENT_TEST.length}`;
    document.getElementById('ob-question').textContent = q.q;
    const box = document.getElementById('ob-options');
    box.innerHTML = '';
    q.opts.forEach((o, i) => {
      const b = document.createElement('button');
      b.className = 'opt';
      b.textContent = o;
      b.onclick = () => {
        if (i === q.a) obScore[q.lv]++;
        obIdx++;
        obIdx < PLACEMENT_TEST.length ? renderPlacementQ() : showPlacementResult();
      };
      box.appendChild(b);
    });
  }

  function placementLevel() {
    // Đúng >=3/4 câu cơ bản mới xét tiếp; tương tự với các mức sau
    if (obScore[1] < 3) return 1;
    if (obScore[2] < 2) return 1;
    if (obScore[3] >= 2) return 3;
    return 2;
  }

  function showPlacementResult() {
    const lv = placementLevel();
    const name = document.getElementById('inp-name').value.trim();
    S = freshState(name, lv);
    save();
    const names = { 1: 'Cơ bản (Beginner)', 2: 'Sơ trung cấp (Elementary)', 3: 'Trung cấp (Intermediate)' };
    const descs = {
      1: 'Bạn sẽ bắt đầu từ nền tảng: chào hỏi, gia đình, thời gian… xen kẽ các bài "Thực chiến" giúp giao tiếp được ngay.',
      2: 'Bạn đã nắm những điều cơ bản. Lộ trình rút gọn — các chủ đề dễ được học nhanh gấp đôi.',
      3: 'Trình độ của bạn khá tốt! Lộ trình tăng tốc, tập trung vào cụm giao tiếp và chủ đề nâng cao.',
    };
    document.getElementById('onboard-quiz').classList.add('hidden');
    document.getElementById('onboard-result').classList.remove('hidden');
    document.getElementById('ob-result-title').textContent =
      `${name ? name + ', trình' : 'Trình'} độ của bạn: ${names[lv]}`;
    document.getElementById('ob-result-desc').textContent =
      `Đúng ${obScore[1] + obScore[2] + obScore[3]}/10 câu. ${descs[lv]} (${S.plan.length} ngày học)`;
  }

  function skipPlacement() {
    const name = document.getElementById('inp-name').value.trim();
    S = freshState(name, 1);
    save();
    finishOnboard();
  }

  function finishOnboard() {
    showScreen('app');
    showUserChip();
    go('dashboard');
    pushState();     // đẩy lộ trình vừa tạo lên máy chủ ngay
  }

  // ---------- Điều hướng ----------
  const main = () => document.getElementById('main');

  function go(view, arg) {
    document.querySelectorAll('.nav-item[data-view]').forEach(b =>
      b.classList.toggle('active', b.dataset.view === view));
    if (view === 'dashboard') renderDashboard();
    else if (view === 'roadmap') renderRoadmap();
    else if (view === 'flashcards') renderFlashcards();
    else if (view === 'speaking') renderSpeaking();
    else if (view === 'topics') renderTopics();
    else if (view === 'admin') renderAdmin();
    else if (view === 'settings') renderSettings();
    else if (view === 'day') renderDay(arg);
    window.scrollTo(0, 0);
  }

  // ---------- Streak & tiến độ ----------
  function touchStreak() {
    const today = todayStr();
    if (S.lastStudy === today) return;
    const y = new Date(); y.setDate(y.getDate() - 1);
    S.streak = (S.lastStudy === fmtDate(y)) ? S.streak + 1 : 1;
    S.lastStudy = today;
    save();
  }

  function currentDayIdx() {
    for (let i = 0; i < S.plan.length; i++) if (!S.done.includes(i)) return i;
    return -1; // hoàn thành hết
  }

  function markDone(dayIdx) {
    if (!S.done.includes(dayIdx)) S.done.push(dayIdx);
    touchStreak();
    save();
  }

  function learnedTopicIds() {
    const ids = [];
    S.done.forEach(i => {
      const d = S.plan[i];
      if (d && d.t === 'lesson') ids.push(...d.topics);
    });
    return ids;
  }

  // ---------- Bộ lập lịch ----------
  const newCard = () => ({ lvl: 0, ef: 2.5, reps: 0, ivl: 0, due: Date.now(), lapses: 0, hard: false, seen: 0, ok: 0 });

  // Suy ra chất lượng nhớ (0..5) từ đúng/sai + thời gian trả lời.
  // Không bắt người học tự chấm "dễ/khó" — họ sẽ bấm bừa (bẫy số 7 trong tài liệu).
  const EXPECT_MS = { mc_word: 4000, mc_meaning: 4000, listen: 5000, listen_mean: 5500,
    cloze_mc: 6000, scramble: 9000, type: 12000, cloze_type: 12000, speak: 9000, flashcard: 6000 };
  function inferQuality(correct, ms, type) {
    if (!correct) return ms > 15000 ? 0 : 2;
    const t = EXPECT_MS[type] || 7000;
    if (ms < t * 0.6) return 5;      // trả lời nhanh, chắc chắn
    if (ms < t * 1.5) return 4;      // bình thường
    return 3;                        // đúng nhưng do dự
  }

  function schedule(card, correct, quality) {
    const c = Object.assign(newCard(), card);
    c.seen++;
    if (correct) {
      c.ok++;
      c.lvl++;
      c.reps++;
      const d = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
      c.ef = Math.min(2.8, Math.max(1.3, c.ef + d));       // sàn/trần chống "ease hell"
      if (c.lvl <= LEARN_STEPS_MIN.length) c.ivl = LEARN_STEPS_MIN[c.lvl - 1];
      else if (c.lvl === LEARN_STEPS_MIN.length + 1) c.ivl = 6 * MIN_PER_DAY;
      else c.ivl = Math.ceil((c.ivl || MIN_PER_DAY) * c.ef);
      c.ivl = Math.min(c.ivl, MAX_IVL_MIN);
      if (c.hard && c.reps >= 2) c.hard = false;            // gỡ cờ khó khi đã đúng 2 lần liên tiếp
    } else {
      c.lapses++;
      if (c.lapses >= 3) c.hard = true;
      // KHÔNG đưa về 0 — chỉ tụt bậc, để người học không nản
      c.lvl = c.lvl > LEARN_STEPS_MIN.length ? Math.max(1, c.lvl - 2) : Math.max(0, c.lvl - 1);
      c.reps = 0;
      c.ef = Math.max(1.3, c.ef - 0.2);
      c.ivl = LEARN_STEPS_MIN[0];                           // gặp lại sau 10 phút
    }
    // fuzz ±10% để các thẻ học cùng lúc không đến hạn dồn cục mãi mãi
    c.due = Date.now() + c.ivl * 60000 * (1 + (Math.random() - 0.5) * 0.2);
    return c;
  }

  // Ghi nhận một lượt trả lời: cập nhật lịch + nhật ký lỗi sai
  function gradeItem(key, correct, ms, type, userAnswer) {
    const q = inferQuality(correct, ms, type);
    S.srs[key] = schedule(S.srs[key] || newCard(), correct, q);
    if (correct) { if (S.weak[key]) { if (--S.weak[key] <= 0) delete S.weak[key]; } }
    else {
      S.weak[key] = (S.weak[key] || 0) + 1;
      // Lưu đáp án SAI để dùng làm phương án nhiễu thật ở các lần sau
      if (userAnswer && norm(userAnswer) !== norm(key.split('|').slice(1).join('|'))) {
        const arr = S.mistakes[key] = S.mistakes[key] || [];
        if (!arr.some(x => norm(x) === norm(userAnswer)) && userAnswer.length < 40) arr.unshift(userAnswer);
        if (arr.length > 3) arr.pop();
      }
    }
    S.quizStats.total++; if (correct) S.quizStats.correct++;
    return S.srs[key];
  }

  function addTopicToSrs(topicId) {
    const t = topicById(topicId);
    if (!t) return;
    vocabOf(t).forEach(v => {
      const key = topicId + '|' + v.w;
      if (!S.srs[key]) S.srs[key] = newCard();
    });
    save();
  }

  function dueCards() {
    const now = Date.now();
    const all = Object.entries(S.srs)
      .filter(([, c]) => (c.due || 0) <= now)
      .sort((a, b) => (a[1].due || 0) - (b[1].due || 0))    // quá hạn lâu nhất lên trước
      .map(([key, c]) => {
        const [tid, ...rest] = key.split('|');
        const v = findItem(tid, rest.join('|'));
        return v ? { key, card: c, v, topic: topicById(tid) } : null;
      })
      .filter(Boolean);
    return all;
  }

  // ---------- Phát âm (TTS) ----------
  function speak(text, rate) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = rate || 0.92;
      const voice = speechSynthesis.getVoices().find(v => v.lang.startsWith('en'));
      if (voice) u.voice = voice;
      speechSynthesis.speak(u);
    } catch (e) { toast('Trình duyệt không hỗ trợ đọc giọng nói'); }
  }

  // ---------- Dashboard ----------
  function dayLabel(d, i) {
    if (d.t === 'lesson') {
      const ts = d.topics.map(id => topicById(id));
      return { icon: ts[0].icon, name: ts.map(t => t.name).join(' + ') };
    }
    if (d.t === 'review') return { icon: d.adaptive ? '🎯' : '🔁', name: d.adaptive ? 'Ôn tập điểm yếu' : 'Ôn tập tổng hợp' };
    if (d.t === 'checkpoint') return { icon: '🏅', name: 'Checkpoint: Kiểm tra chặng' };
    return d.kind === 'quiz'
      ? { icon: '🏁', name: 'Bài kiểm tra cuối khóa' }
      : { icon: '🎤', name: 'Thử thách luyện nói' };
  }

  function renderDashboard() {
    const cur = currentDayIdx();
    const pct = Math.round(S.done.length / S.plan.length * 100);
    const words = Object.keys(S.srs).length;
    const acc = S.quizStats.total ? Math.round(S.quizStats.correct / S.quizStats.total * 100) : 0;
    const due = dueCards().length;
    const lvNames = { 1: 'Cơ bản', 2: 'Sơ trung cấp', 3: 'Trung cấp' };

    let todayHtml;
    if (cur === -1) {
      todayHtml = `<div class="today-card"><div>
        <h3>Chúc mừng! 🎓</h3>
        <div class="t-title">Bạn đã hoàn thành toàn bộ lộ trình!</div>
        <div class="t-desc">Tiếp tục ôn flashcard và luyện nói mỗi ngày để duy trì phản xạ nhé.</div>
      </div></div>`;
    } else {
      const lbl = dayLabel(S.plan[cur], cur);
      const si = currentStage();
      const st = STAGES[si];
      const stTag = st ? `<div class="t-stage">${st.icon} Chặng ${si + 1}: ${st.name} · ${daysInStage(si).filter(x => S.done.includes(x)).length}/${daysInStage(si).length}</div>` : '';
      todayHtml = `<div class="today-card">
        <div>
          ${stTag}
          <h3>Bài học hôm nay — Ngày ${cur + 1}/${S.plan.length}</h3>
          <div class="t-title">${lbl.icon} ${lbl.name}</div>
          <div class="t-desc">🎯 ${st ? esc(st.goal) : 'Hoàn thành để mở khóa ngày tiếp theo.'}</div>
        </div>
        <button class="btn btn-primary" onclick="App.go('day',${cur})">Học ngay →</button>
      </div>`;
    }

    const missionDone = !!S.missions[todayStr()];
    // Tổng quan gói gọn trong 1 màn: lời chào → việc hôm nay → 4 số liệu → 2 dòng hành động.
    // Cài đặt tách sang màn riêng (nút ⚙️) để không kéo dài trang.
    main().innerHTML = `
      <div class="dash-head">
        <div>
          <div class="view-title" style="margin-bottom:2px">Xin chào, ${esc(S.name)}! 👋</div>
          <div class="view-sub" style="margin:0">Trình độ <b>${lvNames[S.level]}</b> · ${pct}% lộ trình${Object.keys(S.weak).length ? ` · 🎯 ${Object.keys(S.weak).length} mục cần ôn thêm` : ''}</div>
        </div>
        <button class="icon-btn" title="Cài đặt" onclick="App.go('settings')">⚙️</button>
      </div>
      ${todayHtml}
      <div class="quick-stats">
        <div><span class="qs-ico">🔥</span><b>${S.streak}</b><span class="qs-lbl">chuỗi ngày</span></div>
        <div><span class="qs-ico">📖</span><b>${S.done.length}/${S.plan.length}</b><span class="qs-lbl">ngày học</span></div>
        <div><span class="qs-ico">🧠</span><b>${words}</b><span class="qs-lbl">từ đang nhớ</span></div>
        <div><span class="qs-ico">🎯</span><b>${acc}%</b><span class="qs-lbl">đúng quiz</span></div>
      </div>
      ${due > 0 ? `<button class="row-action" onclick="App.go('flashcards')">
        <span class="ra-ico">🃏</span>
        <span class="ra-text"><b>${due} thẻ đến hạn ôn</b><small>Ôn ngay để không quên</small></span>
        <span class="ra-go">Ôn →</span>
      </button>` : ''}
      <div class="row-action mission ${missionDone ? 'done' : ''}">
        <span class="ra-ico">🎯</span>
        <span class="ra-text"><b>Thử thách đời thực</b><small>${esc(todayMission())}</small></span>
        ${missionDone ? '<span class="ra-go done">✓ Xong</span>'
          : '<button class="btn btn-green btn-sm" onclick="App.doneMission()">Đã làm ✓</button>'}
      </div>
    `;
  }

  // ---------- Cài đặt (màn riêng) ----------
  function renderSettings() {
    const cur = currentDayIdx();
    const remaining = S.plan.length - S.done.length;
    const perDay = Math.max(1, Math.round((S.minutesPerDay || 15) / 15));
    const finish = new Date(); finish.setDate(finish.getDate() + Math.ceil(remaining / perDay));
    const finishStr = finish.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
    main().innerHTML = `
      <div class="lesson-head">
        <button class="back" onclick="App.go('dashboard')">← Tổng quan</button>
        <div class="view-title" style="margin:0;font-size:22px">⚙️ Cài đặt</div>
      </div>
      <div class="panel">
        <div class="set-row">
          <div>
            <div class="set-name">🚀 Mở app là vào thẳng</div>
            <div class="set-desc">Bỏ qua màn Tổng quan, bắt tay vào học ngay khi mở app.</div>
          </div>
          <div class="set-ctrl">
            <select id="startview" onchange="App.setStartView(this.value)">
              ${[['dashboard', '🏠 Tổng quan'], ['learn', '🎓 Bài học hôm nay'],
                 ['flashcards', '🃏 Flashcard ôn tập'], ['auto', '⚡ Tự động chọn']]
                .map(([v, n]) => `<option value="${v}" ${S.startView === v ? 'selected' : ''}>${n}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="set-row">
          <div>
            <div class="set-name">📣 Bài học tự đến qua thông báo</div>
            <div class="set-desc">Máy chủ gửi từ vựng theo 3 khung giờ — <b>app đóng vẫn nhận được</b>.</div>
          </div>
          <div class="set-ctrl" style="flex-wrap:wrap">
            <input type="time" value="${S.push.times[0]}" onchange="App.setPushTime(0,this.value)">
            <input type="time" value="${S.push.times[1]}" onchange="App.setPushTime(1,this.value)">
            <input type="time" value="${S.push.times[2]}" onchange="App.setPushTime(2,this.value)">
            <button class="btn btn-sm ${S.push.enabled ? 'btn-green' : 'btn-outline'}" onclick="App.togglePush()">${S.push.enabled ? '✓ Đang bật' : 'Bật'}</button>
          </div>
        </div>
        <div class="set-row">
          <div>
            <div class="set-name">🔔 Nhắc học khi đang mở app</div>
            <div class="set-desc">Nhắc nhẹ nếu đến giờ mà hôm nay bạn chưa học.</div>
          </div>
          <div class="set-ctrl">
            <input type="time" id="remind-time" value="${S.reminder.time}" onchange="App.setReminderTime(this.value)">
            <button class="btn btn-sm ${S.reminder.enabled ? 'btn-green' : 'btn-outline'}" id="btn-remind" onclick="App.toggleReminder()">${S.reminder.enabled ? '✓ Đang bật' : 'Bật'}</button>
          </div>
        </div>
        ${cur === -1 ? '' : `<div class="set-row">
          <div>
            <div class="set-name">📅 Mỗi ngày học khoảng</div>
            <div class="set-desc">Còn <b>${remaining}</b> ngày · dự kiến xong <b style="color:var(--green)">${finishStr}</b></div>
          </div>
          <div class="set-ctrl">
            <select id="mpd" onchange="App.setMinutes(this.value)">
              ${[5, 10, 15, 30, 45].map(m => `<option value="${m}" ${S.minutesPerDay === m ? 'selected' : ''}>${m} phút</option>`).join('')}
            </select>
          </div>
        </div>`}
        <div class="set-row" id="install-row" style="display:${installEvt ? 'flex' : 'none'}">
          <div>
            <div class="set-name">📲 Cài đặt lên thiết bị</div>
            <div class="set-desc">Thêm vào màn hình chính, mở như app thật.</div>
          </div>
          <div class="set-ctrl"><button class="btn btn-sm btn-outline" onclick="App.installApp()">Cài đặt</button></div>
        </div>
        <div class="set-row">
          <div>
            <div class="set-name">👤 Tài khoản: ${esc(CURRENT || '')}</div>
            <div class="set-desc">Tiến độ đồng bộ trên mọi thiết bị của bạn.</div>
          </div>
          <div class="set-ctrl"><button class="btn btn-sm btn-outline" onclick="App.logout()">Đăng xuất</button></div>
        </div>
        <div class="set-row">
          <div>
            <div class="set-name">🔄 Làm lại từ đầu</div>
            <div class="set-desc">Xóa tiến độ và làm lại kiểm tra đầu vào.</div>
          </div>
          <div class="set-ctrl"><button class="btn btn-sm btn-outline btn-danger" onclick="App.resetAll()">Đặt lại</button></div>
        </div>
      </div>`;
  }

  // ---------- Lộ trình ----------
  function dayCardHtml(d, i, cur) {
    const lbl = dayLabel(d, i);
    const done = S.done.includes(i);
    const locked = !done && i !== cur;
    const special = d.t === 'review' || d.t === 'final';
    const cls = ['day-card', special ? 'review' : '', d.t === 'checkpoint' ? 'checkpoint' : '',
      done ? 'done' : '', i === cur ? 'current' : '', locked ? 'locked' : ''].join(' ');
    return `<button class="${cls}" ${locked ? 'disabled' : `onclick="App.go('day',${i})"`}>
      <span class="d-num">Ngày ${i + 1}</span>
      <span class="d-ico">${lbl.icon}</span>
      <span class="d-name">${lbl.name}</span>
    </button>`;
  }

  function renderRoadmap() {
    const cur = currentDayIdx();
    const curStage = currentStage();
    const hasStages = S.plan.some(d => typeof d.stage === 'number');
    let sections;
    if (hasStages) {
      sections = STAGES.map((st, si) => ({ st, si, idxs: daysInStage(si) })).filter(s => s.idxs.length);
    } else {
      sections = [{ st: null, si: 0, idxs: S.plan.map((_, i) => i) }];
    }

    const html = sections.map(({ st, si, idxs }) => {
      const total = idxs.length;
      const doneN = idxs.filter(i => S.done.includes(i)).length;
      const pct = Math.round(doneN / total * 100);
      const isDone = doneN === total;
      const isCurrent = si === curStage && !isDone;
      // Chỉ MỞ chặng đang xem — các chặng khác gấp lại để trang không dài lê thê
      const open = (openStage === null ? isCurrent : openStage === si);
      const cards = open ? idxs.map(i => dayCardHtml(S.plan[i], i, cur)).join('') : '';
      let header = '';
      if (st) {
        header = `<button class="stage-head ${open ? 'open' : ''}" style="--sc:${st.color}" onclick="App.toggleStage(${si})">
          <div class="stage-head-top">
            <div class="stage-title">${st.icon} Chặng ${si + 1}: ${st.name}
              ${isDone ? '<span class="stage-badge">✓ Xong</span>' : isCurrent ? '<span class="stage-badge cur">Đang học</span>' : ''}
            </div>
            <span class="stage-caret">${open ? '▾' : '▸'}</span>
          </div>
          <div class="stage-meta">
            <div class="mini-bar"><div style="width:${pct}%;background:${st.color}"></div></div>
            <span class="td-sub">${doneN}/${total}</span>
          </div>
          ${open ? `<div class="stage-goal">🎯 Học xong bạn có thể: ${esc(st.goal)}</div>` : ''}
        </button>`;
      }
      const testOut = (open && isCurrent)
        ? `<button class="btn btn-sm btn-outline" style="margin-bottom:12px" onclick="App.startTestOut(${si})">🎓 Thi vượt chặng này</button>` : '';
      return `<div class="stage-block ${isCurrent ? 'active' : ''}">${header}${testOut}
        ${open ? `<div class="roadmap-grid">${cards}</div>` : ''}</div>`;
    }).join('');

    main().innerHTML = `
      <div class="view-title" style="margin-bottom:4px">🗺️ Lộ trình ${S.plan.length} ngày</div>
      <div class="view-sub" style="margin-bottom:18px">${STAGES.length} chặng · chạm vào tên chặng để mở/gấp</div>
      ${html}`;
  }

  let openStage = null;   // null = tự mở chặng đang học
  function toggleStage(si) {
    openStage = (openStage === null ? currentStage() : openStage) === si ? -1 : si;
    renderRoadmap();
  }

  // ---------- Ngày học ----------
  let quizState = null;

  function renderDay(i) {
    const d = S.plan[i];
    if (d.t === 'lesson') renderLesson(i, d.topics, 0);
    else if (d.t === 'review') startQuiz(i, buildReviewQuiz(10, d.adaptive), d.adaptive ? 'Ôn tập điểm yếu' : 'Ôn tập tổng hợp', true);
    else if (d.t === 'checkpoint') startQuiz(i, buildStageQuiz(stageOf(d), 12), `Checkpoint: ${STAGES[stageOf(d)].name}`, true, [], 60);
    else if (d.kind === 'quiz') startQuiz(i, buildReviewQuiz(15), 'Bài kiểm tra cuối khóa', true);
    else renderSpeakingChallenge(i);
  }

  function renderLesson(dayIdx, topicIds, tab) {
    // Tab 0 = buổi học tương tác (mặc định). Các tab sau chỉ để TRA CỨU lại.
    if (tab === 0) { startLearnSession(dayIdx, topicIds); return; }
    tab -= 1;
    const ts = topicIds.map(topicById);
    const tabNames = ['🎓 Học', '📖 Từ vựng', '🗣️ Cụm giao tiếp', '💬 Mẫu câu', '🎭 Hội thoại'];
    const tabsHtml = tabNames.map((n, k) =>
      `<button class="tab ${k === tab + 1 ? 'active' : ''}" onclick="App.lessonTab(${dayIdx},${k})">${n}</button>`).join('');

    let body = '';
    if (tab === 0) {
      const cando = ts.map(t => typeof CANDO !== 'undefined' && CANDO[t.id] ? CANDO[t.id] : null).filter(Boolean);
      const candoHtml = cando.length ? `<div class="cando-banner">✅ <b>Học xong bạn có thể:</b> ${cando.map(esc).join(' · ')}</div>` : '';
      body = candoHtml + ts.map(t => `
        <h3 style="margin:18px 0 12px">${t.icon} ${t.name} <span style="color:var(--muted);font-weight:400;font-size:13px">· ${t.nameEn}</span></h3>
        <div class="vocab-list">${t.vocab.map(v => `
          <div class="vocab-card">
            <div class="v-word">${esc(v.w)} <button class="speak-btn" onclick="App.speak('${js(v.w)}')">🔊</button></div>
            <div class="v-ipa">${esc(v.ipa)}</div>
            <div class="v-mean">${esc(v.m)}</div>
            <div class="v-ex">"${esc(v.ex)}" <button class="speak-btn" style="font-size:12px" onclick="App.speak('${js(v.ex)}')">🔊</button></div>
          </div>`).join('')}
        </div>`).join('');
    } else if (tab === 1) {
      body = ts.map(t => `
        <h3 style="margin:18px 0 12px">${t.icon} ${t.name} <span style="color:var(--muted);font-weight:400;font-size:13px">· nói nguyên cụm, đừng ghép từng từ!</span></h3>
        ${(t.chunks || []).map(k => `
          <div class="phrase-item chunk-item">
            <div style="flex:1">
              <div class="p-en">${esc(k.c)}</div>
              <div class="p-vi">${esc(k.m)}</div>
              <div class="chunk-use">📌 Khi dùng: ${esc(k.use)}</div>
              <div class="chunk-ex">“${esc(k.ex)}”</div>
            </div>
            <button class="speak-btn" onclick="App.speak('${js(k.c)}')">🔊</button>
          </div>`).join('')}`).join('');
    } else if (tab === 2) {
      body = ts.map(t => `
        <h3 style="margin:18px 0 12px">${t.icon} ${t.name}</h3>
        ${t.phrases.map(p => `
          <div class="phrase-item">
            <div><div class="p-en">${esc(p.en)}</div><div class="p-vi">${esc(p.vi)}</div></div>
            <button class="speak-btn" onclick="App.speak('${js(p.en)}')">🔊</button>
          </div>`).join('')}`).join('');
    } else if (tab === 3) {
      body = ts.map(t => `
        <h3 style="margin:18px 0 12px">${t.icon} ${t.name}</h3>
        <div class="dialog-box">
          <div style="margin-bottom:14px"><button class="btn btn-outline btn-sm" onclick="App.playDialogue('${t.id}')">▶️ Nghe cả đoạn hội thoại</button></div>
          ${t.dialogue.map(l => `
            <div class="dlg-line ${l.who === 'B' ? 'b' : ''}">
              <div class="who">${l.who}</div>
              <div class="bubble">
                <div class="en">${esc(l.en)} <button class="speak-btn" style="font-size:11px;padding:2px 6px" onclick="App.speak('${js(l.en)}')">🔊</button></div>
                <div class="vi">${esc(l.vi)}</div>
              </div>
            </div>`).join('')}
        </div>`).join('');
    }

    main().innerHTML = `
      <div class="lesson-head">
        <button class="back" onclick="App.go('roadmap')">← Lộ trình</button>
        <div class="view-title" style="margin:0;font-size:22px">Ngày ${dayIdx + 1}: ${ts.map(t => t.name).join(' + ')}</div>
      </div>
      <div class="tabs">${tabsHtml}</div>
      <div class="ref-note">📚 Đây là phần tra cứu. Muốn <b>học và nhớ thật</b>, hãy vào tab <b>🎓 Học</b> để luyện tương tác.</div>
      ${body}
      <div style="margin-top:24px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="App.lessonTab(${dayIdx},0)">🎓 Bắt đầu học tương tác</button>
        ${tab < 3 ? `<button class="btn btn-outline" onclick="App.lessonTab(${dayIdx},${tab + 2})">${tabNames[tab + 2]} →</button>` : ''}
      </div>`;
  }

  function lessonTab(dayIdx, tab) {
    const d = S.plan[dayIdx];
    renderLesson(dayIdx, d.topics, tab);
  }

  function playDialogue(topicId) {
    const t = topicById(topicId);
    speechSynthesis.cancel();
    t.dialogue.forEach(l => {
      const u = new SpeechSynthesisUtterance(l.en);
      u.lang = 'en-US'; u.rate = 0.9;
      if (l.who === 'B') u.pitch = 1.25;
      speechSynthesis.speak(u);
    });
  }

  function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  // ============================================================
  // HỌC CHỦ ĐỘNG (kiểu Memrise): không đọc danh sách — mỗi từ đi qua
  // chuỗi bài tập tăng dần độ khó, sai thì lặp lại tới khi thuộc.
  // Học theo từng nhóm 4 từ: giới thiệu → kiểm tra xen kẽ → nhóm tiếp theo.
  // ============================================================
  let LS = null;          // phiên học hiện tại
  const BATCH = 4;

  const norm = s => String(s).toLowerCase().replace(/[.,!?"'’‘“”]/g, '').replace(/\s+/g, ' ').trim();

  function startLearnSession(dayIdx, topicIds) {
    const pool = poolOf(topicIds);
    LS = {
      dayIdx, topicIds, pool,
      items: shuffle(pool),
      bi: 0, queue: [], done: 0, wrong: 0,
      learned: new Set(), tries: {}, tStart: 0,
    };
    nextBatch();
  }

  // Tách câu ví dụ thành dạng khuyết (che chính từ/cụm đang học)
  function clozeOf(v) {
    const esc0 = v.w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(esc0, 'i');
    if (!re.test(v.ex)) return null;
    return v.ex.replace(re, '_____');
  }

  // Ba tầng độ khó — "giàn giáo": hỗ trợ nhiều lúc đầu, rút dần khi đã vững
  function tiersFor(v) {
    const multi = v.w.includes(' ');
    const hasCloze = !!clozeOf(v);
    const easy = ['mc_word', 'mc_meaning'];
    const mid = ['listen', 'listen_mean'].concat(hasCloze ? ['cloze_mc'] : []);
    const hard = (multi ? ['scramble'] : ['type']).concat(hasCloze && !multi ? ['cloze_type'] : []).concat(['speak']);
    return [easy, mid, hard];
  }

  // Bài kiểm tra cho một mục, KHÓ DẦN theo tầng (không bốc ngẫu nhiên toàn bộ)
  function buildTestsFor(v) {
    const t = tiersFor(v);
    const key = v.tid + '|' + v.w;
    const card = S.srs[key];
    // Thẻ đang bị đánh dấu khó → hạ một bậc để người học có cơ hội thành công
    if (card && card.hard) return [{ type: pick(t[0]), v }, { type: pick(t[0]), v }, { type: pick(t[1]), v }];
    return [{ type: pick(t[0]), v }, { type: pick(t[1]), v }, { type: pick(t[2]), v }];
  }
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  // Dạng dễ hơn khi làm sai, tránh chuỗi thất bại liên tiếp gây nản
  const easierType = v => pick(tiersFor(v)[0]);

  // Xoay mảng để phần tử đầu không trùng mục với câu liền trước
  function avoidClash(arr, prev) {
    if (!prev || !arr.length) return arr;
    for (let k = 0; k < arr.length; k++) {
      if (arr[0].v.w !== prev.v.w) break;
      arr.push(arr.shift());
    }
    return arr;
  }

  function nextBatch() {
    const items = LS.items.slice(LS.bi * BATCH, (LS.bi + 1) * BATCH);
    if (!items.length) return finishLearn();
    const perItem = items.map(buildTestsFor);      // mỗi mục: [dễ, vừa, khó]

    // VÒNG 1 — giới thiệu TỪNG từ rồi kiểm tra NGAY từ đó.
    // (Trước đây dồn 4 thẻ giới thiệu liên tiếp → phải nhớ 4 từ cùng lúc, rất khó.)
    const q = [];
    items.forEach((v, i) => { q.push({ type: 'present', v }); q.push(perItem[i][0]); });

    // VÒNG 2 & 3 — trộn đều cả nhóm, độ khó tăng dần, cách xa lần gặp trước
    const r2 = avoidClash(shuffle(perItem.map(l => l[1]).filter(Boolean)), q[q.length - 1]);
    q.push(...r2);
    const r3 = avoidClash(shuffle(perItem.map(l => l[2]).filter(Boolean)), q[q.length - 1]);
    q.push(...r3);

    LS.queue = q;
    LS.bi++;
    renderLearnTurn();
  }

  function learnProgress() {
    const total = LS.items.length;
    const pct = Math.round(LS.learned.size / total * 100);
    return `<div class="learn-top">
        <button class="back" onclick="App.go('roadmap')">← Thoát</button>
        <div class="learn-bar"><div style="width:${pct}%"></div></div>
        <div class="learn-count">${LS.learned.size}/${total}</div>
      </div>`;
  }

  // Phương án nhiễu: ưu tiên lỗi sai THẬT người học từng gõ cho chính mục này,
  // sau đó mới lấy các mục cùng chủ đề (nhiễu ngẫu nhiên dạy được rất ít).
  function mcOptions(v, key) {
    const opts = [{ text: v[key], ok: true }];
    if (key === 'w') {
      const mine = (S.mistakes[v.tid + '|' + v.w] || []).filter(m => norm(m) !== norm(v.w));
      if (mine.length) opts.push({ text: mine[0], ok: false });
    }
    const others = shuffle(LS.pool.filter(x => x.w !== v.w && norm(x[key]) !== norm(v[key])));
    for (const o of others) {
      if (opts.length >= 4) break;
      if (!opts.some(x => norm(x.text) === norm(o[key]))) opts.push({ text: o[key], ok: false });
    }
    return shuffle(opts);          // xáo thật ngẫu nhiên, tránh học vẹt vị trí đáp án
  }

  function renderLearnTurn() {
    const t = LS.queue[0];
    if (!t) return nextBatch();
    const v = t.v;
    LS.tStart = Date.now();          // bấm giờ để suy ra mức độ chắc chắn khi trả lời

    if (t.type === 'present') {
      main().innerHTML = `${learnProgress()}
        <div class="learn-stage">
          <div class="learn-tag">✨ Từ mới</div>
          <div class="present-card">
            <div class="pc-word">${esc(v.w)}</div>
            ${v.ipa ? `<div class="pc-ipa">${esc(v.ipa)}</div>` : ''}
            <button class="btn btn-outline btn-sm" onclick="App.speak('${js(v.w)}')">🔊 Nghe lại</button>
            <div class="pc-mean">${esc(v.m)}</div>
            <div class="pc-ex">"${esc(v.ex)}" <button class="speak-btn" style="font-size:12px" onclick="App.speak('${js(v.ex)}')">🔊</button></div>
          </div>
          <button class="btn btn-primary btn-lg" style="max-width:420px" onclick="App.learnNext()">Tôi đã nhớ, tiếp tục →</button>
        </div>`;
      setTimeout(() => speak(v.w), 250);
      return;
    }

    // --- Nhóm bài trắc nghiệm (chọn phương án đúng) ---
    const MC = {
      mc_word:     { tag: '🧠 Nhận diện', key: 'w', q: () => `Chọn từ/cụm có nghĩa: <b>“${esc(v.m)}”</b>`, play: false },
      mc_meaning:  { tag: '💭 Hiểu nghĩa', key: 'm', q: () => `<b>“${esc(v.w)}”</b> có nghĩa là gì?`, play: true },
      listen:      { tag: '👂 Nghe hiểu', key: 'w', q: () => '🔊 Bạn vừa nghe từ/cụm nào?', play: true, auto: true },
      listen_mean: { tag: '👂 Nghe &amp; hiểu', key: 'm', q: () => '🔊 Nghe rồi chọn nghĩa đúng:', play: true, auto: true },
      cloze_mc:    { tag: '🧩 Chọn từ còn thiếu', key: 'w', q: () => `Chọn đáp án điền vào chỗ trống:<div class="cloze-sent">“${esc(clozeOf(v))}”</div>`, play: false },
    };
    if (MC[t.type]) {
      const c = MC[t.type];
      const opts = mcOptions(v, c.key);
      main().innerHTML = `${learnProgress()}
        <div class="learn-stage">
          <div class="learn-tag">${c.tag}</div>
          <div class="learn-q">${c.q()}
            ${c.play ? `<button class="speak-btn" onclick="App.speak('${js(v.w)}')">🔊</button>` : ''}</div>
          <div class="quiz-opts" id="learn-opts">
            ${opts.map((o, i) => `<button class="opt" onclick="App.learnAnswer(${i},${o.ok})">${esc(o.text)}</button>`).join('')}
          </div>
        </div>`;
      LS.answerKey = c.key;                       // để tô đúng đáp án khi trả lời sai
      if (c.auto) setTimeout(() => speak(v.w), 300);
      return;
    }

    // --- Gõ đáp án: tự viết hoặc điền vào chỗ trống ---
    if (t.type === 'type' || t.type === 'cloze_type') {
      const isCloze = t.type === 'cloze_type';
      main().innerHTML = `${learnProgress()}
        <div class="learn-stage">
          <div class="learn-tag">${isCloze ? '✏️ Điền khuyết' : '⌨️ Tự viết'}</div>
          <div class="learn-q">${isCloze
            ? `Điền từ còn thiếu vào chỗ trống:<div class="cloze-sent">“${esc(clozeOf(v))}”</div>`
            : `Gõ từ tiếng Anh có nghĩa: <b>“${esc(v.m)}”</b>`}</div>
          <input id="learn-input" class="learn-input" type="text" autocomplete="off" autocapitalize="off"
                 spellcheck="false" placeholder="Gõ tại đây…">
          <div class="learn-hint">Gợi ý: ${v.w.length} chữ cái, bắt đầu bằng “${esc(v.w[0])}”${isCloze ? '' : ` · nghĩa: ${esc(v.m)}`}</div>
          <div id="learn-fb" class="learn-fb"></div>
          <button class="btn btn-primary btn-lg" style="max-width:420px" onclick="App.learnCheckType()">Kiểm tra</button>
        </div>`;
      const inp = document.getElementById('learn-input');
      inp.focus();
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') learnCheckType(); });
      return;
    }

    // --- Nói theo (chấm điểm phát âm) ---
    if (t.type === 'speak') { renderLearnSpeak(v); return; }

    // --- Ghép câu: sắp xếp các mảnh thành đúng thứ tự ---
    LS.scrambled = shuffle(v.w.split(/\s+/).map((w, i) => ({ w, i })));
    LS.picked = [];
    renderScramble(v);
  }

  function renderLearnSpeak(v) {
    const supported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    main().innerHTML = `${learnProgress()}
      <div class="learn-stage">
        <div class="learn-tag">🎤 Nói theo</div>
        <div class="learn-q">Đọc to cụm sau bằng tiếng Anh:</div>
        <div class="present-card" style="padding:22px">
          <div class="pc-word" style="font-size:26px">${esc(v.w)}</div>
          <div class="pc-mean" style="font-size:15px">${esc(v.m)}</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">
          <button class="btn btn-outline btn-sm" onclick="App.speak('${js(v.w)}')">🔊 Nghe mẫu</button>
          <button class="btn btn-outline btn-sm" onclick="App.speak('${js(v.w)}',0.6)">🐢 Nghe chậm</button>
        </div>
        <div class="mic-btn" id="learn-mic" onclick="App.learnSpeakStart()">🎙️</div>
        <div style="color:var(--muted);font-size:13px">${supported ? 'Nhấn micro rồi đọc to' : '⚠️ Trình duyệt này không chấm được phát âm'}</div>
        <div id="learn-fb" class="learn-fb"></div>
        <button class="btn btn-ghost" onclick="App.learnSpeakSkip()">${supported ? 'Bỏ qua chấm điểm ✓' : 'Tôi đã đọc xong ✓'}</button>
      </div>`;
    setTimeout(() => speak(v.w), 350);
  }

  let learnRecog = null;
  function learnSpeakStart() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const fb = document.getElementById('learn-fb');
    if (!SR) { fb.className = 'learn-fb bad'; fb.textContent = '⚠️ Hãy dùng Chrome để chấm phát âm, hoặc bấm "Tôi đã đọc xong".'; return; }
    if (learnRecog) { learnRecog.stop(); return; }
    const v = LS.queue[0].v;
    const mic = document.getElementById('learn-mic');
    learnRecog = new SR();
    learnRecog.lang = 'en-US';
    learnRecog.interimResults = false;
    mic.classList.add('rec');
    fb.className = 'learn-fb';
    fb.textContent = 'Đang nghe… đọc to lên nhé 🎧';
    learnRecog.onresult = e => {
      const said = e.results[0][0].transcript;
      const score = similarity(v.w, said);
      const ok = score >= 60;
      fb.innerHTML = `Bạn nói: "<i>${esc(said)}</i>" — <b>${score} điểm</b>`;
      setTimeout(() => showLearnFeedback(ok, v), 500);
    };
    learnRecog.onerror = () => { fb.className = 'learn-fb bad'; fb.textContent = '⚠️ Không nghe được. Thử lại hoặc bấm "Bỏ qua chấm điểm".'; };
    learnRecog.onend = () => { mic.classList.remove('rec'); learnRecog = null; };
    try { learnRecog.start(); } catch (e) {}
  }

  function learnSpeakSkip() { showLearnFeedback(true, LS.queue[0].v); }

  function renderScramble(v) {
    main().innerHTML = `${learnProgress()}
      <div class="learn-stage">
        <div class="learn-tag">🧩 Ghép câu</div>
        <div class="learn-q">Sắp xếp thành cụm có nghĩa: <b>“${esc(v.m)}”</b></div>
        <div class="scr-answer" id="scr-answer">${LS.picked.map((p, i) =>
          `<button class="scr-tile picked" onclick="App.learnUnpick(${i})">${esc(p.w)}</button>`).join('') ||
          '<span class="scr-empty">Chạm vào các từ bên dưới…</span>'}</div>
        <div class="scr-bank">${LS.scrambled.map((p, i) =>
          `<button class="scr-tile" onclick="App.learnPick(${i})">${esc(p.w)}</button>`).join('')}</div>
        <div id="learn-fb" class="learn-fb"></div>
        <button class="btn btn-primary btn-lg" style="max-width:420px" onclick="App.learnCheckScramble()">Kiểm tra</button>
      </div>`;
  }

  function learnPick(i) {
    LS.picked.push(LS.scrambled[i]);
    LS.scrambled.splice(i, 1);
    renderScramble(LS.queue[0].v);
  }
  function learnUnpick(i) {
    LS.scrambled.push(LS.picked[i]);
    LS.picked.splice(i, 1);
    renderScramble(LS.queue[0].v);
  }

  function learnCheckScramble() {
    const v = LS.queue[0].v;
    const ok = norm(LS.picked.map(p => p.w).join(' ')) === norm(v.w);
    showLearnFeedback(ok, v);
  }

  function learnCheckType() {
    const v = LS.queue[0].v;
    const val = document.getElementById('learn-input').value;
    showLearnFeedback(norm(val) === norm(v.w), v, false, val);   // lưu cả cách gõ sai
  }

  function learnAnswer(i, ok) {
    const v = LS.queue[0].v;
    const right = norm(v[LS.answerKey || 'w']);          // đáp án đúng có thể là từ hoặc nghĩa
    const btns = document.querySelectorAll('#learn-opts .opt');
    btns.forEach(b => b.disabled = true);
    btns.forEach(b => { if (norm(b.textContent) === right) b.classList.add('correct'); });
    if (!ok) btns[i].classList.add('wrong');
    showLearnFeedback(ok, v, true);
  }

  function showLearnFeedback(ok, v, silent, userAnswer) {
    const fb = document.getElementById('learn-fb');
    recordLearn(ok, v, userAnswer);
    if (fb) {
      fb.className = 'learn-fb ' + (ok ? 'good' : 'bad');
      fb.innerHTML = ok
        ? `✓ Chính xác! <b>${esc(v.w)}</b> = ${esc(v.m)}`
        : `✗ Đáp án đúng: <b>${esc(v.w)}</b> = ${esc(v.m)}<br><span style="opacity:.8">"${esc(v.ex)}"</span>`;
    }
    if (ok) speak(v.w);
    setTimeout(() => { LS.queue.shift(); renderLearnTurn(); }, ok ? 900 : 2300);
  }

  function recordLearn(ok, v, userAnswer) {
    const key = v.tid + '|' + v.w;
    const type = (LS.queue[0] || {}).type || 'mc_word';
    const ms = LS.tStart ? Date.now() - LS.tStart : 6000;
    gradeItem(key, ok, ms, type, userAnswer);
    if (ok) {
      LS.learned.add(v.w);
    } else {
      LS.wrong++;
      LS.learned.delete(v.w);
      // Sai → gặp lại NGAY TRONG PHIÊN: lần 1 chèn sau 3 câu, lần 2 sau 5 câu, lần 3 xuống cuối
      LS.tries[key] = (LS.tries[key] || 0) + 1;
      const n = LS.tries[key];
      const pos = n === 1 ? 3 : n === 2 ? 5 : LS.queue.length;
      LS.queue.splice(Math.min(pos, LS.queue.length), 0, { type: easierType(v), v });
    }
    save();
  }

  function learnNext() {
    const t = LS.queue.shift();
    if (t && t.type === 'present') LS.learned.add(t.v.w);
    renderLearnTurn();
  }

  function finishLearn() {
    markDone(LS.dayIdx);
    LS.topicIds.forEach(addTopicToSrs);
    const total = LS.items.length;
    // Đếm từ mới trong ngày — học dồn quá nhiều hôm nay = ngày mai ôn ngập đầu
    const td = todayStr();
    if (S.newToday.d !== td) S.newToday = { d: td, n: 0 };
    S.newToday.n += total;
    save();
    const over = S.newToday.n > NEW_SOFT_CAP;
    const cur = currentDayIdx();
    main().innerHTML = `
      <div class="quiz-box" style="text-align:center;padding-top:40px;margin:0 auto">
        <div style="font-size:60px;margin-bottom:14px">🎉</div>
        <div class="view-title">Hoàn thành buổi học!</div>
        <p style="color:var(--muted);margin:10px 0 24px">
          Bạn đã học <b style="color:var(--text)">${total}</b> từ &amp; cụm giao tiếp${LS.wrong ? `, sai ${LS.wrong} lần (đã ghi nhớ để ôn thêm)` : ' — không sai lần nào! 👏'}.<br>
          Lần ôn đầu tiên sẽ đến <b style="color:var(--green)">sau khoảng 10 phút</b>, rồi 4 giờ, rồi 1 ngày…
        </p>
        ${over ? `<p style="color:var(--yellow);font-size:13.5px;margin:-10px 0 18px">
          ⚠️ Hôm nay bạn đã học ${S.newToday.n} từ mới. Học thêm nữa thì ngày mai sẽ có rất nhiều thẻ ôn dồn về —
          nên dừng ở đây và dành thời gian ôn lại thì nhớ chắc hơn.</p>` : ''}
        ${cur !== -1
          ? `<button class="btn btn-primary btn-lg" style="max-width:340px" onclick="App.go('day',${cur})">Học tiếp ngày sau →</button>`
          : `<button class="btn btn-primary btn-lg" style="max-width:340px" onclick="App.go('dashboard')">🎓 Xem tổng kết</button>`}
        <div><button class="btn btn-ghost" onclick="App.go('roadmap')">Về lộ trình</button></div>
      </div>`;
    LS = null;
  }

  // ---------- Quiz ----------

  // pool item mang theo tid (topic id) để chấm điểm yếu; makeQuestion gắn `item`
  const poolOf = ids => [...new Set(ids)].flatMap(id => vocabOf(topicById(id)).map(v => ({ ...v, tid: id })));

  function makeQuestion(v, pool, type) {
    const others = shuffle(pool.filter(x => x.w !== v.w)).slice(0, 3);
    const item = v.tid ? { tid: v.tid, w: v.w } : null;
    if (type === 0) { // nghĩa -> từ
      const opts = shuffle([v.w, ...others.map(o => o.w)]);
      return { q: `Từ/cụm tiếng Anh nào có nghĩa là “${v.m}”?`, opts, a: opts.indexOf(v.w), item };
    }
    if (type === 1) { // từ -> nghĩa
      const opts = shuffle([v.m, ...others.map(o => o.m)]);
      return { q: `“${v.w}” có nghĩa là gì?`, opts, a: opts.indexOf(v.m), listen: v.w, item };
    }
    if (type === 2) { // nghe -> chọn từ
      const opts = shuffle([v.w, ...others.map(o => o.w)]);
      return { q: '🔊 Nghe và chọn đáp án bạn nghe được:', opts, a: opts.indexOf(v.w), listen: v.w, auto: true, item };
    }
    // điền vào chỗ trống trong câu ví dụ
    const blanked = v.ex.replace(new RegExp(v.w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '_____');
    const opts = shuffle([v.w, ...others.map(o => o.w)]);
    return { q: `Điền vào chỗ trống: “${blanked}”`, opts, a: opts.indexOf(v.w), item };
  }

  // Ưu tiên chỗ yếu: đưa các mục hay sai (S.weak) lên đầu pool trước khi lấy n mục
  function pickWeakFirst(pool, n) {
    const weakKeys = new Set(Object.keys(S.weak));
    const weak = shuffle(pool.filter(v => weakKeys.has(v.tid + '|' + v.w)));
    const rest = shuffle(pool.filter(v => !weakKeys.has(v.tid + '|' + v.w)));
    return [...weak, ...rest].slice(0, n);
  }

  function buildTopicQuiz(topicIds) {
    const pool = poolOf(topicIds);
    const picked = shuffle(pool).slice(0, 10);
    return picked.map((v, i) => makeQuestion(v, pool, i % 4));
  }

  function buildReviewQuiz(n, adaptive) {
    let ids = learnedTopicIds();
    if (ids.length === 0) ids = [TOPICS[0].id];
    const pool = poolOf(ids);
    const picked = adaptive ? pickWeakFirst(pool, n) : shuffle(pool).slice(0, n);
    return picked.map((v, i) => makeQuestion(v, pool, i % 4));
  }

  // Quiz của cả một chặng (dùng cho checkpoint & thi vượt chặng)
  function buildStageQuiz(stageIdx, n) {
    const ids = STAGES[stageIdx].topics.filter(topicById);
    const pool = poolOf(ids);
    const picked = shuffle(pool).slice(0, Math.min(n, pool.length));
    return picked.map((v, i) => makeQuestion(v, pool, i % 4));
  }

  function startQuiz(dayIdx, questions, title, isReviewDay, topicIds, passPct) {
    quizState = { dayIdx, questions, idx: 0, correct: 0, isReviewDay, topicIds: topicIds || [], title, passPct: passPct || 60 };
    renderQuizQ();
  }

  function renderQuizQ() {
    const qs = quizState;
    const q = qs.questions[qs.idx];
    const title = qs.title || `Ngày ${qs.dayIdx + 1} — Quiz`;
    main().innerHTML = `
      <div class="lesson-head">
        <button class="back" onclick="App.go('roadmap')">← Lộ trình</button>
        <div class="view-title" style="margin:0;font-size:22px">✅ ${title}</div>
      </div>
      <div class="quiz-box">
        <div class="quiz-score">Câu ${qs.idx + 1}/${qs.questions.length} · Đúng: ${qs.correct}</div>
        <div class="quiz-progress"><div class="bar" style="width:${qs.idx / qs.questions.length * 100}%"></div></div>
        <div class="quiz-q">
          <div class="q-text">${q.q} ${q.listen ? `<button class="speak-btn" onclick="App.speak('${js(q.listen)}')">🔊</button>` : ''}</div>
          <div class="quiz-opts" id="quiz-opts">
            ${q.opts.map((o, i) => `<button class="opt" onclick="App.answerQuiz(${i})">${esc(o)}</button>`).join('')}
          </div>
        </div>
      </div>`;
    qs.tStart = Date.now();
    if (q.auto) setTimeout(() => speak(q.listen), 350);
  }

  function answerQuiz(i) {
    const qs = quizState;
    const q = qs.questions[qs.idx];
    const opts = document.querySelectorAll('#quiz-opts .opt');
    opts.forEach(b => b.disabled = true);
    opts[q.a].classList.add('correct');
    const ok = i === q.a;
    if (!ok) opts[i].classList.add('wrong');
    else qs.correct++;
    // Ôn tập thích ứng: cập nhật lịch ôn theo đúng/sai + thời gian trả lời
    if (q.item) {
      gradeItem(q.item.tid + '|' + q.item.w, ok, qs.tStart ? Date.now() - qs.tStart : 6000, 'mc_word');
    } else {
      S.quizStats.total++; if (ok) S.quizStats.correct++;
    }
    save();
    setTimeout(() => {
      qs.idx++;
      qs.idx < qs.questions.length ? renderQuizQ() : finishQuiz();
    }, ok ? 700 : 1400);
  }

  // Chèn 1 ngày vào lộ trình, dịch các chỉ số 'done' phía sau để không lệch
  function insertDay(pos, day) {
    S.plan.splice(pos, 0, day);
    S.done = S.done.map(idx => idx >= pos ? idx + 1 : idx);
    save();
  }

  function finishQuiz() {
    const qs = quizState;
    const pct = Math.round(qs.correct / qs.questions.length * 100);
    const passed = pct >= qs.passPct;

    // Thi vượt chặng: đạt → đánh dấu cả chặng hoàn thành + nạp từ vựng vào SRS
    if (typeof qs.testOut === 'number') {
      if (passed) {
        STAGES[qs.testOut].topics.forEach(addTopicToSrs);
        daysInStage(qs.testOut).forEach(i => { if (!S.done.includes(i)) S.done.push(i); });
        touchStreak();
        save();
      }
      const cur = currentDayIdx();
      main().innerHTML = `
        <div class="quiz-box" style="text-align:center;padding-top:40px">
          <div style="font-size:60px;margin-bottom:14px">${passed ? '🎓' : '💪'}</div>
          <div class="view-title">${passed ? 'Vượt chặng thành công!' : 'Chưa đạt — học bình thường nhé'}</div>
          <p style="color:var(--muted);margin:10px 0 24px">
            Đúng <b style="color:var(--text)">${qs.correct}/${qs.questions.length}</b> câu (${pct}%).
            ${passed ? `Bạn đã bỏ qua chặng "${STAGES[qs.testOut].name}" và toàn bộ từ vựng chặng này đã vào flashcard.` : 'Cần ≥ 80% để vượt chặng. Đừng lo, cứ học tuần tự sẽ vững hơn!'}
          </p>
          <button class="btn btn-primary btn-lg" style="max-width:340px" onclick="App.go('roadmap')">${passed ? 'Xem lộ trình →' : 'Về lộ trình'}</button>
        </div>`;
      return;
    }

    const day = S.plan[qs.dayIdx];
    let extraNote = '';
    if (passed) {
      markDone(qs.dayIdx);
      qs.topicIds.forEach(addTopicToSrs);
      // Ôn tập thích ứng: bài học có từ 3 lỗi trở lên → tự chèn 1 ngày "ôn điểm yếu" ngay sau
      const wrong = qs.questions.length - qs.correct;
      const nextIsAdaptive = S.plan[qs.dayIdx + 1] && S.plan[qs.dayIdx + 1].adaptive;
      if (day && day.t === 'lesson' && wrong >= 3 && !nextIsAdaptive) {
        insertDay(qs.dayIdx + 1, { t: 'review', stage: stageOf(day), adaptive: true });
        extraNote = 'Bạn sai khá nhiều — mình đã thêm một ngày <b>ôn điểm yếu</b> ngay sau để bạn nhớ chắc hơn.';
      }
    }
    const cur = currentDayIdx();
    // Vừa hoàn thành checkpoint → chúc mừng qua chặng
    let banner = '';
    if (passed && day && day.t === 'checkpoint') {
      const st = STAGES[stageOf(day)];
      banner = `<div class="stage-clear" style="border-color:${st.color}">
        <div style="font-size:15px;font-weight:800;color:${st.color}">🏅 Hoàn thành chặng: ${st.name}</div>
        <div style="font-size:13.5px;color:var(--muted);margin-top:4px">Giờ bạn đã có thể: ${esc(st.goal)}</div>
      </div>`;
    }
    main().innerHTML = `
      <div class="quiz-box" style="text-align:center;padding-top:40px">
        <div style="font-size:60px;margin-bottom:14px">${passed ? '🎉' : '💪'}</div>
        <div class="view-title">${passed ? 'Hoàn thành!' : 'Cố lên, thử lại nhé!'}</div>
        <p style="color:var(--muted);margin:10px 0 18px">
          Bạn trả lời đúng <b style="color:var(--text)">${qs.correct}/${qs.questions.length}</b> câu (${pct}%).
          ${passed ? 'Ngày học đã hoàn thành, từ vựng &amp; cụm giao tiếp đã vào bộ flashcard.' : `Cần đạt tối thiểu ${qs.passPct}% để qua ngày học.`}
        </p>
        ${banner}
        ${extraNote ? `<p style="color:var(--yellow);font-size:13.5px;margin-bottom:18px">${extraNote}</p>` : ''}
        ${passed
          ? (cur !== -1
              ? `<button class="btn btn-primary btn-lg" style="max-width:340px" onclick="App.go('day',${cur})">Học ngày tiếp theo →</button>`
              : `<button class="btn btn-primary btn-lg" style="max-width:340px" onclick="App.go('dashboard')">🎓 Xem tổng kết</button>`)
          : `<button class="btn btn-primary btn-lg" style="max-width:340px" onclick="App.go('day',${qs.dayIdx})">🔄 Làm lại</button>`}
        <div><button class="btn btn-ghost" onclick="App.go('roadmap')">Về lộ trình</button></div>
      </div>`;
  }

  // ---------- Thi vượt chặng (test-out) — cho người giỏi bỏ qua cả chặng ----------
  function startTestOut(stageIdx) {
    const st = STAGES[stageIdx];
    if (!confirm(`Thi vượt chặng "${st.name}"?\n\nBạn cần đúng ≥ 80% (12 câu) để bỏ qua toàn bộ chặng này. Nếu không đạt, bạn vẫn học bình thường.`)) return;
    testOutStage = stageIdx;
    quizState = { dayIdx: -1, questions: buildStageQuiz(stageIdx, 12), idx: 0, correct: 0, isReviewDay: true, topicIds: [], title: `🎓 Thi vượt: ${st.name}`, passPct: 80, testOut: stageIdx };
    renderQuizQ();
  }
  let testOutStage = null;

  // ---------- Flashcards (SRS) ----------
  let fcQueue = [], fcFlipped = false, fcStart = 0, fcOverflow = 0;

  function renderFlashcards() {
    const all = dueCards();
    // Ưu tiên thẻ khó + quá hạn lâu nhất, và chỉ lấy tối đa REVIEW_CAP mỗi phiên.
    // Nếu dồn 200 thẻ mà bắt ôn hết, người học sẽ bỏ app (bẫy "cục review dồn").
    const sorted = all.slice().sort((a, b) => (b.card.hard ? 1 : 0) - (a.card.hard ? 1 : 0));
    fcQueue = sorted.slice(0, REVIEW_CAP);
    fcOverflow = all.length - fcQueue.length;
    if (fcQueue.length === 0) {
      const total = Object.keys(S.srs).length;
      const next = Object.values(S.srs).map(c => c.due || 0).filter(d => d > Date.now()).sort((a, b) => a - b)[0];
      const inMin = next ? Math.round((next - Date.now()) / 60000) : 0;
      const when = !next ? '' : inMin < 60 ? `khoảng ${inMin} phút nữa`
        : inMin < 1440 ? `khoảng ${Math.round(inMin / 60)} giờ nữa` : `khoảng ${Math.round(inMin / 1440)} ngày nữa`;
      main().innerHTML = `
        <div class="view-title">🃏 Flashcard ôn tập</div>
        <div class="view-sub">Ôn tập ngắt quãng — hệ thống tự tính thời điểm ôn cho từng từ (10 phút → 4 giờ → 24 giờ → nhiều ngày).</div>
        <div class="empty-note">
          ${total === 0
            ? 'Chưa có thẻ nào. Hãy hoàn thành bài học đầu tiên trong lộ trình,<br>từ vựng sẽ tự động được thêm vào đây.'
            : `✨ Tuyệt vời! Không còn thẻ nào đến hạn.<br>${total} từ đang trong bộ nhớ${when ? ` · thẻ tiếp theo đến hạn ${when}` : ''}.`}
        </div>`;
      return;
    }
    renderFcCard();
  }

  function renderFcCard() {
    if (fcQueue.length === 0) {
      main().innerHTML = `
        <div class="view-title">🃏 Flashcard ôn tập</div>
        <div class="empty-note">🎉 Đã ôn xong phiên này!${fcOverflow > 0
          ? `<br>Còn ${fcOverflow} thẻ quá hạn — bấm "Ôn tiếp" nếu bạn còn thời gian.`
          : '<br>Thẻ bạn trả lời sai sẽ quay lại sau 10 phút.'}</div>
        <div style="text-align:center;display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
          ${fcOverflow > 0 ? '<button class="btn btn-primary" onclick="App.go(\'flashcards\')">Ôn tiếp →</button>' : ''}
          <button class="btn btn-outline" onclick="App.go('dashboard')">Về tổng quan</button>
        </div>`;
      touchStreak();
      return;
    }
    fcFlipped = false;
    fcStart = Date.now();
    const { v, card } = fcQueue[0];
    main().innerHTML = `
      <div class="view-title">🃏 Flashcard ôn tập</div>
      <div class="view-sub">Nhấn vào thẻ để lật · còn ${fcQueue.length} thẻ${card.hard ? ' · <b style="color:var(--yellow)">⚠️ từ khó</b>' : ''}${fcOverflow > 0 ? ` · ${fcOverflow} thẻ chờ phiên sau` : ''}</div>
      <div class="fc-stage">
        <div class="flashcard" id="fc" onclick="App.flipCard()">
          <div class="fc-inner">
            <div class="fc-face">
              <div class="big">${esc(v.w)}</div>
              <div class="ipa">${esc(v.ipa)}</div>
              <button class="speak-btn" onclick="event.stopPropagation();App.speak('${js(v.w)}')">🔊 Nghe</button>
              <div class="hint">Nhấn để xem nghĩa</div>
            </div>
            <div class="fc-face back">
              <div class="big">${esc(v.m)}</div>
              <div class="ex">"${esc(v.ex)}"</div>
              <div class="hint">Bạn có nhớ nghĩa từ này không?</div>
            </div>
          </div>
        </div>
        <div class="fc-actions">
          <button class="btn btn-outline" style="color:var(--red);border-color:rgba(255,107,122,.4)" onclick="App.gradeCard(false)">✗ Chưa nhớ</button>
          <button class="btn btn-green" onclick="App.gradeCard(true)">✓ Đã nhớ</button>
        </div>
      </div>`;
  }

  function flipCard() {
    fcFlipped = !fcFlipped;
    document.getElementById('fc').classList.toggle('flipped', fcFlipped);
  }

  function gradeCard(remembered) {
    const { key } = fcQueue.shift();
    const ms = fcStart ? Date.now() - fcStart : 6000;
    const c = gradeItem(key, remembered, ms, 'flashcard');
    // Sai → thẻ quay lại NGAY trong phiên này (sau 3 thẻ khác), không đợi ngày mai
    if (!remembered) {
      const again = dueCards().find(x => x.key === key);
      if (again) fcQueue.splice(Math.min(3, fcQueue.length), 0, again);
    }
    save();
    renderFcCard();
  }

  // ---------- Luyện nói ----------
  let speakPhrase = null, recog = null, speakDayIdx = null, speakCount = 0;

  function pickPhrase() {
    let ids = learnedTopicIds();
    if (ids.length === 0) ids = TOPICS.filter(t => t.level <= S.level).map(t => t.id);
    const pool = [...new Set(ids)].flatMap(id => topicById(id).phrases);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function renderSpeaking() {
    speakDayIdx = null; speakCount = 0;
    speakPhrase = pickPhrase();
    renderSpeakUI('🎤 Luyện nói', 'Nghe mẫu, sau đó nhấn micro và đọc to câu bên dưới. Hệ thống sẽ chấm điểm phát âm của bạn.');
  }

  function renderSpeakingChallenge(dayIdx) {
    speakDayIdx = dayIdx; speakCount = 0;
    speakPhrase = pickPhrase();
    renderSpeakUI(`🎤 Ngày ${dayIdx + 1}: Thử thách luyện nói`, 'Đọc đúng (≥60 điểm) 5 câu để hoàn thành ngày học này. Nhấn "Bỏ qua chấm điểm" nếu micro không hoạt động.');
  }

  function renderSpeakUI(title, sub) {
    const challenge = speakDayIdx !== null;
    main().innerHTML = `
      <div class="view-title">${title}</div>
      <div class="view-sub">${sub}</div>
      <div class="speak-card">
        ${challenge ? `<div class="quiz-score">Đã đạt: ${speakCount}/5 câu</div>` : ''}
        <div class="speak-target">"${esc(speakPhrase.en)}"</div>
        <div class="speak-vi">${esc(speakPhrase.vi)}</div>
        <button class="btn btn-outline btn-sm" onclick="App.speak('${js(speakPhrase.en)}')">🔊 Nghe mẫu</button>
        <button class="btn btn-outline btn-sm" onclick="App.speak('${js(speakPhrase.en)}', 0.6)">🐢 Nghe chậm</button>
        <div class="mic-btn" id="mic" onclick="App.toggleRecord()">🎙️</div>
        <div style="color:var(--muted);font-size:13px">Nhấn micro rồi đọc to</div>
        <div class="speak-result" id="speak-result"></div>
        <div style="margin-top:14px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
          <button class="btn btn-ghost" onclick="App.nextPhrase()">Câu khác ↻</button>
          ${challenge ? `<button class="btn btn-ghost" onclick="App.skipSpeakScore()">Bỏ qua chấm điểm ✓</button>` : ''}
        </div>
      </div>`;
  }

  function nextPhrase() {
    speakPhrase = pickPhrase();
    const title = speakDayIdx !== null ? `🎤 Ngày ${speakDayIdx + 1}: Thử thách luyện nói` : '🎤 Luyện nói';
    renderSpeakUI(title, speakDayIdx !== null ? 'Đọc đúng (≥60 điểm) 5 câu để hoàn thành ngày học này.' : 'Nghe mẫu, sau đó nhấn micro và đọc to câu bên dưới.');
  }

  function skipSpeakScore() {
    // dành cho môi trường không có micro / không hỗ trợ nhận dạng giọng nói
    registerSpeakSuccess();
  }

  function registerSpeakSuccess() {
    if (speakDayIdx === null) return;
    speakCount++;
    if (speakCount >= 5) {
      markDone(speakDayIdx);
      toast('🎉 Hoàn thành thử thách luyện nói!');
      go('roadmap');
    } else {
      nextPhrase();
    }
  }

  function toggleRecord() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const resBox = document.getElementById('speak-result');
    if (!SR) {
      resBox.innerHTML = '<span style="color:var(--yellow)">⚠️ Trình duyệt này chưa hỗ trợ nhận dạng giọng nói.<br>Hãy dùng Google Chrome, hoặc luyện bằng cách nghe mẫu và tự đọc theo.</span>';
      return;
    }
    const mic = document.getElementById('mic');
    if (recog) { recog.stop(); return; }
    recog = new SR();
    recog.lang = 'en-US';
    recog.interimResults = false;
    mic.classList.add('rec');
    resBox.textContent = 'Đang nghe... hãy đọc to câu trên 🎧';
    recog.onresult = e => {
      const said = e.results[0][0].transcript;
      const score = similarity(speakPhrase.en, said);
      const cls = score >= 80 ? 'score-good' : score >= 60 ? 'score-mid' : 'score-bad';
      const msg = score >= 80 ? 'Tuyệt vời! Phát âm rất tốt 👏' : score >= 60 ? 'Khá tốt! Luyện thêm chút nữa nhé 💪' : 'Chưa khớp lắm, nghe mẫu và thử lại nhé 🔁';
      resBox.innerHTML = `Bạn nói: "<i>${esc(said)}</i>"<br><span class="score-badge ${cls}">${score} điểm</span><br>${msg}`;
      if (score >= 60) setTimeout(registerSpeakSuccess, 1200);
    };
    recog.onerror = e => {
      resBox.innerHTML = `<span style="color:var(--yellow)">⚠️ Không nghe được (${e.error}). Kiểm tra micro và thử lại.</span>`;
    };
    recog.onend = () => { mic.classList.remove('rec'); recog = null; };
    try { recog.start(); } catch (e) {}
  }

  // So khớp từng từ giữa câu mẫu và câu người dùng nói
  function similarity(target, said) {
    const norm = s => s.toLowerCase().replace(/[^a-z0-9\s']/g, '').split(/\s+/).filter(Boolean);
    const t = norm(target), s = norm(said);
    if (t.length === 0) return 0;
    let hit = 0;
    const used = new Array(s.length).fill(false);
    t.forEach(w => {
      const i = s.findIndex((x, k) => !used[k] && (x === w || levenshtein(x, w) <= 1));
      if (i !== -1) { hit++; used[i] = true; }
    });
    return Math.round(hit / t.length * 100);
  }

  function levenshtein(a, b) {
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return m[a.length][b.length];
  }

  // ---------- Thư viện chủ đề ----------
  let openTopicGroup = null;   // null = mở nhóm của chặng đang học

  function renderTopics() {
    const curSt = currentStage();
    const cardsOf = list => `<div class="topic-grid">${list.map(t => `
      <button class="topic-card" onclick="App.openTopic('${t.id}')">
        <div class="t-ico">${t.icon}</div>
        <div class="t-name">${t.name}</div>
        <div class="t-meta">${t.vocab.length} từ · ${(t.chunks || []).length} cụm</div>
      </button>`).join('')}</div>`;

    // Nhóm theo chặng, chỉ mở 1 nhóm để trang không dài quá
    const groups = STAGES.map((st, si) => {
      const list = st.topics.map(topicById).filter(Boolean);
      const open = (openTopicGroup === null ? si === curSt : openTopicGroup === si);
      return `<div class="stage-block">
        <button class="stage-head ${open ? 'open' : ''}" style="--sc:${st.color}" onclick="App.toggleTopicGroup(${si})">
          <div class="stage-head-top">
            <div class="stage-title">${st.icon} ${st.name}</div>
            <span class="stage-caret">${open ? '▾' : '▸'}</span>
          </div>
          <div class="stage-meta"><span class="td-sub">${list.length} chủ đề</span></div>
        </button>
        ${open ? cardsOf(list) : ''}
      </div>`;
    }).join('');

    main().innerHTML = `
      <div class="view-title" style="margin-bottom:4px">📚 Thư viện chủ đề</div>
      <div class="view-sub" style="margin-bottom:18px">${TOPICS.length} chủ đề · chạm tên nhóm để mở/gấp</div>
      ${groups}`;
  }

  function toggleTopicGroup(si) {
    openTopicGroup = (openTopicGroup === null ? currentStage() : openTopicGroup) === si ? -1 : si;
    renderTopics();
  }

  function openTopic(id) {
    // mở dạng xem tự do: tái dùng renderLesson với dayIdx giả -1
    const t = topicById(id);
    freeTopic = id;
    renderFreeTopic(id, 0);
  }

  let freeTopic = null;

  function renderFreeTopic(id, tab) {
    const t = topicById(id);
    const tabNames = ['📖 Từ vựng', '🗣️ Cụm giao tiếp', '💬 Mẫu câu', '🎭 Hội thoại'];
    const tabsHtml = tabNames.map((n, k) =>
      `<button class="tab ${k === tab ? 'active' : ''}" onclick="App.freeTab('${id}',${k})">${n}</button>`).join('');
    let body = '';
    if (tab === 0) {
      body = `<div class="vocab-list">${t.vocab.map(v => `
        <div class="vocab-card">
          <div class="v-word">${esc(v.w)} <button class="speak-btn" onclick="App.speak('${js(v.w)}')">🔊</button></div>
          <div class="v-ipa">${esc(v.ipa)}</div>
          <div class="v-mean">${esc(v.m)}</div>
          <div class="v-ex">"${esc(v.ex)}"</div>
        </div>`).join('')}</div>`;
    } else if (tab === 1) {
      body = (t.chunks || []).map(k => `
        <div class="phrase-item chunk-item">
          <div style="flex:1">
            <div class="p-en">${esc(k.c)}</div>
            <div class="p-vi">${esc(k.m)}</div>
            <div class="chunk-use">📌 Khi dùng: ${esc(k.use)}</div>
            <div class="chunk-ex">“${esc(k.ex)}”</div>
          </div>
          <button class="speak-btn" onclick="App.speak('${js(k.c)}')">🔊</button>
        </div>`).join('') || '<div class="empty-note">Chủ đề này chưa có cụm giao tiếp.</div>';
    } else if (tab === 2) {
      body = t.phrases.map(p => `
        <div class="phrase-item">
          <div><div class="p-en">${esc(p.en)}</div><div class="p-vi">${esc(p.vi)}</div></div>
          <button class="speak-btn" onclick="App.speak('${js(p.en)}')">🔊</button>
        </div>`).join('');
    } else {
      body = `<div class="dialog-box">
        <div style="margin-bottom:14px"><button class="btn btn-outline btn-sm" onclick="App.playDialogue('${t.id}')">▶️ Nghe cả đoạn</button></div>
        ${t.dialogue.map(l => `
          <div class="dlg-line ${l.who === 'B' ? 'b' : ''}">
            <div class="who">${l.who}</div>
            <div class="bubble"><div class="en">${esc(l.en)}</div><div class="vi">${esc(l.vi)}</div></div>
          </div>`).join('')}
      </div>`;
    }
    main().innerHTML = `
      <div class="lesson-head">
        <button class="back" onclick="App.go('topics')">← Thư viện</button>
        <div class="view-title" style="margin:0;font-size:22px">${t.icon} ${t.name}</div>
      </div>
      <div class="tabs">${tabsHtml}</div>
      ${body}`;
  }

  // ---------- Giao diện quản trị (admin) ----------
  let adminUsers = null, adminFresh = false;

  async function renderAdmin() {
    if (!isAdmin()) { go('dashboard'); return; }
    main().innerHTML = `<div class="view-title">🛠️ Quản trị hệ thống</div>
      <div class="view-sub">Đang tải danh sách học viên từ máy chủ…</div>`;
    adminFresh = false;
    try {
      const r = await api('/admin/users');
      if (r.status === 403) { toast('⚠️ Tài khoản này không có quyền quản trị'); go('dashboard'); return; }
      if (r.ok) { adminUsers = r.data.users; adminFresh = true; online = true; }
    } catch (e) { online = false; }
    drawAdmin();
  }

  function drawAdmin() {
    // Không gọi được máy chủ → dùng dữ liệu cũ đã tải, hoặc bản lưu trên máy này
    const offlineMode = !adminFresh;
    const list = adminUsers || Object.keys(USERS).map(u => {
      const st = loadState(u);
      return {
        username: u, role: USERS[u].role, created: USERS[u].created,
        level: st && st.level, done: st ? st.done.length : 0, planLen: st && st.plan ? st.plan.length : 0,
        srs: st ? Object.keys(st.srs).length : 0, weak: st ? Object.keys(st.weak || {}).length : 0,
        streak: st ? st.streak : 0, lastStudy: st && st.lastStudy,
        quizTotal: st ? st.quizStats.total : 0, quizCorrect: st ? st.quizStats.correct : 0,
      };
    });

    const rows = list.map(x => {
      const prog = x.planLen ? `${x.done}/${x.planLen}` : '—';
      const pct = x.planLen ? Math.round(x.done / x.planLen * 100) : 0;
      const acc = x.quizTotal ? Math.round(x.quizCorrect / x.quizTotal * 100) + '%' : '—';
      const lvName = ({ 1: 'Cơ bản', 2: 'Sơ trung', 3: 'Trung cấp' })[x.level] || '—';
      return `<tr>
        <td><b>${esc(x.username)}</b>${x.role === 'admin' ? ' <span class="role-badge">admin</span>' : ''}
          <div class="td-sub">tạo: ${esc(x.created || '—')}${x.name ? ' · ' + esc(x.name) : ''}</div></td>
        <td>${lvName}</td>
        <td>${prog}<div class="mini-bar"><div style="width:${pct}%"></div></div></td>
        <td>${x.srs || 0}</td>
        <td>${x.planLen ? '🔥 ' + (x.streak || 0) : '—'}</td>
        <td>${acc}</td>
        <td>${x.lastStudy ? esc(x.lastStudy) : 'chưa học'}</td>
        <td class="td-actions">
          <button class="btn btn-sm btn-outline" onclick="App.adminSetPass('${esc(x.username)}')" title="Đặt lại mật khẩu">🔑</button>
          <button class="btn btn-sm btn-outline" onclick="App.adminResetUser('${esc(x.username)}')" title="Xóa tiến độ học">↺</button>
          ${x.username !== CURRENT ? `<button class="btn btn-sm btn-outline btn-danger" onclick="App.adminDeleteUser('${esc(x.username)}')" title="Xóa tài khoản">🗑️</button>` : ''}
        </td>
      </tr>`;
    }).join('');

    const students = list.filter(x => x.role !== 'admin');
    const totalDays = list.reduce((n, x) => n + (x.done || 0), 0);
    const totalWords = list.reduce((n, x) => n + (x.srs || 0), 0);
    const activeToday = list.filter(x => x.lastStudy === todayStr()).length;
    const nVocab = TOPICS.reduce((n, t) => n + t.vocab.length, 0);
    const nPhrases = TOPICS.reduce((n, t) => n + t.phrases.length, 0);
    const nChunks = TOPICS.reduce((n, t) => n + (t.chunks || []).length, 0);

    main().innerHTML = `
      <div class="view-title">🛠️ Quản trị hệ thống</div>
      <div class="view-sub">${offlineMode
        ? `⚠️ <b style="color:var(--yellow)">Không kết nối được máy chủ</b> — đang hiển thị ${adminUsers ? 'dữ liệu đã tải trước đó' : 'bản lưu trên máy này'}. Kết nối mạng rồi mở lại để cập nhật.`
        : 'Toàn bộ học viên trên mọi thiết bị, dữ liệu lấy trực tiếp từ máy chủ.'}</div>
      <div class="stat-grid">
        <div class="stat-card"><div class="ico">👥</div><div class="num">${students.length}</div><div class="lbl">Học viên</div></div>
        <div class="stat-card"><div class="ico">✅</div><div class="num">${totalDays}</div><div class="lbl">Tổng ngày đã hoàn thành</div></div>
        <div class="stat-card"><div class="ico">🧠</div><div class="num">${totalWords}</div><div class="lbl">Tổng từ đang ghi nhớ</div></div>
        <div class="stat-card"><div class="ico">📅</div><div class="num">${activeToday}</div><div class="lbl">Đã học hôm nay</div></div>
      </div>
      <div class="panel">
        <h3>👥 Danh sách tài khoản</h3>
        <div class="table-wrap">
          <table class="admin-table">
            <thead><tr><th>Tài khoản</th><th>Trình độ</th><th>Tiến độ</th><th>Từ vựng</th><th>Streak</th><th>Quiz</th><th>Học gần nhất</th><th>Thao tác</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="td-sub" style="margin-top:10px">🔑 đặt lại mật khẩu · ↺ xóa tiến độ học · 🗑️ xóa tài khoản</div>
      </div>
      <div class="panel">
        <h3>📚 Nội dung học (nạp tự động từ data.js)</h3>
        <div class="content-stats">
          <span>📂 ${TOPICS.length} chủ đề</span>
          <span>📖 ${nVocab} từ vựng</span>
          <span>🗣️ ${nChunks} cụm giao tiếp</span>
          <span>💬 ${nPhrases} mẫu câu</span>
          <span>🎭 ${TOPICS.length} hội thoại</span>
          <span>🎯 ${PLACEMENT_TEST.length} câu kiểm tra đầu vào</span>
        </div>
        <div class="td-sub" style="margin-top:8px">Muốn thêm chủ đề/từ vựng: mở tệp <b>data.js / data2.js / data3.js</b>, thêm theo đúng mẫu có sẵn rồi đăng lại web.</div>
      </div>
      <div class="panel">
        <h3>🔐 Bảo mật</h3>
        <div class="set-row">
          <div>
            <div class="set-name">Đổi mật khẩu admin</div>
            <div class="set-desc">Tài khoản mặc định là admin / admin123 — nên đổi ngay lần đầu dùng.</div>
          </div>
          <div class="set-ctrl"><button class="btn btn-sm btn-outline" onclick="App.adminSetPass('${esc(CURRENT)}')">Đổi mật khẩu</button></div>
        </div>
        <div class="td-sub">Tài khoản và tiến độ được lưu trên <b>máy chủ của bạn</b> (mật khẩu băm PBKDF2, truyền qua HTTPS). Học viên đăng nhập ở thiết bị nào cũng ra đúng dữ liệu của mình.</div>
      </div>`;
  }

  async function adminSetPass(u) {
    if (!isAdmin()) return;
    const p = prompt(`Nhập mật khẩu mới cho tài khoản "${u}" (tối thiểu 4 ký tự):`);
    if (p === null) return;
    if (p.length < 4) { toast('⚠️ Mật khẩu cần ít nhất 4 ký tự'); return; }
    try {
      const r = await api('/admin/user-password', { method: 'POST', body: { username: u, password: p } });
      if (!r.ok) return toast('⚠️ ' + (r.data.err || 'Không đổi được mật khẩu'));
      if (USERS[u]) { USERS[u].pass = hashPass(p); saveUsers(); }
      toast(`🔑 Đã đổi mật khẩu cho "${u}"`);
    } catch (e) { toast('⚠️ Cần có mạng để đổi mật khẩu trên máy chủ'); }
  }

  async function adminResetUser(u) {
    if (!isAdmin()) return;
    if (!confirm(`Xóa toàn bộ tiến độ học của "${u}"? (tài khoản vẫn giữ nguyên)`)) return;
    try {
      const r = await api('/admin/user-reset', { method: 'POST', body: { username: u } });
      if (!r.ok) return toast('⚠️ ' + (r.data.err || 'Không xóa được tiến độ'));
      localStorage.removeItem(stateKey(u));
      if (u === CURRENT) { S = null; }
      toast(`↺ Đã xóa tiến độ của "${u}"`);
      renderAdmin();
    } catch (e) { toast('⚠️ Cần có mạng để thực hiện trên máy chủ'); }
  }

  async function adminDeleteUser(u) {
    if (!isAdmin() || u === CURRENT) return;
    if (!confirm(`Xóa hẳn tài khoản "${u}" cùng toàn bộ tiến độ học?`)) return;
    try {
      const r = await api('/admin/user-delete', { method: 'POST', body: { username: u } });
      if (!r.ok) return toast('⚠️ ' + (r.data.err || 'Không xóa được tài khoản'));
      delete USERS[u];
      saveUsers();
      localStorage.removeItem(stateKey(u));
      toast(`🗑️ Đã xóa tài khoản "${u}"`);
      renderAdmin();
    } catch (e) { toast('⚠️ Cần có mạng để thực hiện trên máy chủ'); }
  }

  // ---------- Tiện ích ----------
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function js(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/\n/g, ' '); }

  let toastTimer = null;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
  }

  async function resetAll() {
    if (!confirm(`Xóa toàn bộ tiến độ học của tài khoản "${CURRENT}" và làm lại kiểm tra đầu vào?\n\nTiến độ trên MỌI thiết bị của tài khoản này sẽ bị xóa.`)) return;
    clearTimeout(pushTimer);                       // hủy lần đẩy đang chờ, tránh ghi lại bản vừa xóa
    if (TOKEN) { try { await api('/state', { method: 'DELETE' }); } catch (e) {} }
    if (CURRENT) localStorage.removeItem(stateKey(CURRENT));
    location.reload();
  }

  // ---------- PWA: cài đặt + thông báo nhắc học ----------
  let installEvt = null;
  let swReg = null;

  function setupPwa() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js')
        .then(r => { swReg = r; r.update && r.update(); })
        .catch(() => {}); // file:// hoặc trình duyệt cũ: bỏ qua, app vẫn chạy bình thường
      // Có bản cập nhật mới → tự tải lại 1 lần để dùng ngay (không phải chờ lần mở sau)
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (sessionStorage.getItem('ed_reloaded')) return;   // chặn lặp vô hạn
        sessionStorage.setItem('ed_reloaded', '1');
        location.reload();
      });
    }
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      installEvt = e;
      const b = document.getElementById('btn-install');
      if (b) b.classList.remove('hidden');
      const row = document.getElementById('install-row');
      if (row) row.style.display = 'flex';
    });
    window.addEventListener('appinstalled', () => {
      installEvt = null;
      toast('🎉 Đã cài EnglishDaily vào thiết bị!');
      const b = document.getElementById('btn-install');
      if (b) b.classList.add('hidden');
      const row = document.getElementById('install-row');
      if (row) row.style.display = 'none';
    });
  }

  function installApp() {
    if (!installEvt) {
      toast('Mở menu trình duyệt → "Thêm vào màn hình chính" để cài đặt');
      return;
    }
    installEvt.prompt();
    installEvt.userChoice.finally(() => { installEvt = null; });
  }

  function setReminderTime(v) {
    S.reminder.time = v || '20:00';
    save();
    if (S.reminder.enabled) toast('⏰ Sẽ nhắc bạn lúc ' + S.reminder.time + ' hằng ngày');
  }

  async function toggleReminder() {
    if (S.reminder.enabled) {
      S.reminder.enabled = false;
      save();
      renderDashboard();
      return;
    }
    if (!('Notification' in window)) {
      toast('⚠️ Trình duyệt này không hỗ trợ thông báo');
      return;
    }
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      toast('⚠️ Bạn cần cho phép thông báo trong cài đặt trình duyệt');
      return;
    }
    S.reminder.enabled = true;
    save();
    showNotify('🔔 Đã bật nhắc học!', `EnglishDaily sẽ nhắc bạn học lúc ${S.reminder.time} mỗi ngày.`);
    renderDashboard();
  }

  function showNotify(title, body) {
    const opts = { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'englishdaily-reminder' };
    if (swReg && swReg.showNotification) swReg.showNotification(title, opts);
    else if ('Notification' in window && Notification.permission === 'granted') new Notification(title, opts);
  }

  // Kiểm tra mỗi phút: đến giờ nhắc + hôm nay chưa học + hôm nay chưa nhắc → gửi thông báo
  function checkReminder() {
    if (!S || !S.reminder || !S.reminder.enabled) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const today = todayStr();
    if (S.lastStudy === today || S.lastNotified === today) return;
    const now = new Date();
    const cur = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    if (cur >= S.reminder.time) {
      const cu = currentDayIdx();
      const msg = cu === -1
        ? 'Hôm nay bạn chưa ôn tập. Vào ôn flashcard vài phút nhé!'
        : `Ngày ${cu + 1} đang chờ bạn. Học 15 phút thôi, giữ chuỗi ${S.streak} ngày! 🔥`;
      showNotify('📚 Đến giờ học tiếng Anh rồi!', msg);
      S.lastNotified = today;
      save();
    }
  }

  // ---------- Thông báo đẩy chủ động (máy chủ gửi bài học, app đóng vẫn nhận) ----------
  function vapidKey() {
    const pad = '='.repeat((4 - VAPID_PUBLIC.length % 4) % 4);
    const b64 = (VAPID_PUBLIC + pad).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    return Uint8Array.from([...raw].map(ch => ch.charCodeAt(0)));
  }

  // Hàng đợi nội dung cá nhân hóa: mỗi thông báo là một bài học tí hon
  function buildPushQueue() {
    const q = [];
    // 1) từ vựng đến hạn ôn (ưu tiên từ sắp quên nhất)
    const cards = Object.entries(S.srs)
      .sort((a, b) => a[1].due < b[1].due ? -1 : 1)
      .slice(0, 20);
    for (const [key] of cards) {
      const [tid, ...rest] = key.split('|');
      const v = findItem(tid, rest.join('|'));
      if (v) q.push({
        title: `📚 ${v.w}${v.ipa ? ' ' + v.ipa : ''}`,
        body: 'Bạn còn nhớ nghĩa của từ này không? Bấm để trả lời ngay 👇',
        item: key, word: v.w, meaning: v.m, ex: v.ex,   // cho phép lật thẻ & chấm ngay trên thông báo
      });
    }
    // 2) mẫu câu của bài đang học — kèm gợi ý dùng ngoài đời
    const cur = currentDayIdx();
    const d = cur !== -1 ? S.plan[cur] : null;
    const tids = d && d.t === 'lesson' ? d.topics : learnedTopicIds().slice(-2);
    for (const tid of tids) {
      const t = topicById(tid);
      if (t) t.phrases.forEach(p => q.push({ title: `💬 ${p.en}`, body: `${p.vi} · Thử dùng câu này hôm nay nhé!` }));
    }
    // xen kẽ từ vựng / mẫu câu cho đỡ nhàm
    const words = q.filter(x => x.title.startsWith('📚')), phrases = q.filter(x => x.title.startsWith('💬'));
    const mix = [];
    for (let i = 0; i < Math.max(words.length, phrases.length) && mix.length < 30; i++) {
      if (words[i]) mix.push(words[i]);
      if (phrases[i] && mix.length < 30) mix.push(phrases[i]);
    }
    return mix;
  }

  async function togglePush() {
    if (S.push.enabled) {
      S.push.enabled = false;
      save();
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          fetch(PUSH_API + '/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
          await sub.unsubscribe();
        }
      } catch (e) {}
      renderDashboard();
      return;
    }
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      toast('⚠️ Trình duyệt chưa hỗ trợ thông báo đẩy. iPhone: cần cài app vào màn hình chính trước.');
      return;
    }
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('⚠️ Bạn cần cho phép thông báo trong cài đặt trình duyệt'); return; }
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKey() });
      const r = await fetch(PUSH_API + '/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sub: sub.toJSON(), user: CURRENT, times: S.push.times, tzoff: new Date().getTimezoneOffset(), queue: buildPushQueue() }),
      });
      if (!r.ok) throw new Error('subscribe failed');
      S.push.enabled = true;
      save();
      toast('📣 Đã bật! Bài học sẽ tự đến với bạn ' + S.push.times.length + ' lần mỗi ngày');
      renderDashboard();
    } catch (e) {
      toast('⚠️ Không đăng ký được — kiểm tra kết nối mạng rồi thử lại');
    }
  }

  function setPushTime(i, v) {
    if (v) S.push.times[i] = v;
    save();
    if (S.push.enabled) syncPush();
  }

  // Đồng bộ lại hàng đợi mỗi lần mở app — nội dung thông báo luôn bám tiến độ mới nhất
  async function syncPush() {
    if (!S || !S.push || !S.push.enabled) return;
    if (!('serviceWorker' in navigator) || !('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return;
      fetch(PUSH_API + '/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sub: sub.toJSON(), user: CURRENT, times: S.push.times, tzoff: new Date().getTimezoneOffset(), queue: buildPushQueue() }),
      }).catch(() => {});
    } catch (e) {}
  }

  // ---------- Thử thách đời thực (gắn bài học vào cuộc sống hằng ngày) ----------
  const MISSIONS = {
    greetings: 'Hôm nay gặp ai, hãy thầm chào trong đầu bằng tiếng Anh: “Hello! How are you?”',
    family: 'Nhìn một tấm ảnh gia đình và giới thiệu từng người bằng tiếng Anh: “This is my mother…”',
    'numbers-time': 'Mỗi lần xem giờ hôm nay, đọc thầm giờ đó bằng tiếng Anh.',
    'daily-routine': 'Vừa làm một việc nhà vừa mô tả nó bằng tiếng Anh: “I am cooking dinner.”',
    food: 'Đến bữa ăn, gọi tên các món trên bàn bằng tiếng Anh.',
    shopping: 'Khi mua đồ (hoặc lướt shop online), thầm hỏi giá: “How much is it?”',
    directions: 'Trên đường đi hôm nay, thầm dẫn đường cho chính mình: “Turn left… go straight…”',
    weather: 'Nhìn bầu trời và nói thời tiết hôm nay bằng tiếng Anh, thêm cả nhiệt độ.',
    hobbies: 'Dành 1 phút kể với chính mình về sở thích của bạn bằng tiếng Anh.',
    work: 'Mô tả 3 việc bạn đã làm hôm nay ở trường/cơ quan bằng tiếng Anh.',
    health: 'Tự hỏi “How do I feel today?” và trả lời bằng 2 câu tiếng Anh.',
    phone: 'Trước cuộc gọi tiếp theo, tập nói 3 lần: “Hello, may I speak to…?”',
    travel: 'Tưởng tượng đặt phòng cho chuyến đi mơ ước — nói 3 câu đặt phòng bằng tiếng Anh.',
    feelings: 'Cuối ngày, gọi tên cảm xúc hôm nay bằng 3 tính từ tiếng Anh.',
    money: 'Khi thanh toán/chuyển khoản hôm nay, đọc thầm số tiền bằng tiếng Anh.',
    study: 'Dạy lại 3 từ mới hôm nay cho một người thân (hoặc thú bông 🧸) bằng tiếng Anh.',
    sports: 'Lúc vận động hôm nay, đếm nhịp bằng tiếng Anh: one, two, three…',
    party: 'Tập nói lời chúc mừng sinh nhật bằng tiếng Anh trước gương 2 lần.',
    technology: 'Đổi ngôn ngữ điện thoại sang tiếng Anh trong 1 giờ — bạn sẽ bất ngờ đấy!',
    emergency: 'Đọc to 2 lần: “Help! Please call an ambulance!” — câu có thể cứu bạn khi du lịch.',
    smalltalk: 'Khi gặp người quen, thầm mở chuyện trong đầu: “Long time no see! How have you been?”',
  };
  const MISSIONS_GENERIC = [
    'Nghe 1 bài hát tiếng Anh và ghi lại 3 từ bạn nghe được.',
    'Đọc to 5 từ trong bộ flashcard của bạn trước gương.',
    'Xem 1 video tiếng Anh ngắn (có phụ đề) về chủ đề bạn thích.',
    'Đặt tên tiếng Anh cho 5 đồ vật quanh bạn ngay bây giờ.',
    'Viết 1 câu tiếng Anh mô tả ngày hôm nay của bạn.',
  ];

  function todayMission() {
    const cur = currentDayIdx();
    const d = cur !== -1 ? S.plan[cur] : null;
    if (d && d.t === 'lesson' && MISSIONS[d.topics[0]]) return MISSIONS[d.topics[0]];
    const seed = todayStr().split('-').reduce((a, x) => a + parseInt(x, 10), 0);
    return MISSIONS_GENERIC[seed % MISSIONS_GENERIC.length];
  }

  function doneMission() {
    S.missions[todayStr()] = true;
    touchStreak();
    save();
    toast('🎯 Tuyệt! Tiếng Anh vừa bước vào đời thực của bạn');
    renderDashboard();
  }

  function setMinutes(v) {
    S.minutesPerDay = parseInt(v, 10) || 15;
    save();
    renderDashboard();
  }

  // Khóa zoom: iOS Safari bỏ qua user-scalable=no nên chặn thêm cử chỉ véo 2 ngón.
  // Double-tap zoom đã bị vô hiệu bằng CSS touch-action:manipulation (không phá thao tác bấm nhanh).
  function lockZoom() {
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(ev =>
      document.addEventListener(ev, e => e.preventDefault(), { passive: false }));
    document.addEventListener('touchmove', e => {
      if (e.touches.length > 1) e.preventDefault(); // véo 2 ngón
    }, { passive: false });
  }

  // ---------- Khởi động ----------
  function init() {
    // nạp sẵn giọng đọc
    if ('speechSynthesis' in window) speechSynthesis.getVoices();
    setupPwa();
    lockZoom();
    ['auth-user', 'auth-pass', 'auth-pass2'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') authSubmit(); });
    });
    // Có mạng trở lại → đẩy nốt phần chưa đồng bộ
    window.addEventListener('online', () => { online = true; pendingSync ? pushState() : pullState(); });
    window.addEventListener('offline', () => { online = false; updateSyncBadge(); });
    // Rời trang mà còn dữ liệu chưa đẩy → cố gửi nốt
    document.addEventListener('visibilitychange', () => { if (document.hidden && pendingSync) pushState(); });

    if (CURRENT && (TOKEN || USERS[CURRENT])) {
      ROLE = USERS[CURRENT] ? USERS[CURRENT].role : null;
      enterApp();     // vào ngay từ bản lưu trên máy, rồi tự đồng bộ ở nền
    } else {
      CURRENT = null;
      localStorage.removeItem(SESSION_KEY);
      showScreen('screen-login');
      document.getElementById('auth-user').focus();
    }
    checkReminder();
    setInterval(checkReminder, 60 * 1000);
  }
  document.addEventListener('DOMContentLoaded', init);

  return {
    startPlacement, skipPlacement, finishOnboard, go, speak, lessonTab, playDialogue,
    answerQuiz, flipCard, gradeCard, toggleRecord, nextPhrase, skipSpeakScore,
    openTopic, freeTab: renderFreeTopic, resetAll,
    installApp, toggleReminder, setReminderTime,
    authTab, authSubmit, logout, adminSetPass, adminResetUser, adminDeleteUser, togglePass,
    togglePush, setPushTime, doneMission, startTestOut, setMinutes, toggleStage, toggleTopicGroup, setStartView,
    learnNext, learnAnswer, learnCheckType, learnCheckScramble, learnPick, learnUnpick,
    learnSpeakStart, learnSpeakSkip,
  };
})();
