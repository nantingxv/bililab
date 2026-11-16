/* BiliLab 前端 */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const api = async (p, opt = {}) => {
  const r = await fetch(p, {
    method: opt.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || j.message || ('HTTP ' + r.status));
  return j;
};
const fmt = n => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  n = Number(n);
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return n.toLocaleString('zh-CN');
};
const pct = n => (n === null || n === undefined || isNaN(n)) ? '—' : (n * 100).toFixed(2) + '%';
const dt = ts => ts ? new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false }) : '—';

let STATE = { logged_in: false, session: null, snapshots: [] };
let DASH = null, charts = {}, pollTimer = null, qrTimer = null;

/* ---------------- 视图切换 ---------------- */
function showView(name) {
  $$('.view').forEach(v => v.hidden = v.id !== 'view-' + name);
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'dash') setTimeout(() => { Object.values(charts).forEach(c => c && c.resize()); }, 30);
  if (name === 'dash' && !DASH) loadDashboard();
}
$$('.nav-btn').forEach(b => b.onclick = () => showView(b.dataset.view));

/* ---------------- 登录 ---------------- */
async function refreshState() {
  STATE = await api('/api/state');
  const s = STATE.session;
  $('#who').textContent = s ? (s.uname + ' · ' + s.mid) : '未登录';
  $('#card-loggedin').hidden = !s;
  $('#card-qr').hidden = !!s;
  $('#card-paste').hidden = !!s;
  if (s) {
    $('#uname').textContent = s.uname;
    $('#umid').textContent = 'UID ' + s.mid + ' · LV' + (s.level ?? '-');
    clearInterval(qrTimer); qrTimer = null;
    loadTags();
  } else if (!qrTimer) {
    startQRLoop();
  }
  renderSnapshots();
}


async function startQRLoop() {
  clearInterval(qrTimer);
  try {
    const d = await api('/api/login/qr');
    const qr = qrcode(0, 'M'); qr.addData(d.url); qr.make();
    $('#qr').innerHTML = qr.createImgTag(5, 4);
    $('#qrstatus').textContent = '用哔哩哔哩 App 扫码';
    qrTimer = setInterval(async () => {
      try {
        const r = await api('/api/login/qr/poll?key=' + encodeURIComponent(d.key));
        if (r.state === 0) {
          clearInterval(qrTimer); qrTimer = null;
          $('#qrstatus').textContent = '登录成功';
          await refreshState(); showView('sync');
        } else if (r.state === 86090) {
          $('#qrstatus').textContent = '已扫描，请在手机上确认';
        } else if (r.state === 86038) {
          $('#qrstatus').textContent = '二维码已失效，请刷新';
          clearInterval(qrTimer); qrTimer = null;
        }
      } catch (e) { /* 忽略单次失败 */ }
    }, 2000);
  } catch (e) {
    $('#qrstatus').textContent = '二维码生成失败：' + e.message;
  }
}
$('#btn-refreshqr').onclick = startQRLoop;

$('#btn-paste').onclick = async () => {
  const el = $('#paste-msg');
  el.className = 'msg'; el.textContent = '校验中…';
  try {
    const r = await api('/api/login/paste', { method: 'POST', body: { text: $('#paste').value } });
    el.className = 'msg ok'; el.textContent = '登录成功：' + r.session.uname;
    await refreshState(); showView('sync');
  } catch (e) { el.className = 'msg err'; el.textContent = e.message; }
};
$('#btn-logout').onclick = async () => {
  await api('/api/logout', { method: 'POST' });
  STATE.session = null; await refreshState(); showView('login');
  startQRLoop();
};
$('#btn-relogin').onclick = async () => {
  await api('/api/logout', { method: 'POST' });
  STATE.session = null; await refreshState(); showView('login'); startQRLoop();
};

/* ---------------- 分组 ---------------- */
let TAGS = [];
async function loadTags() {
  try {
    const d = await api('/api/tags');
    TAGS = d.tags || [];
    $('#tags').innerHTML = TAGS.map(t =>
      `<span class="chip ${t.tagid === 391756240 ? 'on' : ''}" data-id="${t.tagid}">${t.name} · ${t.count}</span>`).join('');
    $$('#tags .chip').forEach(c => c.onclick = () => c.classList.toggle('on'));
  } catch (e) { $('#tags').innerHTML = '<span class="muted">分组加载失败</span>'; }
}

/* ---------------- 抓取 ---------------- */
$('#btn-start').onclick = async () => {
  const max_videos = Number($('#maxvideos').value);
  const rate = Number($('#speed').value);
  const tags = $$('#tags .chip.on').map(c => Number(c.dataset.id));
  if (!tags.length) return alert('至少选择一个分组');
  $('#btn-start').disabled = true;
  $('#progcard').hidden = false;
  try {
    await api('/api/sync', { method: 'POST', body: { max_videos, tag_ids: tags, rate } });
    pollStatus();
  } catch (e) { alert(e.message); $('#btn-start').disabled = false; }
};
$('#btn-stop').onclick = () => api('/api/sync/stop', { method: 'POST' });

async function pollStatus() {
  clearTimeout(pollTimer);
  let p;
  try { p = await api('/api/sync/status'); } catch { return; }
  const accP = p.accounts_total ? p.accounts_done / p.accounts_total : 0;
  const vidP = p.videos_est ? Math.min(1, p.videos_done / p.videos_est) : 0;
  $('#bar-acc').style.width = (accP * 100).toFixed(1) + '%';
  $('#bar-vid').style.width = (vidP * 100).toFixed(1) + '%';
  $('#lbl-acc').textContent = `账号 ${p.accounts_done} / ${p.accounts_total}`;
  $('#lbl-vid').textContent = `视频 ${p.videos_done} 条（预估 ${p.videos_est}）`;
  $('#prog-phase').textContent = p.message || p.phase;
  $('#prog-eta').textContent = p.eta ? `剩余约 ${Math.ceil(p.eta / 60)} 分钟` : '';
  $('#prog-stats').innerHTML = `<span>成功 <b>${p.ok}</b></span><span>失败 <b>${p.fail}</b></span>
    <span>重试 <b>${p.retry}</b></span><span>速度 <b>${p.req_per_s || 0}</b> 请求/秒</span>
    <span>限速 <b>${p.rate || '—'}</b>/秒</span><span>已用 <b>${p.elapsed}s</b></span><span>当前 <b>${p.current || '—'}</b></span>`;
  $('#prog-log').textContent = (p.errors || []).join('\n');

  if (p.running) {
    pollTimer = setTimeout(pollStatus, 1000);
  } else {
    $('#btn-start').disabled = false;
    await refreshState();
    if (p.phase === 'done') {
      showView('dash');
      DASH = null; loadDashboard();
    }
  }
}

/* ---------------- 自动记录 / 开机启动 ---------------- */
let NEXT_TS = null;

