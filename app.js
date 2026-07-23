// ============================================================
// EnglishDaily — logic chính
// Tự động: xếp trình độ → tạo lộ trình → nạp bài học → theo dõi tiến độ
// ============================================================

const LEGACY_KEY = 'englishdaily_v1';          // dữ liệu bản cũ (một người dùng)
const USERS_KEY = 'englishdaily_users';        // danh sách tài khoản trên thiết bị này
const SESSION_KEY = 'englishdaily_session';    // ai đang đăng nhập
const STATE_PREFIX = 'englishdaily_state:';    // tiến độ học của từng tài khoản
const SRS_INTERVALS = [0, 1, 3, 7, 16]; // ngày chờ giữa các lần ôn theo hộp Leitner
const PUSH_API = '/api/push';           // backend đẩy thông báo trên VPS (nginx proxy → 127.0.0.1:5003)
const VAPID_PUBLIC = 'BBdmFi_CDVK3hK3pI_hp9bbJNq6f7xitjMQ86CHpf8N9zP4f1ckE6we8rJIGX1ghRGNdxGecWTANpqEJqajNw1g';

const App = (() => {

  // ---------- Tài khoản ----------
  let USERS = loadUsers();
  let CURRENT = localStorage.getItem(SESSION_KEY);
  let S = null;

  function loadUsers() {
    try { return JSON.parse(localStorage.getItem(USERS_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveUsers() { localStorage.setItem(USERS_KEY, JSON.stringify(USERS)); }

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

  function loadState(username) {
    try {
      const raw = localStorage.getItem(stateKey(username));
      if (raw) {
        const s = JSON.parse(raw);
        if (!s.reminder) s.reminder = { enabled: false, time: '20:00' };
        if (!('lastNotified' in s)) s.lastNotified = null;
        if (!s.push) s.push = { enabled: false, times: ['07:00', '12:30', '20:00'] };
        if (!s.missions) s.missions = {};
        return s;
      }
    } catch (e) {}
    return null;
  }
  function save() { if (CURRENT) localStorage.setItem(stateKey(CURRENT), JSON.stringify(S)); }

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

  // ---------- Tạo lộ trình tự động theo trình độ ----------
  function buildPlan(level) {
    const regular = TOPICS.filter(t => !FUNC_IDS.includes(t.id));
    const funcs = FUNC_IDS.map(id => TOPICS.find(t => t.id === id)).filter(Boolean);
    const lv1 = regular.filter(t => t.level === 1).map(t => t.id);
    const lv2 = regular.filter(t => t.level === 2).map(t => t.id);
    const lv3 = regular.filter(t => t.level === 3).map(t => t.id);

    const pair = arr => {
      const out = [];
      for (let i = 0; i < arr.length; i += 2) out.push(arr.slice(i, i + 2));
      return out;
    };

    let lessonGroups; // mỗi phần tử = mảng topicId học trong 1 ngày
    if (level === 1) lessonGroups = [...lv1, ...lv2, ...lv3].map(id => [id]);
    else if (level === 2) lessonGroups = [...pair(lv1), ...[...lv2, ...lv3].map(id => [id])];
    else lessonGroups = [...pair(lv1), ...pair(lv2), ...lv3.map(id => [id])];

    // Xen kẽ bài "Thực chiến": cứ 3 bài chủ đề → 1 bài kỹ năng giao tiếp xuyên suốt
    const merged = [];
    let fi = 0;
    lessonGroups.forEach((g, i) => {
      merged.push(g);
      if ((i + 1) % 3 === 0 && fi < funcs.length) merged.push([funcs[fi++].id]);
    });
    while (fi < funcs.length) merged.push([funcs[fi++].id]);
    lessonGroups = merged;

    const plan = [];
    let count = 0;
    for (const g of lessonGroups) {
      plan.push({ t: 'lesson', topics: g });
      count++;
      if (count % 4 === 0) plan.push({ t: 'review' });
    }
    if (count % 4 !== 0) plan.push({ t: 'review' });
    plan.push({ t: 'final', kind: 'speaking' });
    plan.push({ t: 'final', kind: 'quiz' });
    return plan;
  }
  // Các chủ đề "Thực chiến" (kỹ năng giao tiếp xuyên suốt) — xen kẽ vào lộ trình
  const FUNC_IDS = ['survival-basics', 'polite-requests', 'reactions', 'opinions', 'conversation-flow'];

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
      ? 'Đăng nhập để tiếp tục lộ trình học của bạn.'
      : 'Mỗi tài khoản có lộ trình và tiến độ học riêng.';
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

  function authSubmit() {
    const u = document.getElementById('auth-user').value.trim().toLowerCase();
    const p = document.getElementById('auth-pass').value;
    if (!u || !p) return authErr('Vui lòng nhập đủ tên đăng nhập và mật khẩu.');

    if (authMode === 'reg') {
      const p2 = document.getElementById('auth-pass2').value;
      if (!/^[a-z0-9_.-]{3,24}$/.test(u)) return authErr('Tên đăng nhập: 3–24 ký tự, chỉ gồm chữ thường, số, dấu . _ -');
      if (USERS[u]) return authErr('Tên đăng nhập này đã tồn tại.');
      if (p.length < 4) return authErr('Mật khẩu cần ít nhất 4 ký tự.');
      if (p !== p2) return authErr('Mật khẩu nhập lại không khớp.');
      USERS[u] = { pass: hashPass(p), role: 'student', created: todayStr() };
      saveUsers();
      // chuyển tiến độ của bản cũ (trước khi có tài khoản) sang người đăng ký đầu tiên
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy && !localStorage.getItem(stateKey(u))) {
        localStorage.setItem(stateKey(u), legacy);
        localStorage.removeItem(LEGACY_KEY);
      }
    } else {
      if (!USERS[u]) return authErr('Tài khoản không tồn tại. Bấm "Đăng ký" để tạo mới.');
      if (USERS[u].pass !== hashPass(p)) return authErr('Sai mật khẩu, thử lại nhé.');
    }

    CURRENT = u;
    localStorage.setItem(SESSION_KEY, u);
    document.getElementById('auth-pass').value = '';
    document.getElementById('auth-pass2').value = '';
    enterApp();
  }

  function logout() {
    localStorage.removeItem(SESSION_KEY);
    location.reload();
  }

  function isAdmin() { return CURRENT && USERS[CURRENT] && USERS[CURRENT].role === 'admin'; }

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
    document.getElementById('nav-admin').classList.toggle('hidden', !isAdmin());
    const chip = document.getElementById('user-chip');
    if (chip) chip.innerHTML = `👤 <b>${esc(CURRENT)}</b>${isAdmin() ? ' <span class="role-badge">admin</span>' : ''}`;
    go(isAdmin() ? 'admin' : 'dashboard');
    syncPush();                                  // làm mới nội dung thông báo theo tiến độ mới nhất
    if ('setAppBadge' in navigator) {            // huy hiệu số thẻ đến hạn trên icon app
      const n = dueCards().length;
      (n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
    }
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
    document.getElementById('nav-admin').classList.toggle('hidden', !isAdmin());
    const chip = document.getElementById('user-chip');
    if (chip) chip.innerHTML = `👤 <b>${esc(CURRENT)}</b>${isAdmin() ? ' <span class="role-badge">admin</span>' : ''}`;
    go('dashboard');
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

  function addTopicToSrs(topicId) {
    const t = topicById(topicId);
    if (!t) return;
    vocabOf(t).forEach(v => {
      const key = topicId + '|' + v.w;
      if (!S.srs[key]) S.srs[key] = { box: 0, due: todayStr() };
    });
    save();
  }

  function dueCards() {
    const today = todayStr();
    return Object.entries(S.srs)
      .filter(([, c]) => c.due <= today)
      .map(([key, c]) => {
        const [tid, ...rest] = key.split('|');
        const v = findItem(tid, rest.join('|'));
        return v ? { key, card: c, v, topic: topicById(tid) } : null;
      })
      .filter(Boolean);
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
    if (d.t === 'review') return { icon: '🔁', name: 'Ôn tập tổng hợp' };
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
      todayHtml = `<div class="today-card">
        <div>
          <h3>Bài học hôm nay — Ngày ${cur + 1}/${S.plan.length}</h3>
          <div class="t-title">${lbl.icon} ${lbl.name}</div>
          <div class="t-desc">Hoàn thành từ vựng, mẫu câu, hội thoại và quiz để mở khóa ngày tiếp theo.</div>
        </div>
        <button class="btn btn-primary" onclick="App.go('day',${cur})">Học ngay →</button>
      </div>`;
    }

    const missionDone = !!S.missions[todayStr()];
    main().innerHTML = `
      <div class="view-title">Xin chào, ${esc(S.name)}! 👋</div>
      <div class="view-sub">Trình độ: <b>${lvNames[S.level]}</b> · Mục tiêu: giao tiếp tiếng Anh hằng ngày</div>
      ${todayHtml}
      <div class="panel mission-card ${missionDone ? 'done' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap">
          <div style="flex:1;min-width:220px">
            <h3 style="margin-bottom:6px">🎯 Thử thách đời thực hôm nay</h3>
            <div style="font-size:14.5px;line-height:1.6">${esc(todayMission())}</div>
          </div>
          ${missionDone
            ? '<span class="score-badge score-good">✓ Đã thực hiện</span>'
            : '<button class="btn btn-green" onclick="App.doneMission()">Tôi đã làm ✓</button>'}
        </div>
      </div>
      <div class="stat-grid">
        <div class="stat-card"><div class="ico">🔥</div><div class="num">${S.streak}</div><div class="lbl">Chuỗi ngày học liên tiếp</div></div>
        <div class="stat-card"><div class="ico">📖</div><div class="num">${S.done.length}/${S.plan.length}</div><div class="lbl">Ngày đã hoàn thành</div></div>
        <div class="stat-card"><div class="ico">🧠</div><div class="num">${words}</div><div class="lbl">Từ vựng đang ghi nhớ</div></div>
        <div class="stat-card"><div class="ico">🎯</div><div class="num">${acc}%</div><div class="lbl">Độ chính xác quiz</div></div>
      </div>
      <div class="panel">
        <h3>Tiến độ lộ trình</h3>
        <div class="progress-line"><div class="fill" style="width:${pct}%"></div></div>
        <div style="color:var(--muted);font-size:13.5px">${pct}% hoàn thành</div>
      </div>
      ${due > 0 ? `<div class="panel" style="display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap">
        <div><h3 style="margin-bottom:4px">🃏 Có ${due} thẻ từ vựng đến hạn ôn</h3>
        <div style="color:var(--muted);font-size:13.5px">Ôn ngay để không quên những gì đã học.</div></div>
        <button class="btn btn-outline" onclick="App.go('flashcards')">Ôn ngay</button>
      </div>` : ''}
      <div class="panel">
        <h3>⚙️ Cài đặt</h3>
        <div class="set-row">
          <div>
            <div class="set-name">📣 Bài học tự đến qua thông báo</div>
            <div class="set-desc">Máy chủ gửi từ vựng &amp; mẫu câu của bạn theo 3 khung giờ — <b>app đóng vẫn nhận được</b>.</div>
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
            <div class="set-desc">Nhắc nhẹ nếu đến giờ mà hôm nay bạn chưa học (chạy trong app).</div>
          </div>
          <div class="set-ctrl">
            <input type="time" id="remind-time" value="${S.reminder.time}" onchange="App.setReminderTime(this.value)">
            <button class="btn btn-sm ${S.reminder.enabled ? 'btn-green' : 'btn-outline'}" id="btn-remind" onclick="App.toggleReminder()">${S.reminder.enabled ? '✓ Đang bật' : 'Bật'}</button>
          </div>
        </div>
        <div class="set-row" id="install-row" style="display:${installEvt ? 'flex' : 'none'}">
          <div>
            <div class="set-name">📲 Cài đặt lên thiết bị</div>
            <div class="set-desc">Thêm EnglishDaily vào màn hình chính, mở như app thật.</div>
          </div>
          <div class="set-ctrl"><button class="btn btn-sm btn-outline" onclick="App.installApp()">Cài đặt</button></div>
        </div>
        <div class="set-row only-mobile">
          <div>
            <div class="set-name">🔄 Làm lại từ đầu</div>
            <div class="set-desc">Xóa tiến độ và làm lại kiểm tra đầu vào.</div>
          </div>
          <div class="set-ctrl"><button class="btn btn-sm btn-outline" onclick="App.resetAll()">Đặt lại</button></div>
        </div>
        <div class="set-row only-mobile">
          <div>
            <div class="set-name">👤 Tài khoản: ${esc(CURRENT || '')}</div>
            <div class="set-desc">Đăng xuất để đổi người học trên thiết bị này.</div>
          </div>
          <div class="set-ctrl"><button class="btn btn-sm btn-outline" onclick="App.logout()">Đăng xuất</button></div>
        </div>
      </div>
    `;
  }

  // ---------- Lộ trình ----------
  function renderRoadmap() {
    const cur = currentDayIdx();
    const cards = S.plan.map((d, i) => {
      const lbl = dayLabel(d, i);
      const done = S.done.includes(i);
      const locked = !done && i !== cur;
      const cls = ['day-card', d.t === 'review' || d.t === 'final' ? 'review' : '',
        done ? 'done' : '', i === cur ? 'current' : '', locked ? 'locked' : ''].join(' ');
      return `<button class="${cls}" ${locked ? 'disabled' : `onclick="App.go('day',${i})"`}>
        <span class="d-num">Ngày ${i + 1}</span>
        <span class="d-ico">${lbl.icon}</span>
        <span class="d-name">${lbl.name}</span>
      </button>`;
    }).join('');
    main().innerHTML = `
      <div class="view-title">🗺️ Lộ trình ${S.plan.length} ngày</div>
      <div class="view-sub">Được tạo tự động theo trình độ của bạn. Hoàn thành mỗi ngày để mở khóa ngày tiếp theo.</div>
      <div class="roadmap-grid">${cards}</div>`;
  }

  // ---------- Ngày học ----------
  let quizState = null;

  function renderDay(i) {
    const d = S.plan[i];
    if (d.t === 'lesson') renderLesson(i, d.topics, 0);
    else if (d.t === 'review') startQuiz(i, buildReviewQuiz(10), 'Ôn tập tổng hợp', true);
    else if (d.kind === 'quiz') startQuiz(i, buildReviewQuiz(15), 'Bài kiểm tra cuối khóa', true);
    else renderSpeakingChallenge(i);
  }

  function renderLesson(dayIdx, topicIds, tab) {
    const ts = topicIds.map(topicById);
    const tabNames = ['📖 Từ vựng', '🗣️ Cụm giao tiếp', '💬 Mẫu câu', '🎭 Hội thoại', '✅ Quiz'];
    const tabsHtml = tabNames.map((n, k) =>
      `<button class="tab ${k === tab ? 'active' : ''}" onclick="App.lessonTab(${dayIdx},${k})">${n}</button>`).join('');

    let body = '';
    if (tab === 0) {
      body = ts.map(t => `
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
    } else {
      startQuiz(dayIdx, buildTopicQuiz(topicIds), null, false, topicIds);
      return;
    }

    main().innerHTML = `
      <div class="lesson-head">
        <button class="back" onclick="App.go('roadmap')">← Lộ trình</button>
        <div class="view-title" style="margin:0;font-size:22px">Ngày ${dayIdx + 1}: ${ts.map(t => t.name).join(' + ')}</div>
      </div>
      <div class="tabs">${tabsHtml}</div>
      ${body}
      <div style="margin-top:24px">
        ${tab < 4 ? `<button class="btn btn-primary" onclick="App.lessonTab(${dayIdx},${tab + 1})">Tiếp theo: ${tabNames[tab + 1]} →</button>` : ''}
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

  // ---------- Quiz ----------
  function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  function makeQuestion(v, pool, type) {
    const others = shuffle(pool.filter(x => x.w !== v.w)).slice(0, 3);
    if (type === 0) { // nghĩa -> từ
      const opts = shuffle([v.w, ...others.map(o => o.w)]);
      return { q: `Từ tiếng Anh nào có nghĩa là “${v.m}”?`, opts, a: opts.indexOf(v.w) };
    }
    if (type === 1) { // từ -> nghĩa
      const opts = shuffle([v.m, ...others.map(o => o.m)]);
      return { q: `“${v.w}” có nghĩa là gì?`, opts, a: opts.indexOf(v.m), listen: v.w };
    }
    if (type === 2) { // nghe -> chọn từ
      const opts = shuffle([v.w, ...others.map(o => o.w)]);
      return { q: '🔊 Nghe và chọn từ bạn nghe được:', opts, a: opts.indexOf(v.w), listen: v.w, auto: true };
    }
    // điền vào chỗ trống trong câu ví dụ
    const blanked = v.ex.replace(new RegExp(v.w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '_____');
    const opts = shuffle([v.w, ...others.map(o => o.w)]);
    return { q: `Điền vào chỗ trống: “${blanked}”`, opts, a: opts.indexOf(v.w) };
  }

  function buildTopicQuiz(topicIds) {
    const pool = topicIds.flatMap(id => vocabOf(topicById(id)));
    const picked = shuffle(pool).slice(0, 10);
    return picked.map((v, i) => makeQuestion(v, pool, i % 4));
  }

  function buildReviewQuiz(n) {
    let ids = learnedTopicIds();
    if (ids.length === 0) ids = [TOPICS[0].id];
    const pool = [...new Set(ids)].flatMap(id => vocabOf(topicById(id)));
    const picked = shuffle(pool).slice(0, n);
    return picked.map((v, i) => makeQuestion(v, pool, i % 4));
  }

  function startQuiz(dayIdx, questions, title, isReviewDay, topicIds) {
    quizState = { dayIdx, questions, idx: 0, correct: 0, isReviewDay, topicIds: topicIds || [] , title };
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
    S.quizStats.total++; if (ok) S.quizStats.correct++;
    save();
    setTimeout(() => {
      qs.idx++;
      qs.idx < qs.questions.length ? renderQuizQ() : finishQuiz();
    }, ok ? 700 : 1400);
  }

  function finishQuiz() {
    const qs = quizState;
    const pct = Math.round(qs.correct / qs.questions.length * 100);
    const passed = pct >= 60;
    if (passed) {
      markDone(qs.dayIdx);
      qs.topicIds.forEach(addTopicToSrs);
    }
    const cur = currentDayIdx();
    main().innerHTML = `
      <div class="quiz-box" style="text-align:center;padding-top:40px">
        <div style="font-size:60px;margin-bottom:14px">${passed ? '🎉' : '💪'}</div>
        <div class="view-title">${passed ? 'Hoàn thành!' : 'Cố lên, thử lại nhé!'}</div>
        <p style="color:var(--muted);margin:10px 0 24px">
          Bạn trả lời đúng <b style="color:var(--text)">${qs.correct}/${qs.questions.length}</b> câu (${pct}%).
          ${passed ? 'Ngày học đã được đánh dấu hoàn thành, từ vựng đã thêm vào bộ flashcard.' : 'Cần đạt tối thiểu 60% để hoàn thành ngày học.'}
        </p>
        ${passed
          ? (cur !== -1
              ? `<button class="btn btn-primary btn-lg" style="max-width:340px" onclick="App.go('day',${cur})">Học ngày tiếp theo →</button>`
              : `<button class="btn btn-primary btn-lg" style="max-width:340px" onclick="App.go('dashboard')">🎓 Xem tổng kết</button>`)
          : `<button class="btn btn-primary btn-lg" style="max-width:340px" onclick="App.go('day',${qs.dayIdx})">🔄 Làm lại</button>`}
        <div><button class="btn btn-ghost" onclick="App.go('roadmap')">Về lộ trình</button></div>
      </div>`;
  }

  // ---------- Flashcards (SRS) ----------
  let fcQueue = [], fcFlipped = false;

  function renderFlashcards() {
    fcQueue = shuffle(dueCards());
    if (fcQueue.length === 0) {
      const total = Object.keys(S.srs).length;
      main().innerHTML = `
        <div class="view-title">🃏 Flashcard ôn tập</div>
        <div class="view-sub">Ôn tập ngắt quãng (spaced repetition) — hệ thống tự lên lịch ngày ôn cho từng từ.</div>
        <div class="empty-note">
          ${total === 0
            ? 'Chưa có thẻ nào. Hãy hoàn thành bài học đầu tiên trong lộ trình,<br>từ vựng sẽ tự động được thêm vào đây.'
            : `✨ Tuyệt vời! Không có thẻ nào đến hạn hôm nay.<br>Tổng cộng ${total} từ đang trong bộ nhớ. Quay lại vào ngày mai nhé!`}
        </div>`;
      return;
    }
    renderFcCard();
  }

  function renderFcCard() {
    if (fcQueue.length === 0) {
      main().innerHTML = `
        <div class="view-title">🃏 Flashcard ôn tập</div>
        <div class="empty-note">🎉 Đã ôn xong tất cả thẻ đến hạn hôm nay!<br>Từ nào bạn "Chưa nhớ" sẽ quay lại vào ngày mai.</div>
        <div style="text-align:center"><button class="btn btn-primary" onclick="App.go('dashboard')">Về tổng quan</button></div>`;
      touchStreak();
      return;
    }
    fcFlipped = false;
    const { v } = fcQueue[0];
    main().innerHTML = `
      <div class="view-title">🃏 Flashcard ôn tập</div>
      <div class="view-sub">Nhấn vào thẻ để lật · còn ${fcQueue.length} thẻ</div>
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
    const { key, card } = fcQueue.shift();
    if (remembered) card.box = Math.min(card.box + 1, SRS_INTERVALS.length - 1);
    else card.box = 0;
    const d = new Date();
    d.setDate(d.getDate() + SRS_INTERVALS[card.box]);
    // Thẻ "đã nhớ" ở hộp 0 vẫn nghỉ ít nhất 1 ngày
    if (remembered && SRS_INTERVALS[card.box] === 0) d.setDate(d.getDate() + 1);
    card.due = fmtDate(d);
    S.srs[key] = card;
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
  function renderTopics() {
    const lvName = { 1: 'Cơ bản', 2: 'Sơ trung', 3: 'Trung cấp' };
    main().innerHTML = `
      <div class="view-title">📚 Thư viện chủ đề</div>
      <div class="view-sub">Xem trước hoặc ôn lại bất kỳ chủ đề nào (không tính vào lộ trình).</div>
      <div class="topic-grid">
        ${TOPICS.map((t, i) => `
          <button class="topic-card" onclick="App.openTopic('${t.id}')">
            <div class="t-ico">${t.icon}</div>
            <div class="t-name">${t.name}</div>
            <div class="t-meta">${t.vocab.length} từ vựng · ${(t.chunks || []).length} cụm giao tiếp · ${t.phrases.length} mẫu câu</div>
            <span class="lvl-badge lvl-${t.level}">${lvName[t.level]}</span>
          </button>`).join('')}
      </div>`;
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
  function renderAdmin() {
    if (!isAdmin()) { go('dashboard'); return; }
    const names = Object.keys(USERS);
    const rows = names.map(u => {
      const st = loadState(u);
      const role = USERS[u].role;
      const prog = st && st.plan ? `${st.done.length}/${st.plan.length}` : '—';
      const pct = st && st.plan ? Math.round(st.done.length / st.plan.length * 100) : 0;
      const words = st ? Object.keys(st.srs).length : 0;
      const acc = st && st.quizStats.total ? Math.round(st.quizStats.correct / st.quizStats.total * 100) + '%' : '—';
      const lvName = st ? ({ 1: 'Cơ bản', 2: 'Sơ trung', 3: 'Trung cấp' })[st.level] : '—';
      return `<tr>
        <td><b>${esc(u)}</b>${role === 'admin' ? ' <span class="role-badge">admin</span>' : ''}<div class="td-sub">tạo: ${USERS[u].created || '—'}</div></td>
        <td>${lvName}</td>
        <td>${prog}<div class="mini-bar"><div style="width:${pct}%"></div></div></td>
        <td>${words}</td>
        <td>${st ? '🔥 ' + st.streak : '—'}</td>
        <td>${acc}</td>
        <td>${st && st.lastStudy ? st.lastStudy : 'chưa học'}</td>
        <td class="td-actions">
          <button class="btn btn-sm btn-outline" onclick="App.adminSetPass('${esc(u)}')" title="Đặt lại mật khẩu">🔑</button>
          <button class="btn btn-sm btn-outline" onclick="App.adminResetUser('${esc(u)}')" title="Xóa tiến độ học">↺</button>
          ${u !== CURRENT ? `<button class="btn btn-sm btn-outline btn-danger" onclick="App.adminDeleteUser('${esc(u)}')" title="Xóa tài khoản">🗑️</button>` : ''}
        </td>
      </tr>`;
    }).join('');

    const students = names.filter(u => USERS[u].role !== 'admin');
    const totalDays = names.reduce((n, u) => { const st = loadState(u); return n + (st ? st.done.length : 0); }, 0);
    const totalWords = names.reduce((n, u) => { const st = loadState(u); return n + (st ? Object.keys(st.srs).length : 0); }, 0);
    const activeToday = names.filter(u => { const st = loadState(u); return st && st.lastStudy === todayStr(); }).length;
    const nVocab = TOPICS.reduce((n, t) => n + t.vocab.length, 0);
    const nPhrases = TOPICS.reduce((n, t) => n + t.phrases.length, 0);
    const nChunks = TOPICS.reduce((n, t) => n + (t.chunks || []).length, 0);

    main().innerHTML = `
      <div class="view-title">🛠️ Quản trị hệ thống</div>
      <div class="view-sub">Quản lý các tài khoản đã đăng ký trên thiết bị này.</div>
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
        <div class="td-sub" style="margin-top:8px">Muốn thêm chủ đề/từ vựng: mở tệp <b>data.js</b>, thêm theo đúng mẫu có sẵn rồi đăng lại web.</div>
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
        <div class="td-sub">Lưu ý: đây là web tĩnh không có máy chủ — tài khoản chỉ lưu trên trình duyệt của từng thiết bị, dùng để phân hồ sơ học và ngăn người dùng thường vào trang quản trị, không phải bảo mật tuyệt đối.</div>
      </div>`;
  }

  function adminSetPass(u) {
    if (!isAdmin() || !USERS[u]) return;
    const p = prompt(`Nhập mật khẩu mới cho tài khoản "${u}" (tối thiểu 4 ký tự):`);
    if (p === null) return;
    if (p.length < 4) { toast('⚠️ Mật khẩu cần ít nhất 4 ký tự'); return; }
    USERS[u].pass = hashPass(p);
    saveUsers();
    toast(`🔑 Đã đổi mật khẩu cho "${u}"`);
  }

  function adminResetUser(u) {
    if (!isAdmin() || !USERS[u]) return;
    if (!confirm(`Xóa toàn bộ tiến độ học của "${u}"? (tài khoản vẫn giữ nguyên)`)) return;
    localStorage.removeItem(stateKey(u));
    if (u === CURRENT) S = null;
    toast(`↺ Đã xóa tiến độ của "${u}"`);
    renderAdmin();
  }

  function adminDeleteUser(u) {
    if (!isAdmin() || !USERS[u] || u === CURRENT) return;
    if (!confirm(`Xóa hẳn tài khoản "${u}" cùng toàn bộ tiến độ học?`)) return;
    delete USERS[u];
    saveUsers();
    localStorage.removeItem(stateKey(u));
    toast(`🗑️ Đã xóa tài khoản "${u}"`);
    renderAdmin();
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

  function resetAll() {
    if (!confirm(`Xóa toàn bộ tiến độ học của tài khoản "${CURRENT}" và làm lại kiểm tra đầu vào?`)) return;
    if (CURRENT) localStorage.removeItem(stateKey(CURRENT));
    location.reload();
  }

  // ---------- PWA: cài đặt + thông báo nhắc học ----------
  let installEvt = null;
  let swReg = null;

  function setupPwa() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js')
        .then(r => { swReg = r; })
        .catch(() => {}); // file:// hoặc trình duyệt cũ: bỏ qua, app vẫn chạy bình thường
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
      if (v) q.push({ title: `📚 ${v.w}${v.ipa ? ' ' + v.ipa : ''}`, body: `${v.m} — "${v.ex}" · Chạm để luyện 1 phút` });
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
    ensureAdmin();
    ['auth-user', 'auth-pass', 'auth-pass2'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') authSubmit(); });
    });
    if (CURRENT && USERS[CURRENT]) {
      enterApp();
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
    togglePush, setPushTime, doneMission,
  };
})();