function fmtLeft(ts) {
  if (!ts) return '未启用';
  const s = Math.round(ts - Date.now() / 1000);
  if (s <= 0) return '即将运行…';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  const at = new Date(ts * 1000).toLocaleString('zh-CN',
    { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return `下次 ${at}（约 ${h > 0 ? h + ' 小时 ' : ''}${m} 分钟后）`;
}

let ALARMS = [];

function renderAlarms() {
  const box = $('#alarm-list');
  if (!box) return;
  if (!ALARMS.length) { box.innerHTML = '<span class="muted">还没有</span>'; return; }
  box.innerHTML = ALARMS.map(t =>
    '<span class="chip on" data-t="' + t + '">' + t + ' <b style="cursor:pointer;margin-left:4px">×</b></span>'
  ).join('');
  box.querySelectorAll('.chip b').forEach(el => {
    el.onclick = () => {
      const t = el.parentElement.dataset.t;
      ALARMS = ALARMS.filter(x => x !== t);
      renderAlarms();
    };
  });
}

/* 轻量 toast 提示 */
let TOAST_T = null;
function toast(text, ok) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.className = 'toast ' + (ok === false ? 'err' : 'ok');
  el.textContent = text;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(TOAST_T);
  TOAST_T = setTimeout(() => { el.classList.remove('show'); }, 2200);
}

function addAlarm() {
  const el = $('#alarm-time');
  const v = (el.value || '').trim();
  if (!/^\d{2}:\d{2}$/.test(v)) { toast('请先选一个时间', false); el.focus(); return; }
  const h = Number(v.split(':')[0]);
  if (h > 23) { toast('时间格式不对', false); return; }
  if (ALARMS.includes(v)) { toast(v + ' 已经在列表里了', false); el.focus(); return; }
  ALARMS.push(v);
  ALARMS.sort();
  renderAlarms();
  el.value = '';
  el.focus();
  toast('已添加 ' + v, true);
}

async function loadAuto() {
  try {
    const d = await api('/api/auto');
    $('#auto-on').checked = !!d.auto.enabled;
    ALARMS = (d.auto.alarms || []).slice();
    renderAlarms();
    $('#auto-maxv').value = String(d.auto.max_videos ?? 20);
    $('#auto-rate').value = String(d.auto.rate ?? 8);
    $('#startup-on').checked = !!d.startup;
    $('#startup-cmd').textContent = d.startup_cmd || '';
    NEXT_TS = d.next_run || null;
    $('#auto-next').textContent = fmtLeft(NEXT_TS);
  } catch (e) { /* 未登录时忽略 */ }
}

$('#btn-add-alarm').onclick = addAlarm;
$('#alarm-time').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addAlarm(); } });

$('#btn-auto-save').onclick = async () => {
  const btn = $('#btn-auto-save');
  const msg = $('#auto-msg');
  if (btn.disabled) return;
  btn.disabled = true;
  const oldLabel = btn.textContent;
  btn.textContent = '保存中…';
  msg.className = 'msg'; msg.textContent = '';
  try {
    const r = await api('/api/auto', {
      method: 'POST',
      body: {
        enabled: $('#auto-on').checked,
        alarms: ALARMS,
        max_videos: Number($('#auto-maxv').value),
        rate: Number($('#auto-rate').value),
      },
    });
    NEXT_TS = r.next_run || null;
    $('#auto-next').textContent = fmtLeft(NEXT_TS);
    toast('闹铃设置已保存', true);
  } catch (e) {
    toast('保存失败：' + e.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = oldLabel;
  }
};

$('#startup-on').onchange = async e => {
  try {
    const r = await api('/api/startup', { method: 'POST', body: { enabled: e.target.checked } });
    e.target.checked = !!r.startup;
    $('#startup-cmd').textContent = r.startup_cmd;
  } catch (err) { alert(err.message); }
};

setInterval(() => { if (NEXT_TS) $('#auto-next').textContent = fmtLeft(NEXT_TS); }, 30000);

/* 后台自动跑起来时，前端自动接管进度显示 */
setInterval(async () => {
  try {
    const st = await api('/api/state');
    const p = st.progress || {};
    if (p.running && !pollTimer) {
      $('#progcard').hidden = false;
      $('#btn-start').disabled = true;
      pollStatus();
    }
  } catch (e) { /* ignore */ }
}, 15000);

/* ---------------- 看板 ---------------- */
function renderSnapshots() {
  const sel = $('#snap-select');
  sel.innerHTML = (STATE.snapshots || []).map(s =>
    `<option value="${s.snapshot_id}">${s.created_at.slice(5, 16)} · ${s.accounts}号 ${s.videos}视频</option>`).join('');
}

async function loadDashboard(sid) {
  try {
    const q = sid ? '?snapshot_id=' + encodeURIComponent(sid) : '';
    DASH = await api('/api/dashboard' + q);
  } catch (e) {
    $('#dash-empty').hidden = false; $('#dash-body').hidden = true;
    $('#dash-empty').textContent = '还没有数据：' + e.message;
    return;
  }
  $('#dash-empty').hidden = true; $('#dash-body').hidden = false;
  const m = DASH.meta;
  $('#dl-json').href = '/api/export?kind=json&snapshot_id=' + m.snapshot_id;
  $('#dl-videos').href = '/api/export?kind=videos&snapshot_id=' + m.snapshot_id;
  $('#dl-accounts').href = '/api/export?kind=accounts&snapshot_id=' + m.snapshot_id;
  renderKPIs(); renderRank(); renderAccountSelect(); renderSingle(); renderCross(); renderDurChart(); renderSurviveChart(); renderSurvivalChart();
  setTimeout(() => { Object.values(charts).forEach(c => c && c.resize()); openTabFromHash(); }, 60);
}

function renderKPIs() {
  const o = DASH.overview;
  const items = [
    ['账号', fmt(o.accounts)], ['有投稿账号', fmt(o.accounts_with_video)],
    ['视频', fmt(o.videos)], ['总播放', fmt(o.sum_view)],
    ['总点赞', fmt(o.sum_like)], ['总投币', fmt(o.sum_coin)],
    ['总收藏', fmt(o.sum_fav)], ['粉丝合计', fmt(o.sum_follower)],
    ['中位播放', fmt(o.median_view)], ['中位互动率', pct(o.median_engagement)],
    ['单视频最高', fmt(o.max_view)], ['快照', (o.created_at || '').slice(5, 16)],
  ];
  $('#kpis').innerHTML = items.map(([k, v]) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
}

const COLS = [
  ['uname', '账号', v => v, 'name l'], ['mid', 'UID', v => v, 'l'],
  ['follower', '粉丝', fmt, ''], ['videos_fetched', '视频', fmt, ''],
  ['first_post', '首条视频', v => v ? new Date(v * 1000).toLocaleDateString('zh-CN') : '—', ''],
  ['sum_view', '总播放', fmt, ''], ['median_view', '中位播放', fmt, ''],
  ['max_view', '最高播放', fmt, ''], ['sum_like', '点赞', fmt, ''],
  ['sum_coin', '投币', fmt, ''], ['sum_fav', '收藏', fmt, ''],
  ['engagement', '互动率', pct, ''],
  ['peak_hour', '高峰时段', v => (v === null || v === undefined) ? '—' : String(v).padStart(2, '0') + ':00', ''],
  ['night_share', '凌晨占比', v => (v === null || v === undefined) ? '—' : (v * 100).toFixed(0) + '%', ''],
  ['decline_ratio', '末/初', v => v === null ? '—' : (v * 100).toFixed(0) + '%', ''],
];
let sortKey = 'sum_view', sortDesc = true, filterText = '';

function renderRank() {
  const rows = (DASH.accounts || [])
    .filter(a => !filterText || (a.uname || '').toLowerCase().includes(filterText) || String(a.mid).includes(filterText))
    .sort((a, b) => {
      const x = a[sortKey], y = b[sortKey];
      if (x === null) return 1; if (y === null) return -1;
      return (x > y ? 1 : x < y ? -1 : 0) * (sortDesc ? -1 : 1);
    });
  $('#tbl-rank thead').innerHTML = '<tr>' + COLS.map(c =>
    `<th class="${c[3]}" data-k="${c[0]}">${c[1]}${sortKey === c[0] ? (sortDesc ? ' ↓' : ' ↑') : ''}</th>`).join('') + '</tr>';
  $('#tbl-rank tbody').innerHTML = rows.map(a => '<tr>' + COLS.map(c => {
    let v = c[2](a[c[0]]), cls = c[3];
    if (c[0] === 'decline_ratio' && a[c[0]] !== null) cls += a[c[0]] >= 1 ? ' pos' : ' neg';
    return `<td class="${cls}">${v ?? '—'}</td>`;
  }).join('') + '</tr>').join('');
  $('#rank-count').textContent = rows.length + ' 个账号';
  $$('#tbl-rank th').forEach(th => th.onclick = () => {
    const k = th.dataset.k;
    if (sortKey === k) sortDesc = !sortDesc; else { sortKey = k; sortDesc = true; }
    renderRank();
  });
  $$('#tbl-rank tbody tr').forEach((tr, i) => tr.onclick = () => {
    const a = rows[i];
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'single'));
    $$('.pane').forEach(p => p.hidden = p.id !== 'pane-single');
    selectAccount(a.mid);
    setTimeout(() => Object.values(charts).forEach(c => c && c.resize()), 30);
  });
}
$('#q').oninput = e => { filterText = e.target.value.trim(); renderRank(); };

let curMid = null, accMatches = [];

function candidateAccounts() {
  return (DASH.accounts || []).filter(a => a.videos_fetched > 0)
    .sort((x, y) => (y.sum_view || 0) - (x.sum_view || 0));
}

function renderAccountSearch(q) {
  const ql = (q || '').trim().toLowerCase();
  let list = candidateAccounts();
  if (ql) list = list.filter(a => (a.uname || '').toLowerCase().includes(ql) || String(a.mid).includes(ql));
  else list = list.slice(0, 40);
  accMatches = list.slice(0, 60);
  const box = $('#acc-list');
  if (!accMatches.length) {
    box.innerHTML = '<div class="empty">没有匹配的账号</div>';
    box.hidden = false;
    return;
  }
  box.innerHTML = accMatches.map((a, i) =>
    `<div class="item${i === 0 ? ' sel' : ''}" data-mid="${a.mid}">
       <span class="n">${a.uname}</span>
       <span class="m">${fmt(a.follower)} 粉 · ${a.videos_fetched} 视频</span>
     </div>`).join('');
  box.hidden = false;
  box.querySelectorAll('.item').forEach(el => {
    el.onmousedown = e => { e.preventDefault(); selectAccount(Number(el.dataset.mid)); };
  });
}

function selectAccount(mid) {
  curMid = mid;
  const a = (DASH.accounts || []).find(x => x.mid === mid);
  if (a) $('#acc-q').value = a.uname;
  $('#acc-list').hidden = true;
  renderSingle();
}

function renderAccountSelect() {
  if (curMid && (DASH.accounts || []).some(a => a.mid === curMid)) {
    const a = DASH.accounts.find(x => x.mid === curMid);
    $('#acc-q').value = a.uname;
    return;
  }
  const first = candidateAccounts()[0];
  curMid = first ? first.mid : null;
  $('#acc-q').value = first ? first.uname : '';
}

function chart(id) {
  const el = $('#' + id);
  if (!charts[id]) charts[id] = echarts.init(el, null, { renderer: 'canvas' });
  return charts[id];
}
const AXIS = { axisLine: { lineStyle: { color: '#2c3541' } }, splitLine: { lineStyle: { color: '#1e252e' } }, axisLabel: { color: '#8b98a5' } };
const TIP = { backgroundColor: '#161b22', borderColor: '#2c3541', textStyle: { color: '#e6edf3', fontSize: 12 } };

function renderSingle() {
  const mid = curMid;
  const a = (DASH.accounts || []).find(x => x.mid === mid);
  if (!a) { $('#acc-meta').textContent = '没有可显示的账号'; return; }
  $('#acc-meta').textContent = `粉丝 ${fmt(a.follower)} · 抓取 ${a.videos_fetched}/${a.video_total ?? '?'} 条 · 互动率 ${pct(a.engagement)} · 首末比 ${a.decline_ratio ? (a.decline_ratio * 100).toFixed(0) + '%' : '—'}`;
  const vs = (DASH.videos || []).filter(v => v.mid === mid).sort((x, y) => x.pubdate - y.pubdate);

  chart('chart-single-view').setOption({
    backgroundColor: 'transparent',
    grid: { left: 12, right: 26, top: 44, bottom: 46, containLabel: true },
    title: { text: a.uname + ' · 单视频播放', left: 12, top: 10, textStyle: { color: '#e6edf3', fontSize: 13 } },
    tooltip: { trigger: 'item', ...TIP, formatter: p => `${p.data[3]}<br/>发布 ${dt(p.data[2])}<br/>播放 ${fmt(p.data[1])}` },
    xAxis: { type: 'time', name: '发布时间', nameLocation: 'middle', nameGap: 30, nameTextStyle: { color: '#8b98a5' }, ...AXIS },
    yAxis: { type: 'value', name: '播放量', nameLocation: 'middle', nameGap: 66, nameTextStyle: { color: '#8b98a5' }, ...AXIS },
    series: [{
      type: 'scatter', symbolSize: 9,
      itemStyle: { color: '#4c8dff', opacity: .85 },
      data: vs.map(v => [v.pubdate * 1000, v.view, v.pubdate, v.title.slice(0, 40)]),
    }],
  }, true);

  chart('chart-single-rate').setOption({
    backgroundColor: 'transparent',
    grid: { left: 12, right: 26, top: 44, bottom: 46, containLabel: true },
    title: { text: '互动率走势（赞+币+藏 / 播放）', left: 12, top: 10, textStyle: { color: '#e6edf3', fontSize: 13 } },
    tooltip: { trigger: 'axis', ...TIP, valueFormatter: v => (v * 100).toFixed(2) + '%' },
    xAxis: { type: 'category', name: '发布日期', nameLocation: 'middle', nameGap: 32, nameTextStyle: { color: '#8b98a5' },
      data: vs.map(v => new Date(v.pubdate * 1000).toLocaleDateString('zh-CN')), ...AXIS },
    yAxis: { type: 'value', name: '互动率', nameLocation: 'middle', nameGap: 48, nameTextStyle: { color: '#8b98a5' },
      axisLabel: { color: '#8b98a5', formatter: v => (v * 100).toFixed(0) + '%' }, ...AXIS },
    series: [{ type: 'line', smooth: true, symbolSize: 6, itemStyle: { color: '#38d39f' },
      areaStyle: { opacity: .12, color: '#38d39f' },
      data: vs.map(v => v.view ? +(((v.like + v.coin + v.favorite) / v.view).toFixed(4)) : null) }],
  }, true);

  // 发布时间分布（24 小时）
  const hist = a.hour_hist && a.hour_hist.length === 24
    ? a.hour_hist
    : Array.from({ length: 24 }, (_, h) => vs.filter(v => new Date(v.pubdate * 1000).getHours() === h).length);
  chart('chart-single-hours').setOption({
    backgroundColor: 'transparent',
    grid: { left: 12, right: 26, top: 30, bottom: 46, containLabel: true },
    tooltip: { trigger: 'axis', ...TIP, formatter: p => `${p[0].axisValue}:00 – ${p[0].axisValue}:59<br/>发布 ${p[0].value} 条` },
    xAxis: { type: 'category', name: '一天中的时段（小时）', nameLocation: 'middle', nameGap: 30,
      nameTextStyle: { color: '#8b98a5' }, data: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')), ...AXIS },
    yAxis: { type: 'value', name: '条数', nameTextStyle: { color: '#8b98a5' }, ...AXIS, minInterval: 1 },
    series: [{
      type: 'bar', barWidth: '62%',
      data: hist.map((n, i) => ({ value: n, itemStyle: { color: i < 6 ? '#3d4c66' : '#4c8dff', borderRadius: [2, 2, 0, 0] } })),
    }],
  }, true);

  const dh = (a.duration_hist && a.duration_hist.length)
    ? a.duration_hist
    : (() => {
        const h = [0, 0, 0, 0, 0, 0, 0];
        const edges = [60, 120, 180, 300, 480, 900];
        vs.forEach(v => {
          const q = (v.duration || '').split(':').map(Number);
          if (q.some(isNaN)) return;
          const sec = q.length === 2 ? q[0] * 60 + q[1] : q[0] * 3600 + q[1] * 60 + q[2];
          const idx = edges.findIndex(e => sec < e);
          h[idx < 0 ? 6 : idx]++;
        });
        return h;
      })();
  chart('chart-single-dur').setOption({
    backgroundColor: 'transparent',
    grid: { left: 12, right: 26, top: 30, bottom: 46, containLabel: true },
    tooltip: { trigger: 'axis', ...TIP, formatter: p => p[0].axisValue + '<br/>' + p[0].value + ' 条' },
    xAxis: { type: 'category', name: '时长区间', nameLocation: 'middle', nameGap: 30,
      nameTextStyle: { color: '#8b98a5' }, data: ['<1分','1–2分','2–3分','3–5分','5–8分','8–15分','>15分'], ...AXIS },
    yAxis: { type: 'value', name: '条数', nameTextStyle: { color: '#8b98a5' }, ...AXIS, minInterval: 1 },
    series: [{
      type: 'bar', barWidth: '58%',
      data: dh.map((n, i) => ({ value: n, itemStyle: { color: i === 0 ? '#ffb648' : '#4c8dff', borderRadius: [2, 2, 0, 0] } })),
      label: { show: true, position: 'top', color: '#8b98a5', fontSize: 10 },
    }],
  }, true);

  const top = [...vs].sort((x, y) => y.view - x.view).slice(0, 10);
  $('#tbl-top thead').innerHTML = '<tr><th class="l">标题</th><th>发布</th><th>播放</th><th>点赞</th><th>投币</th><th>收藏</th><th>评论</th><th>互动率</th></tr>';
  $('#tbl-top tbody').innerHTML = top.map(v => `<tr data-bvid="${v.bvid}" style="cursor:pointer"><td class="l name" title="${v.title}">${v.title}</td>
    <td>${new Date(v.pubdate * 1000).toLocaleDateString('zh-CN')}</td><td>${fmt(v.view)}</td>
    <td>${fmt(v.like)}</td><td>${fmt(v.coin)}</td><td>${fmt(v.favorite)}</td><td>${fmt(v.reply)}</td>
    <td>${pct(v.view ? (v.like + v.coin + v.favorite) / v.view : null)}</td></tr>`).join('');
  $$('#tbl-top tbody tr').forEach(tr => tr.onclick = () => {
    const v = top.find(x => x.bvid === tr.dataset.bvid);
    if (v) loadVideoHistory(v);
  });
  if (top.length) loadVideoHistory(top[0], true);
}

async function loadVideoHistory(v, quiet) {
  try {
    const d = await api('/api/video_history?bvid=' + encodeURIComponent(v.bvid));
    const pts = d.points || [];
    chart('chart-video-history').setOption({
      backgroundColor: 'transparent',
      grid: { left: 12, right: 26, top: 52, bottom: 46, containLabel: true },
      title: {
        text: (v.title || '').slice(0, 34),
        subtext: pts.length > 1 ? `共 ${pts.length} 次快照记录` : '这条视频只在 1 次快照里出现过',
        left: 12, top: 8,
        textStyle: { color: '#e6edf3', fontSize: 13 },
        subtextStyle: { color: '#8b98a5', fontSize: 11 },
      },
      tooltip: { trigger: 'axis', ...TIP },
      legend: { top: 8, right: 8, textStyle: { color: '#8b98a5', fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
      xAxis: { type: 'category', name: '快照时间', nameLocation: 'middle', nameGap: 30,
        nameTextStyle: { color: '#8b98a5' },
        data: pts.map(p => p.created_at.slice(5, 16).replace('T', ' ')), ...AXIS },
      yAxis: [
        { type: 'value', name: '播放量', nameTextStyle: { color: '#8b98a5' }, ...AXIS, axisLabel: { color: '#8b98a5', formatter: fmt } },
        { type: 'value', name: '互动率', nameTextStyle: { color: '#8b98a5' }, ...AXIS, splitLine: { show: false },
          axisLabel: { color: '#8b98a5', formatter: x => (x * 100).toFixed(0) + '%' } },
      ],
      series: [
        { name: '播放量', type: 'line', smooth: true, symbolSize: 7, itemStyle: { color: '#4c8dff' },
          areaStyle: { opacity: .12, color: '#4c8dff' }, data: pts.map(p => p.view) },
        { name: '互动率', type: 'line', smooth: true, symbolSize: 6, yAxisIndex: 1,
          itemStyle: { color: '#ffb648' }, data: pts.map(p => p.engagement) },
      ],
    }, true);
  } catch (e) {
    if (!quiet) console.warn('video history failed', e);
  }
}

let TOP_N = 20, TOP_RANK = [];

function renderTopChart() {
  TOP_RANK = (DASH.accounts || []).filter(a => a.sum_view > 0)
    .sort((a, b) => b.sum_view - a.sum_view);
  const showLabel = TOP_N <= 40 && TOP_RANK.length <= 120;
  chart('chart-top').setOption({
    backgroundColor: 'transparent',
    grid: { left: 8, right: 74, top: 16, bottom: 40, containLabel: true },
    tooltip: { trigger: 'axis', ...TIP, axisPointer: { type: 'shadow' }, valueFormatter: v => fmt(v) },
    dataZoom: [{
      id: 'yz', type: 'slider', yAxisIndex: 0,
      zoomLock: true, startValue: 0, endValue: TOP_N - 1,
      right: 16, width: 14, top: 16, bottom: 40,
      backgroundColor: '#12161c', borderColor: '#2c3541',
      fillerColor: 'rgba(76,141,255,.22)', handleSize: '70%',
      dataBackground: { lineStyle: { color: '#3a4756' }, areaStyle: { color: '#1c232c' } },
      textStyle: { color: '#8b98a5', fontSize: 10 }, brushSelect: false, showDetail: false,
    }],
    xAxis: { type: 'value', name: '总播放', nameLocation: 'middle', nameGap: 28,
      nameTextStyle: { color: '#8b98a5' },
      ...AXIS, axisLabel: { color: '#8b98a5', formatter: fmt } },
    yAxis: { type: 'category', inverse: true, data: TOP_RANK.map(a => a.uname), ...AXIS,
      axisLabel: { color: '#c9d1d9', fontSize: TOP_N > 40 ? 9 : 11 } },
    series: [{
      type: 'bar', data: TOP_RANK.map(a => a.sum_view),
      itemStyle: { color: '#4c8dff', borderRadius: [0, 4, 4, 0] },
      label: { show: showLabel, position: 'right', distance: 5,
        color: '#8b98a5', fontSize: 11, formatter: p => fmt(p.value) },
    }],
  }, true);
}
let AGE_DAYS = 14;

function renderAgeChart() {
  const pal = ['#4c8dff', '#38d39f', '#ffb648', '#ff6b6b', '#a78bfa', '#22d3ee', '#f472b6', '#84cc16'];
  const accs = (DASH.accounts || []).filter(a => a.sum_view > 0);
  const accsIdx = {};
  accs.forEach((a, i) => { accsIdx[a.mid] = i; });
  const cutoff = Date.now() - AGE_DAYS * 86400000;
  const vs = (DASH.videos || [])
    .filter(v => v.view > 0 && v.pubdate && v.pubdate * 1000 >= cutoff)
    .sort((a, b) => a.pubdate - b.pubdate);
  // 全窗口平均播放（水平虚线）与逐日平均播放（折线）
  const totalView = vs.reduce((s, v) => s + v.view, 0);
  const globalAvg = vs.length ? totalView / vs.length : 0;
  const dayMap = new Map();
  vs.forEach(v => {
    const d = new Date(v.pubdate * 1000);
    const k = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (!dayMap.has(k)) dayMap.set(k, { sum: 0, n: 0 });
    const o = dayMap.get(k);
    o.sum += v.view; o.n++;
  });
  const dayAvg = [...dayMap.keys()].sort((a, b) => a - b)
    .map(k => [k, Math.max(1, Math.round(dayMap.get(k).sum / dayMap.get(k).n))]);
  chart('chart-age').setOption({
    backgroundColor: 'transparent',
    grid: { left: 12, right: 26, top: 46, bottom: 46, containLabel: true },
    legend: { top: 6, right: 8, textStyle: { color: '#8b98a5', fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
    tooltip: {
      ...TIP,
      formatter: p => {
        if (p.seriesName === '当日平均播放') {
          return `${new Date(p.value[0]).toLocaleDateString('zh-CN')}<br/>当日平均播放 ${fmt(p.value[1])}`;
        }
        return `${p.value[3]}<br/>发布 ${new Date(p.value[0]).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}<br/>播放 ${fmt(p.value[1])}`;
      },
    },
    xAxis: { type: 'time', name: '发布日期（近 ' + AGE_DAYS + ' 天）', nameLocation: 'middle', nameGap: 30,
      nameTextStyle: { color: '#8b98a5' }, ...AXIS },
    yAxis: { type: 'log', name: '播放量', nameLocation: 'middle', nameGap: 66,
      nameTextStyle: { color: '#8b98a5' }, ...AXIS },
    series: [
      {
        name: '单条视频', type: 'scatter', symbolSize: 6,
        large: true, largeThreshold: 600,
        itemStyle: { color: '#4c8dff', opacity: .55 },
        data: vs.map(v => [v.pubdate * 1000, Math.max(1, v.view), v.mid, v.title.slice(0, 30)]),
        markLine: {
          silent: true, symbol: 'none', animation: false,
          lineStyle: { color: '#38d39f', type: 'dashed', width: 1.4 },
          label: { formatter: '平均播放 ' + fmt(Math.round(globalAvg)), position: 'insideEndTop',
                   color: '#38d39f', fontSize: 11 },
          data: [{ yAxis: Math.max(1, globalAvg) }],
        },
      },
      {
        name: '当日平均播放', type: 'line', smooth: true, symbolSize: 5, z: 5,
        itemStyle: { color: '#ffb648' }, lineStyle: { width: 2 },
        data: dayAvg,
      },
    ],
  }, true);
}

function bindAgeDays() {
  const el = document.getElementById('agedays');
  if (!el) return;
  const apply = () => {
    const v = Math.max(1, Math.min(365, Number(el.value) || 14));
    el.value = v;
    if (v === AGE_DAYS) return;
    AGE_DAYS = v;
    if (DASH) renderAgeChart();
  };
  el.addEventListener('change', apply);
  el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); apply(); el.blur(); } });
}
function renderCross() {
  renderTopChart();

  const accs = (DASH.accounts || []).filter(a => a.sum_view > 0);
  const pal = ['#4c8dff', '#38d39f', '#ffb648', '#ff6b6b', '#a78bfa', '#22d3ee', '#f472b6', '#84cc16'];
  const accsIdx = {}; accs.forEach((a, i) => accsIdx[a.mid] = i);
  renderAgeChart();

  const pts = accs.filter(a => a.follower !== null && a.median_view);
  const maxF = Math.max(10, ...pts.map(a => a.follower), ...pts.map(a => a.median_view));
  const lim = Math.pow(10, Math.ceil(Math.log10(maxF)));
  chart('chart-fans').setOption({
    backgroundColor: 'transparent',
    grid: { left: 12, right: 26, top: 26, bottom: 46, containLabel: true },
    tooltip: { ...TIP, formatter: p => `${p.value[2]}<br/>粉丝 ${fmt(p.value[0])}<br/>中位播放 ${fmt(p.value[1])}` },
    xAxis: { type: 'log', min: 1, max: lim, name: '粉丝数', nameLocation: 'middle', nameGap: 30,
      nameTextStyle: { color: '#8b98a5' }, ...AXIS },
    yAxis: { type: 'log', min: 1, max: lim, name: '中位播放', nameLocation: 'middle', nameGap: 60,
      nameTextStyle: { color: '#8b98a5' }, ...AXIS },
    series: [{
      type: 'scatter', symbolSize: 8, itemStyle: { color: '#a78bfa', opacity: .8 },
      data: pts.map(a => [Math.max(1, a.follower), Math.max(1, a.median_view), a.uname]),
      markLine: {
        silent: true, symbol: 'none', animation: false,
        lineStyle: { color: '#6b7d94', type: 'dashed', width: 1.2, opacity: .85 },
        label: { show: true, formatter: '播放 = 粉丝', position: 'middle', color: '#6b7d94', fontSize: 10 },
        data: [[{ coord: [1, 1] }, { coord: [lim, lim] }]],
      },
    }],
  }, true);

  renderTimelineChart();

  // ⑤ 全组 24 小时发布时段分布
  const ghist = (DASH.hours && DASH.hours.length === 24) ? DASH.hours
    : Array.from({ length: 24 }, (_, h) => (DASH.videos || []).filter(v => v.hour === h).length);
  const gmax = Math.max(...ghist, 1);
  const gTotal = ghist.reduce((s, x) => s + x, 0) || 1;
  chart('chart-hours').setOption({
    backgroundColor: 'transparent',
    grid: { left: 12, right: 26, top: 30, bottom: 46, containLabel: true },
    tooltip: {
      trigger: 'axis', ...TIP,
      formatter: p => {
        const h = Number(p[0].axisValue);
        const n = p[0].value;
        return `${String(h).padStart(2, '0')}:00 – ${String(h).padStart(2, '0')}:59<br/>发布 ${n} 条（占全天 ${(n / gTotal * 100).toFixed(1)}%）`;
      },
    },
    xAxis: { type: 'category', name: '一天中的时段（小时）', nameLocation: 'middle', nameGap: 30,
      nameTextStyle: { color: '#8b98a5' },
      data: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')), ...AXIS },
    yAxis: { type: 'value', name: '视频条数', nameTextStyle: { color: '#8b98a5' }, ...AXIS, minInterval: 1 },
    series: [{
      type: 'bar', barWidth: '62%',
      data: ghist.map((n, i) => ({ value: n, itemStyle: { color: i < 6 ? '#3d4c66' : '#4c8dff', borderRadius: [2, 2, 0, 0] } })),
      markLine: {
        silent: true, symbol: 'none', label: { show: false },
        lineStyle: { color: '#ff6b6b', type: 'dashed', width: 1 },
        data: [{ yAxis: ghist.reduce((s, x) => s + x, 0) / 24 }],
      },
    }],
  }, true);

  // ⑥ 每个账号首条视频的时间分布
  const known = (DASH.accounts || []).filter(x => x.first_post_known && x.first_post);

  const byDay = new Map();
  for (const x of known) {
    const d = new Date(x.first_post * 1000);
    const k = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    byDay.set(k, (byDay.get(k) || 0) + 1);
  }
  const allDays = [...byDay.keys()].sort((a, b) => a - b);
  const maxDay = allDays.length ? allDays[allDays.length - 1] : Date.now();
  const cutoff = maxDay - 60 * 86400000;
  const days = allDays.filter(k => k >= cutoff);
  const early = allDays.filter(k => k < cutoff).length;
  let cum = early;
  const cumArr = days.map(k => (cum += byDay.get(k)));
  chart('chart-firstpost').setOption({
    backgroundColor: 'transparent',
    grid: { left: 12, right: 30, top: 40, bottom: 46, containLabel: true },
    legend: { top: 4, right: 8, textStyle: { color: '#8b98a5', fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
    tooltip: { trigger: 'axis', ...TIP },
    xAxis: { type: 'category', name: '首次发视频的日期', nameLocation: 'middle', nameGap: 30,
      nameTextStyle: { color: '#8b98a5' },
      data: days.map(k => { const d = new Date(k); return (d.getMonth() + 1) + '/' + d.getDate(); }), ...AXIS },
    yAxis: [
      { type: 'value', name: '当天新开号', nameTextStyle: { color: '#8b98a5' }, ...AXIS, minInterval: 1 },
      { type: 'value', name: '累计账号', nameTextStyle: { color: '#8b98a5' }, ...AXIS, splitLine: { show: false } },
    ],
    series: [
      { name: '当天新开号', type: 'bar', barWidth: '62%',
        itemStyle: { color: 'rgba(76,141,255,.8)', borderRadius: [2, 2, 0, 0] },
        data: days.map(k => byDay.get(k)) },
      { name: '累计账号', type: 'line', yAxisIndex: 1, smooth: true, symbolSize: 5,
        itemStyle: { color: '#ffb648' }, lineStyle: { width: 1.8 }, data: cumArr },
    ],
  }, true);
}


function renderDurChart() {
  const gdur = (DASH.durations && DASH.durations.length === 7) ? DASH.durations : [0, 0, 0, 0, 0, 0, 0];
  const total = gdur.reduce((s, x) => s + x, 0) || 1;
  chart('chart-dur').setOption({
    backgroundColor: 'transparent',
    grid: { left: 12, right: 26, top: 30, bottom: 46, containLabel: true },
    tooltip: {
      trigger: 'axis', ...TIP,
      formatter: p => p[0].axisValue + '<br/>' + p[0].value + ' 条（占 ' + (p[0].value / total * 100).toFixed(1) + '%）',
    },
    xAxis: { type: 'category', name: '时长区间', nameLocation: 'middle', nameGap: 30,
      nameTextStyle: { color: '#8b98a5' }, data: ['<1分','1–2分','2–3分','3–5分','5–8分','8–15分','>15分'], ...AXIS },
    yAxis: { type: 'value', name: '视频条数', nameTextStyle: { color: '#8b98a5' }, ...AXIS },
    series: [{
      type: 'bar', barWidth: '58%',
      data: gdur.map((n, i) => ({ value: n, itemStyle: { color: i === 0 ? '#ffb648' : '#4c8dff', borderRadius: [2, 2, 0, 0] } })),
      label: { show: true, position: 'top', color: '#8b98a5', fontSize: 10,
        formatter: p => (p.value / total * 100).toFixed(0) + '%' },
    }],
  }, true);
}

function renderSurviveChart() {
  const nowS = Date.now() / 1000;
  const edges = [1, 2, 3, 5, 7];
  const sv = [0, 0, 0, 0, 0, 0];
  (DASH.accounts || []).forEach(a => {
    if (!a.last_post) return;
    const d = (nowS - a.last_post) / 86400;
    let i = edges.findIndex(e => d < e);
    sv[i < 0 ? 5 : i]++;
  });
  const labels = ['<1天', '1–2天', '2–3天', '3–5天', '5–7天', '>7天'];
  const total = sv.reduce((s, x) => s + x, 0) || 1;
  chart('chart-survive').setOption({
    backgroundColor: 'transparent',
    grid: { left: 12, right: 26, top: 30, bottom: 46, containLabel: true },
    tooltip: {
      trigger: 'axis', ...TIP,
      formatter: p => p[0].axisValue + '<br/>' + p[0].value + ' 个账号（占 ' + (p[0].value / total * 100).toFixed(1) + '%）',
    },
    xAxis: { type: 'category', name: '距最近一次投稿', nameLocation: 'middle', nameGap: 30,
      nameTextStyle: { color: '#8b98a5' }, data: labels, ...AXIS },
    yAxis: { type: 'value', name: '账号数', nameTextStyle: { color: '#8b98a5' }, ...AXIS, minInterval: 1 },
    series: [{
      type: 'bar', barWidth: '52%',
      data: sv.map((n, i) => ({ value: n, itemStyle: { color: i === 0 ? '#38d39f' : (i >= 4 ? '#ff6b6b' : '#4c8dff'), borderRadius: [2, 2, 0, 0] } })),
      label: { show: true, position: 'top', color: '#8b98a5', fontSize: 10 },
    }],
  }, true);
}


/* ---------------- ④ 发布密度时间线（窗口可调 + 自适应分桶） ---------------- */
let TL_DAYS = 14;

function pickBucketMs(spanMs) {
  const H = 3600000, D = 86400000;
  const cands = [H, 2 * H, 3 * H, 6 * H, 12 * H, D, 2 * D, 3 * D, 7 * D, 14 * D, 30 * D];
  for (const c of cands) if (spanMs / c <= 60) return c;
  return cands[cands.length - 1];
}

function bucketLabel(stepMs, ts) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  if (stepMs >= 86400000) return mm + '-' + dd;
  const hh = String(d.getHours()).padStart(2, '0');
  return mm + '-' + dd + ' ' + hh + ':00';
}

function renderTimelineChart() {
  const spanMs = TL_DAYS * 86400000;
  const step = pickBucketMs(spanMs);
  const tzMs = -new Date().getTimezoneOffset() * 60000;
  const nowLe = Date.now() + tzMs;
  const startLe = Math.floor((nowLe - spanMs) / step) * step;
  const map = new Map();
  for (const v of DASH.videos || []) {
    if (!v.pubdate) continue;
    const le = v.pubdate * 1000 + tzMs;
    if (le < startLe || le > nowLe) continue;
    const k = Math.floor(le / step) * step;
    if (!map.has(k)) map.set(k, { n: 0, acc: new Set() });
    const b = map.get(k);
    b.n++; b.acc.add(v.mid);
  }
  const keys = [];
  for (let k = startLe; k <= nowLe; k += step) keys.push(k);
  const nSeries = keys.map(k => (map.get(k) || { n: 0 }).n);
  const aSeries = keys.map(k => (map.get(k) || { acc: new Set() }).acc.size);
  const labels = keys.map(k => bucketLabel(step, k - tzMs));
  const stepTxt = step >= 86400000
    ? (step / 86400000) + ' 天'
    : (step % 3600000 === 0 ? (step / 3600000) + ' 小时' : Math.round(step / 60000) + ' 分钟');
  const labelEvery = Math.max(1, Math.ceil(keys.length / 14));

  chart('chart-timeline').setOption({
    backgroundColor: 'transparent',
    grid: { left: 12, right: 22, top: 40, bottom: 52, containLabel: true },
    legend: { top: 4, right: 8, textStyle: { color: '#8b98a5', fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
    tooltip: {
      trigger: 'axis', ...TIP,
      formatter: ps => {
        const i = ps[0].dataIndex;
        return labels[i] + ' 起 ' + stepTxt + '<br/>视频 ' + nSeries[i] + ' 条<br/>账号 ' + aSeries[i] + ' 个';
      },
    },
    xAxis: {
      type: 'category', data: labels, name: '每根柱子 = ' + stepTxt,
      nameLocation: 'middle', nameGap: 34, nameTextStyle: { color: '#8b98a5', fontSize: 11 }, ...AXIS,
      axisLabel: { color: '#8b98a5', fontSize: 10, interval: labelEvery - 1 },
    },
    yAxis: [
      { type: 'value', name: '视频数', nameTextStyle: { color: '#8b98a5' }, ...AXIS, axisLabel: { color: '#8b98a5' } },
      { type: 'value', name: '账号数', nameTextStyle: { color: '#8b98a5' }, ...AXIS,
        axisLabel: { color: '#8b98a5' }, splitLine: { show: false } },
    ],
    series: [
      { name: '视频数', type: 'bar', barWidth: '72%',
        itemStyle: { color: 'rgba(76,141,255,.75)', borderRadius: [2, 2, 0, 0] }, data: nSeries },
      { name: '独立账号', type: 'line', smooth: true, symbolSize: 4, yAxisIndex: 1,
        itemStyle: { color: '#38d39f' }, lineStyle: { width: 1.6 }, data: aSeries },
    ],
  }, true);
}

function bindTimelineDays() {
  const el = document.getElementById('tldays');
  if (!el) return;
  const apply = () => {
    const v = Math.max(1, Math.min(365, Number(el.value) || 14));
    el.value = v;
    if (v === TL_DAYS) return;
    TL_DAYS = v;
    if (DASH) renderTimelineChart();
  };
  el.addEventListener('change', apply);
  el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); apply(); el.blur(); } });
}

/* ---------------- 趋势页 ---------------- */
let TREND_N = 20;

function trendRankChart(domId, rows, valKey, color, axisName, fmtFn) {
  const inst = chart(domId);
  const labels = rows.map(r => r.uname);
  const values = rows.map(r => r[valKey]);
  inst.setOption({
    backgroundColor: 'transparent',
    grid: { left: 8, right: 86, top: 16, bottom: 40, containLabel: true },
    tooltip: {
      trigger: 'axis', ...TIP, axisPointer: { type: 'shadow' },
      formatter: ps => {
        const i = ps[0].dataIndex;
        const r = rows[i];
        return r.uname + '<br/>' + axisName + ' ' + fmtFn(r[valKey]) +
          '<br/>粉丝 ' + fmt(r.follower) +
          (r.new_videos ? '<br/>新增视频 ' + r.new_videos + ' 条' : '');
      },
    },
    dataZoom: [{
      id: 'z', type: 'slider', yAxisIndex: 0,
      zoomLock: true, startValue: 0, endValue: Math.min(TREND_N, rows.length) - 1,
      right: 16, width: 14, top: 16, bottom: 40,
      backgroundColor: '#12161c', borderColor: '#2c3541',
      fillerColor: 'rgba(76,141,255,.22)', handleSize: '70%',
      dataBackground: { lineStyle: { color: '#3a4756' }, areaStyle: { color: '#1c232c' } },
      textStyle: { color: '#8b98a5', fontSize: 10 }, brushSelect: false, showDetail: false,
    }],
    xAxis: { type: 'value', name: axisName, nameLocation: 'middle', nameGap: 28,
      nameTextStyle: { color: '#8b98a5' }, ...AXIS,
      axisLabel: { color: '#8b98a5', formatter: v => fmt(v) } },
    yAxis: { type: 'category', inverse: true, data: labels, ...AXIS,
      axisLabel: { color: '#c9d1d9', fontSize: TREND_N > 40 ? 9 : 11 } },
    series: [{
      type: 'bar', data: values,
      itemStyle: { color: color, borderRadius: [0, 4, 4, 0] },
      label: { show: TREND_N <= 40 && labels.length <= 120, position: 'right', distance: 5,
        color: '#8b98a5', fontSize: 11, formatter: p => fmtFn(p.value) },
    }],
  }, true);
}

function renderTrend() {
  const t = DASH.trend;
  const note = $('#trend-note');
  if (!t || !t.items || !t.items.length) {
    note.innerHTML = '⚠️ <b>还没有可对比的快照。</b>播放量是累计值，单次快照只能看到「现在多少」，看不到「涨得多快」。<br>再跑一次抓取（间隔建议 ≥6 小时），这里会自动解锁。';
    chart('chart-velocity').clear();
    chart('chart-follower').clear();
    chart('chart-survive-trend').clear();
    return;
  }
  note.innerHTML = '对比 <b>' + t.prev_snapshot + '</b> → <b>' + DASH.meta.snapshot_id +
    '</b>，间隔 <b>' + t.hours + '</b> 小时';

  const accs = t.accounts || [];
  trendRankChart('chart-velocity',
    [...accs].sort((a, b) => b.d_view - a.d_view),
    'd_view', '#38d39f', '播放增量', v => fmt(v));

  trendRankChart('chart-follower',
    accs.filter(a => a.d_follower !== null && a.d_follower !== undefined)
      .sort((a, b) => b.d_follower - a.d_follower),
    'd_follower', '#4c8dff', '粉丝增量', v => (v > 0 ? '+' : '') + fmt(v));

  const sv = t.survival || { prev: [], cur: [], labels: [] };
  chart('chart-survive-trend').setOption({
    backgroundColor: 'transparent',
    grid: { left: 12, right: 26, top: 44, bottom: 46, containLabel: true },
    legend: { top: 6, right: 8, textStyle: { color: '#8b98a5', fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
    tooltip: { trigger: 'axis', ...TIP },
    xAxis: { type: 'category', name: '距最近一次投稿', nameLocation: 'middle', nameGap: 30,
      nameTextStyle: { color: '#8b98a5' }, data: sv.labels, ...AXIS },
    yAxis: { type: 'value', name: '账号数', nameTextStyle: { color: '#8b98a5' }, ...AXIS, minInterval: 1 },
    series: [
      { name: '上次快照', type: 'bar', barGap: '10%',
        itemStyle: { color: 'rgba(139,152,165,.85)', borderRadius: [2, 2, 0, 0] }, data: sv.prev },
      { name: '本次快照', type: 'bar',
        itemStyle: { color: '#4c8dff', borderRadius: [2, 2, 0, 0] }, data: sv.cur },
    ],
  }, true);
}

function bindTrendN() {
  const el = $('#trendn');
  if (!el) return;
  const apply = () => {
    const v = Math.max(5, Math.min(500, Number(el.value) || 20));
    el.value = v;
    if (v === TREND_N) return;
    TREND_N = v;
    if (DASH && DASH.trend) renderTrend();
  };
  el.addEventListener('change', apply);
  el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); apply(); el.blur(); } });
}


/* ---------------- ⑨ 非存活账号趋势 ---------------- */
let SV_DAYS = 14, SV_N = 3, SV_SEQ = 0, SV_TIMER = null;

async function renderSurvivalChart() {
  const seq = ++SV_SEQ;
  const days = SV_DAYS, n = SV_N;
  const box = $('#chart-survival');
  if (box) box.style.opacity = .45;
  let d;
  try {
    d = await api('/api/survival?days=' + days + '&n=' + n);
  } catch (e) {
    if (box) box.style.opacity = 1;
    return;
  }
  if (seq !== SV_SEQ) return;          // 有更新的请求在路上，丢弃这次结果
  if (box) box.style.opacity = 1;

  const rows = d.rows || [];
  const labels = rows.map(r => r.at.slice(5, 16).replace('T', ' '));
  const dead = rows.map(r => r.dead);
  const total = rows.map(r => r.total);
  const aliveRate = rows.map(r => (r.total ? +(r.alive / r.total).toFixed(4) : null));

  chart('chart-survival').setOption({
    backgroundColor: 'transparent',
    grid: { left: 12, right: 34, top: 40, bottom: 48, containLabel: true },
    legend: { top: 4, right: 8, textStyle: { color: '#8b98a5', fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
    tooltip: {
      trigger: 'axis', ...TIP,
      formatter: ps => {
        const i = ps[0].dataIndex;
        return labels[i] + '<br/>非存活 ' + dead[i] + ' 个<br/>账号总数 ' + total[i] +
          '<br/>存活率 ' + (aliveRate[i] !== null ? (aliveRate[i] * 100).toFixed(1) + '%' : '—') +
          '<br/>判定：超过 ' + n + ' 天没更新';
      },
    },
    xAxis: {
      type: 'category', data: labels, ...AXIS,
      axisLabel: { color: '#8b98a5', fontSize: 10, interval: Math.max(0, Math.ceil(labels.length / 14) - 1) },
    },
    yAxis: [
      { type: 'value', ...AXIS, axisLabel: { color: '#8b98a5' }, minInterval: 1 },
      { type: 'value', ...AXIS, splitLine: { show: false }, max: 1, min: 0,
        axisLabel: { color: '#8b98a5', formatter: v => (v * 100).toFixed(0) + '%' } },
    ],
    series: [
      { name: '非存活账号', type: 'bar', barWidth: '62%',
        itemStyle: { color: '#ff6b6b', opacity: .8, borderRadius: [2, 2, 0, 0] },
        data: dead },
      { name: '存活率', type: 'line', yAxisIndex: 1, smooth: true, symbolSize: 4,
        itemStyle: { color: '#38d39f' }, lineStyle: { width: 1.8 },
        data: aliveRate },
    ],
  }, true);
}

function applySurvival() {
  const dEl = $('#svdays'), nEl = $('#svn');
  if (!dEl || !nEl) return;
  const dv = Math.max(1, Math.min(120, Math.round(Number(dEl.value) || 14)));
  const nv = Math.max(0.5, Math.min(60, Number(nEl.value) || 3));
  if (String(dv) !== dEl.value) dEl.value = dv;
  if (String(nv) !== nEl.value) nEl.value = nv;
  if (dv === SV_DAYS && nv === SV_N) return;
  SV_DAYS = dv; SV_N = nv;
  if (DASH) renderSurvivalChart();
}

function bindSurvivalInputs() {
  // 用事件委托：不依赖元素创建顺序，也不怕以后重渲染
  const isSv = e => e.target && (e.target.id === 'svdays' || e.target.id === 'svn');
  const later = () => { clearTimeout(SV_TIMER); SV_TIMER = setTimeout(applySurvival, 450); };
  document.addEventListener('input', e => { if (isSv(e)) later(); });
  document.addEventListener('change', e => { if (isSv(e)) { clearTimeout(SV_TIMER); applySurvival(); } });
  document.addEventListener('keydown', e => {
    if (isSv(e) && e.key === 'Enter') { e.preventDefault(); clearTimeout(SV_TIMER); applySurvival(); e.target.blur(); }
  });
}

/* ---------------- 总播放排行：显示条数输入框 ---------------- */
function bindTopN() {
  const el = $('#topn');
  if (!el) return;
  const apply = () => {
    const v = Math.max(5, Math.min(500, Number(el.value) || 20));
    el.value = v;
    if (v === TOP_N) return;
    TOP_N = v;
    if (DASH) renderTopChart();
  };
  el.addEventListener('change', apply);
  el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); apply(); el.blur(); } });
}

/* ---------------- 交互与启动 ---------------- */
$$('.tab').forEach(t => t.onclick = () => {
  $$('.tab').forEach(x => x.classList.toggle('active', x === t));
  $$('.pane').forEach(p => p.hidden = p.id !== 'pane-' + t.dataset.tab);
  history.replaceState(null, '', '#' + t.dataset.tab);
  const k = t.dataset.tab;
  if (DASH) {
    if (k === 'single') renderSingle();
    else if (k === 'cross') { renderCross(); renderDurChart(); renderSurviveChart(); renderSurvivalChart(); }
    else if (k === 'trend') renderTrend();
  }
  setTimeout(() => Object.values(charts).forEach(c => c && c.resize()), 20);
});

function openTabFromHash() {
  const h = (location.hash || '').replace('#', '');
  const tab = $$('.tab').find(t => t.dataset.tab === h);
  if (tab) tab.click();
}
window.addEventListener('hashchange', openTabFromHash);

$('#acc-q').oninput = e => renderAccountSearch(e.target.value);
$('#acc-q').onfocus = e => renderAccountSearch(e.target.value);
$('#acc-q').onblur = () => setTimeout(() => { $('#acc-list').hidden = true; }, 120);
$('#acc-q').onkeydown = e => {
  if (e.key === 'Enter' && accMatches.length) { e.preventDefault(); selectAccount(accMatches[0].mid); }
  else if (e.key === 'Escape') { $('#acc-list').hidden = true; }
};

$('#btn-reload').onclick = () => loadDashboard($('#snap-select').value);
$('#snap-select').onchange = e => loadDashboard(e.target.value);
window.addEventListener('resize', () => {
  Object.values(charts).forEach(c => c && c.resize());
});

(async () => {
  await refreshState();
  loadAuto();
  bindTopN();
  bindAgeDays();
  bindTimelineDays();
  bindTrendN();
  bindSurvivalInputs();
  const hv = (location.hash || '').replace('#', '');
  const VIEWS = ['login', 'sync', 'dash'], TABS = ['rank', 'single', 'cross', 'trend'];
  const vh = VIEWS.includes(hv) ? hv : (TABS.includes(hv) ? 'dash' : null);
  showView(vh || (STATE.logged_in ? (STATE.snapshots.length ? 'dash' : 'sync') : 'login'));
  if (!STATE.logged_in) startQRLoop();
  else if (STATE.snapshots.length) loadDashboard(STATE.snapshots[0].snapshot_id);
  const p = STATE.progress || {};
  if (p.running) { $('#progcard').hidden = false; pollStatus(); }
})();
