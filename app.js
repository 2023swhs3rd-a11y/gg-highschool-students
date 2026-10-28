/* 경기도 고등학교 학년별 학생수 대시보드
 * 데이터: Google 스프레드시트 'DB' 시트 (Apps Script가 학교알리미 API에서 수집)
 */
(() => {
  "use strict";
  const CFG = window.APP_CONFIG;
  const $ = s => document.querySelector(s);
  const fmt = n => (n == null || isNaN(n)) ? "–" : Math.round(n).toLocaleString("ko-KR");
  const pct = (r, d = 1) => (r == null || !isFinite(r)) ? "–" : (r > 0 ? "+" : "") + (r * 100).toFixed(d) + "%";
  const pctPlain = (r, d = 1) => (r == null || !isFinite(r)) ? "–" : (r * 100).toFixed(d) + "%";
  const ratio = (a, b) => (b > 0 ? a / b : null);
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const TYPE_SHORT = { "일반고등학교": "일반고", "특수목적고등학교": "특목고", "특성화고등학교": "특성화고", "자율고등학교": "자율고" };
  const TYPE_ORDER = ["일반고", "자율고", "특목고", "특성화고"];

  const state = {
    region: "경기도", types: new Set(), fonds: new Set(), q: "",
    metric: "rate", school: null, schoolSort: { k: "t", asc: false }, citySort: { k: "name", asc: true }, schoolLimit: 60
  };
  let ROWS = [], YEARS = [], L = 0, SHOWN = [], CITIES = [], MAP = null, STAMP = "";
  const charts = {};

  /* ───────── 데이터 읽기 ───────── */

  function parseCSV(text) {
    const out = []; let row = [], cur = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cur); out.push(row); row = []; cur = "";
      } else cur += c;
    }
    if (cur !== "" || row.length) { row.push(cur); out.push(row); }
    return out.filter(r => r.some(v => v !== ""));
  }

  function toRows(table) {
    const h = table[0].map(s => s.trim());
    const ix = name => h.indexOf(name);
    const need = ["공시연도", "시군", "학교코드", "학교명", "총계"];
    if (need.some(n => ix(n) < 0)) throw new Error("DB 시트 머리글을 찾을 수 없습니다.");
    const si = ix("수집시각");
    if (si >= 0 && table[1]) STAMP = table[1][si] || "";
    const num = (r, n) => { const i = ix(n); return i < 0 ? 0 : Number(String(r[i] || "0").replace(/,/g, "")) || 0; };
    const str = (r, n) => { const i = ix(n); return i < 0 ? "" : String(r[i] || "").trim(); };
    return table.slice(1).map(r => {
      const yr = parseInt(str(r, "공시연도"), 10);
      if (!yr || !str(r, "학교코드")) return null;
      const typeFull = str(r, "학교유형");
      return {
        yr, city: str(r, "시군"), addr: str(r, "주소"), code: str(r, "학교코드"), name: str(r, "학교명"),
        type: TYPE_SHORT[typeFull] || typeFull || "기타", fond: str(r, "설립") || "기타", day: str(r, "주야"),
        g1: num(r, "1학년_남") + num(r, "1학년_여"),
        g2: num(r, "2학년_남") + num(r, "2학년_여"),
        g3: num(r, "3학년_남") + num(r, "3학년_여"),
        gm: [num(r, "1학년_남"), num(r, "2학년_남"), num(r, "3학년_남")],
        gw: [num(r, "1학년_여"), num(r, "2학년_여"), num(r, "3학년_여")],
        etc: num(r, "기타_남") + num(r, "기타_여"),
        m: num(r, "남_계"), w: num(r, "여_계"), t: num(r, "총계")
      };
    }).filter(Boolean);
  }

  async function fetchText(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    return res.text();
  }

  async function loadData() {
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${CFG.SHEET_ID}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(CFG.SHEET_NAME)}`;
    try {
      const rows = toRows(parseCSV(await fetchText(sheetUrl)));
      if (rows.length) return { rows, from: "sheet" };
    } catch (e) { console.warn("시트 읽기 실패, 예비 자료 사용:", e); }
    const rows = toRows(parseCSV(await fetchText(CFG.FALLBACK_CSV)));
    return { rows, from: "fallback" };
  }

  /* ───────── 집계 ───────── */

  const inFilter = r => (!state.types.size || state.types.has(r.type)) && (!state.fonds.size || state.fonds.has(r.fond));
  const inRegion = r => state.region === "경기도" || r.city === state.region;

  function agg(list) {
    const a = { n: 0, t: 0, m: 0, w: 0, g1: 0, g2: 0, g3: 0 };
    list.forEach(r => { a.n++; a.t += r.t; a.m += r.m; a.w += r.w; a.g1 += r.g1; a.g2 += r.g2; a.g3 += r.g3; });
    return a;
  }
  function byYear(list) {
    const m = {}; YEARS.forEach(y => m[y] = agg(list.filter(r => r.yr === y))); return m;
  }
  function cityStats(city) {
    const list = ROWS.filter(r => r.city === city && inFilter(r));
    const y = byYear(list), cur = y[L], prev = y[L - 1] || agg([]), prev2 = y[L - 2] || agg([]);
    return {
      name: city, y, n: cur.n, t: cur.t,
      rate: prev.t ? (cur.t - prev.t) / prev.t : null,
      ret12: ratio(cur.g2, prev.g1), ret23: ratio(cur.g3, prev.g2),
      g1: cur.g1, g1rate: prev.g1 ? (cur.g1 - prev.g1) / prev.g1 : null
    };
  }

  /* ───────── 색 ───────── */

  const hex2rgb = h => { h = h.replace("#", ""); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
  const mix = (a, b, t) => { const A = hex2rgb(a), B = hex2rgb(b); return "rgb(" + A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(",") + ")"; };
  const SEQ = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
  function seqColor(t) {
    t = Math.max(0, Math.min(1, t)); const p = t * (SEQ.length - 1), i = Math.min(Math.floor(p), SEQ.length - 2);
    return mix(SEQ[i], SEQ[i + 1], p - i);
  }
  function divColor(v, M) {           // v<0 → 파랑, v>0 → 빨강, 0 → 회색
    if (v == null || !isFinite(v)) return css("--grid");
    const t = Math.max(-1, Math.min(1, v / M));
    return t >= 0 ? mix(css("--mid"), css("--up"), t) : mix(css("--mid"), css("--down"), -t);
  }

  function metricInfo(stats) {
    const m = state.metric;
    if (m === "total") {
      const max = Math.max(...stats.map(s => s.t), 1);
      return { label: `${L}년 학생수`, value: s => s.t, text: s => fmt(s.t) + "명",
               color: s => seqColor(Math.sqrt(s.t / max)), legend: [`0`, fmt(max) + "명"], seq: true };
    }
    if (m === "ret12") {
      const vals = stats.map(s => s.ret12).filter(v => v != null).map(v => Math.abs(v - 1));
      const M = Math.max(0.01, ...vals);
      return { label: `1→2학년 유지율 (${L - 1}년 1학년 → ${L}년 2학년)`, value: s => s.ret12, text: s => pctPlain(s.ret12),
               color: s => divColor(s.ret12 == null ? null : s.ret12 - 1, M), legend: [pctPlain(1 - M), "100%", pctPlain(1 + M)], center: 1 };
    }
    const vals = stats.map(s => s.rate).filter(v => v != null).map(Math.abs);
    const M = Math.max(0.01, ...vals);
    return { label: `전년비 증감률 (${L - 1}→${L})`, value: s => s.rate, text: s => pct(s.rate),
             color: s => divColor(s.rate, M), legend: [pct(-M), "0%", pct(M)], center: 0 };
  }

  /* ───────── Chart.js 공통 ───────── */

  function chartDefaults() {
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.font.size = 12;
    Chart.defaults.color = css("--ink-2");
    Chart.defaults.borderColor = css("--grid");
    Chart.defaults.plugins.legend.labels.boxWidth = 10;
    Chart.defaults.plugins.legend.labels.boxHeight = 10;
    Chart.defaults.plugins.legend.labels.useBorderRadius = true;
    Chart.defaults.plugins.legend.labels.borderRadius = 3;
    Chart.defaults.plugins.tooltip.backgroundColor = css("--ink");
    Chart.defaults.plugins.tooltip.titleColor = css("--card");
    Chart.defaults.plugins.tooltip.bodyColor = css("--card");
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.plugins.tooltip.cornerRadius = 8;
    Chart.defaults.maintainAspectRatio = false;
  }
  function draw(id, cfg) {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(document.getElementById(id), cfg);
  }
  const yAxis = (extra = {}) => ({ beginAtZero: true, grid: { color: css("--grid") }, border: { display: false },
                                   ticks: { callback: v => fmt(v) }, ...extra });

  /* ───────── 렌더 ───────── */

  function scopeLabel() {
    const parts = [state.region === "경기도" ? "경기도 전체" : state.region];
    if (state.types.size) parts.push([...state.types].join("·"));
    if (state.fonds.size) parts.push([...state.fonds].join("·"));
    return parts.join(" · ");
  }

  function renderKPIs(list) {
    const y = byYear(list), cur = y[L], prev = y[L - 1] || agg([]);
    const d = (a, b) => b ? (a - b) / b : null;
    const delta = r => r == null ? "" : `<span class="${r > 0 ? "up" : r < 0 ? "down" : ""}">${r > 0 ? "▲" : r < 0 ? "▼" : "–"} ${pct(r).replace(/^[+-]/, "")}</span>`;
    const ret = ratio(cur.g2, prev.g1);
    const kpi = (k, v, unit, dd) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}<small>${unit}</small></div><div class="d">${dd}</div></div>`;
    $("#kpis").innerHTML =
      kpi(`${L}년 학생수`, fmt(cur.t), "명", `${delta(d(cur.t, prev.t))} 전년 ${fmt(prev.t)}명`) +
      kpi(`${L}년 학교수`, fmt(cur.n), "교", `전년 ${fmt(prev.n)}교`) +
      kpi(`${L}년 1학년`, fmt(cur.g1), "명", `${delta(d(cur.g1, prev.g1))} 전년 1학년 ${fmt(prev.g1)}명`) +
      kpi(`1→2학년 유지율`, pctPlain(ret), "", `${L - 1}년 1학년 ${fmt(prev.g1)} → ${L}년 2학년 ${fmt(cur.g2)}`);
  }

  function renderTrend(list) {
    const y = byYear(list), xs = SHOWN.slice().reverse();
    $("#trend-scope").textContent = scopeLabel();
    const ds = (label, key, color) => ({ label, data: xs.map(yr => y[yr][key]), backgroundColor: color,
      borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "bottom", maxBarThickness: 34, categoryPercentage: 0.72, barPercentage: 0.92 });
    draw("c-trend", {
      type: "bar",
      data: { labels: xs.map(v => v + "년"), datasets: [ds("1학년", "g1", css("--s1")), ds("2학년", "g2", css("--s2")), ds("3학년", "g3", css("--s3"))] },
      options: {
        plugins: {
          legend: { position: "top", align: "start" },
          tooltip: { mode: "index", intersect: false,
            callbacks: { label: c => ` ${c.dataset.label}: ${fmt(c.raw)}명`,
                         footer: items => `합계(1~3학년): ${fmt(items.reduce((s, i) => s + i.raw, 0))}명` } }
        },
        scales: { x: { grid: { display: false }, border: { color: css("--axis") } }, y: yAxis() }
      }
    });
  }

  function renderCohort(list) {
    const y = byYear(list);
    $("#cohort-scope").textContent = scopeLabel();
    const entries = YEARS.slice().sort((a, b) => a - b).slice(-4);
    const colors = [css("--s1"), css("--s2"), css("--s3"), css("--s4")];
    const datasets = entries.map((e, i) => ({
      label: `${e}년 입학`,
      data: [y[e] ? y[e].g1 : null, y[e + 1] ? y[e + 1].g2 : null, y[e + 2] ? y[e + 2].g3 : null].map(v => v || null),
      borderColor: colors[i], backgroundColor: colors[i], borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, tension: 0, spanGaps: false
    }));
    draw("c-cohort", {
      type: "line",
      data: { labels: ["1학년", "2학년", "3학년"], datasets },
      options: {
        interaction: { mode: "nearest", intersect: false },
        plugins: {
          legend: { position: "top", align: "start" },
          tooltip: { callbacks: {
            title: items => items[0].dataset.label + " · " + items[0].label,
            label: c => {
              const prev = c.dataIndex > 0 ? c.dataset.data[c.dataIndex - 1] : null;
              return ` ${fmt(c.raw)}명` + (prev ? `  (직전 학년 대비 ${pct(c.raw / prev - 1)})` : "");
            } } }
        },
        scales: { x: { grid: { display: false }, border: { color: css("--axis") } }, y: yAxis({ beginAtZero: false, grace: "8%" }) }
      }
    });
  }

  function renderMap() {
    const svg = $("#map");
    const stats = CITIES.map(cityStats);
    const info = metricInfo(stats);
    const byName = Object.fromEntries(stats.map(s => [s.name, s]));
    mapCache = { info, byName };
    if (!svg.dataset.ready) {
      svg.setAttribute("viewBox", MAP.viewBox);
      svg.innerHTML = Object.entries(MAP.cities).map(([n, c]) =>
        `<path data-city="${esc(n)}" d="${c.d}"><title>${esc(n)}</title></path>`).join("") +
        Object.entries(MAP.cities).map(([n, c]) =>
        `<text x="${c.x}" y="${c.y}" text-anchor="middle" dominant-baseline="middle">${esc(n.replace(/(시|군)$/, ""))}</text>`).join("");
      svg.querySelectorAll("path").forEach(p => {
        p.addEventListener("click", () => setRegion(state.region === p.dataset.city ? "경기도" : p.dataset.city));
        p.addEventListener("mousemove", e => {
          const s = mapCache.byName[p.dataset.city], info = mapCache.info; if (!s || !info) return;
          showTip(e, `<b>${esc(s.name)}</b><br>${esc(info.label)}: ${info.text(s)}<br>학생수 ${fmt(s.t)}명 · ${fmt(s.n)}교`);
        });
        p.addEventListener("mouseleave", hideTip);
      });
      svg.dataset.ready = "1";
    }
    svg.querySelectorAll("path").forEach(p => {
      const s = byName[p.dataset.city];
      p.setAttribute("fill", s ? info.color(s) : css("--grid"));
      p.classList.toggle("sel", p.dataset.city === state.region);
      p.querySelector("title").textContent = s ? `${s.name} ${info.text(s)}` : p.dataset.city;
    });
    svg.classList.toggle("has-sel", state.region !== "경기도");
    const lg = $("#map-legend");
    const grad = info.seq ? `linear-gradient(90deg, ${SEQ.join(",")})`
      : `linear-gradient(90deg, ${css("--down")}, ${css("--mid")}, ${css("--up")})`;
    lg.innerHTML = `<span>${info.legend[0]}</span><span class="bar" style="background:${grad}"></span>` +
      (info.legend.length === 3 ? `<span>${info.legend[2]}</span><span>(가운데 ${info.legend[1]})</span>` : `<span>${info.legend[1]}</span>`) +
      `<span>· ${esc(info.label)}</span>`;
  }
  let mapCache = { info: null, byName: {} };

  function renderRank() {
    const stats = CITIES.map(cityStats);
    const info = metricInfo(stats);
    const sorted = stats.filter(s => info.value(s) != null).sort((a, b) => info.value(b) - info.value(a));
    $("#rank-sub").textContent = info.label + " · 막대를 누르면 지역 선택";
    $("#rank-scope").textContent = [state.types.size ? [...state.types].join("·") : "", state.fonds.size ? [...state.fonds].join("·") : ""].filter(Boolean).join(" · ");
    const center = info.center ?? 0;
    const vals = sorted.map(s => info.seq ? info.value(s) : (info.value(s) - center) * 100);
    const colors = sorted.map(s => {
      let c = info.seq ? css("--s1") : (info.value(s) - center >= 0 ? css("--up") : css("--down"));
      if (state.region !== "경기도" && s.name !== state.region) c = mix(c.startsWith("#") ? c : "#888888", css("--card"), 0.6);
      return c;
    });
    draw("c-rank", {
      type: "bar",
      data: { labels: sorted.map(s => s.name), datasets: [{ data: vals, backgroundColor: colors, borderRadius: 4, borderSkipped: false, maxBarThickness: 14 }] },
      options: {
        indexAxis: "y",
        onClick: (e, els) => { if (els.length) { const n = sorted[els[0].index].name; setRegion(state.region === n ? "경기도" : n); } },
        onHover: (e, els) => { e.native.target.style.cursor = els.length ? "pointer" : "default"; },
        plugins: { legend: { display: false },
          tooltip: { callbacks: { label: c => ` ${info.text(sorted[c.dataIndex])} · 학생수 ${fmt(sorted[c.dataIndex].t)}명` } } },
        scales: {
          y: { grid: { display: false }, border: { color: css("--axis") }, ticks: { autoSkip: false, font: { size: 11.5 } } },
          x: { grid: { color: css("--grid") }, border: { display: false },
               ticks: { callback: v => info.seq ? fmt(v) : (center === 1 ? (100 + v).toFixed(0) + "%" : v.toFixed(1) + "%") } }
        }
      }
    });
  }

  function schoolList() {
    const q = state.q.trim();
    const latest = ROWS.filter(r => r.yr === L && inFilter(r) && inRegion(r) && (!q || r.name.includes(q)));
    const prevBy = Object.fromEntries(ROWS.filter(r => r.yr === L - 1).map(r => [r.code, r]));
    return latest.map(r => {
      const p = prevBy[r.code];
      return { ...r, rate: p && p.t ? (r.t - p.t) / p.t : null, ret12: p ? ratio(r.g2, p.g1) : null };
    });
  }

  function sortBy(list, { k, asc }) {
    return list.sort((a, b) => {
      const x = a[k], y = b[k];
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
      const c = typeof x === "string" ? x.localeCompare(y, "ko") : x - y;
      return asc ? c : -c;
    });
  }

  function renderSchools() {
    const list = sortBy(schoolList(), state.schoolSort);
    $("#school-sub").textContent = `${scopeLabel()} · ${L}년 공시 ${fmt(list.length)}개교 · 학교를 누르면 상세 추이`;
    const cls = r => r == null ? "" : r > 0 ? "up" : r < 0 ? "down" : "";
    $("#t-school tbody").innerHTML = list.slice(0, state.schoolLimit).map(r => `
      <tr data-code="${esc(r.code)}" class="${r.code === state.school ? "sel" : ""}">
        <td>${esc(r.name)}</td><td>${esc(r.city)}</td><td><span class="tag">${esc(r.type)}</span></td><td>${esc(r.fond)}</td>
        <td class="num">${fmt(r.t)}</td><td class="num ${cls(r.rate)}">${pct(r.rate)}</td>
        <td class="num">${fmt(r.g1)}</td><td class="num">${fmt(r.g2)}</td><td class="num">${fmt(r.g3)}</td>
        <td class="num">${pctPlain(r.ret12)}</td>
      </tr>`).join("") || `<tr><td colspan="10">조건에 맞는 학교가 없습니다.</td></tr>`;
    $("#school-more").innerHTML = list.length > state.schoolLimit
      ? `${fmt(list.length - state.schoolLimit)}개교 더 있음 · <button type="button" class="reset" id="more">모두 보기</button>` : "";
    const more = $("#more"); if (more) more.onclick = () => { state.schoolLimit = 1e9; renderSchools(); };
    markSorted("#t-school", state.schoolSort);
  }

  function renderDetail() {
    const box = $("#detail");
    if (!state.school) { box.hidden = true; return; }
    const rows = ROWS.filter(r => r.code === state.school).sort((a, b) => a.yr - b.yr);
    if (!rows.length) { box.hidden = true; return; }
    const last = rows[rows.length - 1];
    box.hidden = false;
    $("#d-title").textContent = last.name;
    $("#d-sub").textContent = `${last.addr || last.city} · ${last.type} · ${last.fond}${last.day ? " · " + last.day : ""}`;
    const xs = rows.filter(r => SHOWN.includes(r.yr));
    const ds = (label, k, color) => ({ label, data: xs.map(r => r[k]), backgroundColor: color,
      borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "bottom", maxBarThickness: 30, categoryPercentage: 0.72, barPercentage: 0.92 });
    draw("c-school", {
      type: "bar",
      data: { labels: xs.map(r => r.yr + "년"), datasets: [ds("1학년", "g1", css("--s1")), ds("2학년", "g2", css("--s2")), ds("3학년", "g3", css("--s3"))] },
      options: { plugins: { legend: { position: "top", align: "start" },
                            tooltip: { mode: "index", intersect: false, callbacks: { label: c => ` ${c.dataset.label}: ${fmt(c.raw)}명` } } },
                 scales: { x: { grid: { display: false }, border: { color: css("--axis") } }, y: yAxis() } }
    });
    const by = Object.fromEntries(rows.map(r => [r.yr, r]));
    const tr = SHOWN.map(y => {
      const r = by[y], p = by[y - 1];
      if (!r) return `<tr><td>${y}년</td><td colspan="6">공시 없음</td></tr>`;
      const rate = p && p.t ? (r.t - p.t) / p.t : null;
      const cls = rate == null ? "" : rate > 0 ? "up" : rate < 0 ? "down" : "";
      const coh = (cur, prv) => prv ? `<br><small class="${cur >= prv ? "up" : "down"}">${pct(cur / prv - 1)}</small>` : "";
      return `<tr><td>${y}년</td><td class="num">${fmt(r.g1)}</td>
        <td class="num">${fmt(r.g2)}${coh(r.g2, p && p.g1)}</td><td class="num">${fmt(r.g3)}${coh(r.g3, p && p.g2)}</td>
        <td class="num">${fmt(r.etc)}</td><td class="num"><b>${fmt(r.t)}</b></td><td class="num ${cls}">${pct(rate)}</td></tr>`;
    }).join("");
    $("#t-detail").innerHTML = `<thead><tr><th>공시연도</th><th class="num">1학년</th><th class="num">2학년</th><th class="num">3학년</th><th class="num">기타</th><th class="num">총계</th><th class="num">전년비</th></tr></thead><tbody>${tr}</tbody>
      <caption style="caption-side:bottom;text-align:left;color:var(--muted);font-size:12px;padding-top:8px">2·3학년 아래 작은 수치는 전년도 한 학년 아래(같은 입학생) 대비 증감입니다. 기타는 학년 구분 밖 학생(특수학급 등)입니다.</caption>`;
  }

  function cityRows() {
    return CITIES.map(cityStats).map(s => {
      const o = { name: s.name, n: s.n, rate: s.rate, ret12: s.ret12, ret23: s.ret23, g1: s.g1 };
      SHOWN.forEach(y => o["t" + y] = s.y[y] ? s.y[y].t : 0);
      return o;
    });
  }
  function cityCols() {
    return [["name", "시·군"], ["n", `학교수(${L})`]]
      .concat(SHOWN.slice().reverse().map(y => ["t" + y, `${y}년`]))
      .concat([["rate", "전년비"], ["g1", `${L}년 1학년`], ["ret12", "1→2 유지율"], ["ret23", "2→3 유지율"]]);
  }
  function renderCityTable() {
    const rows = sortBy(cityRows(), state.citySort), cols = cityCols();
    const cell = (k, v) => k === "name" ? esc(v) : (k === "rate" ? `<span class="${v > 0 ? "up" : v < 0 ? "down" : ""}">${pct(v)}</span>` : k.startsWith("ret") ? pctPlain(v) : fmt(v));
    $("#t-city").innerHTML = `<thead><tr>${cols.map(([k, l]) => `<th data-k="${k}" class="${k === "name" ? "" : "num"}">${l}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(r => `<tr data-city="${esc(r.name)}" class="${r.name === state.region ? "sel" : ""}">${cols.map(([k]) => `<td class="${k === "name" ? "" : "num"}">${cell(k, r[k])}</td>`).join("")}</tr>`).join("")}</tbody>`;
    markSorted("#t-city", state.citySort);
  }

  function markSorted(sel, s) {
    document.querySelectorAll(sel + " th").forEach(th => {
      th.classList.toggle("sorted", th.dataset.k === s.k);
      th.classList.toggle("asc", th.dataset.k === s.k && s.asc);
    });
  }

  function renderAll() {
    const list = ROWS.filter(r => inFilter(r) && inRegion(r));
    $("#f-region").value = state.region;
    renderKPIs(list); renderTrend(list); renderCohort(list);
    renderMap(); renderRank(); renderSchools(); renderDetail(); renderCityTable();
  }

  function setRegion(r) { state.region = r; state.schoolLimit = 60; renderAll(); }

  /* ───────── 툴팁 ───────── */
  function showTip(e, html) {
    const t = $("#tip"); t.innerHTML = html; t.hidden = false;
    const w = t.offsetWidth, h = t.offsetHeight;
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + w > innerWidth - 8) x = e.clientX - w - 14;
    if (y + h > innerHeight - 8) y = e.clientY - h - 14;
    t.style.left = x + "px"; t.style.top = y + "px";
  }
  function hideTip() { $("#tip").hidden = true; }

  /* ───────── 이벤트 ───────── */

  function chipGroup(el, values, set) {
    el.insertAdjacentHTML("beforeend", values.map(v => `<button type="button" class="chip" aria-pressed="false" data-v="${esc(v)}">${esc(v)}</button>`).join(""));
    el.addEventListener("click", e => {
      const b = e.target.closest(".chip"); if (!b) return;
      const v = b.dataset.v;
      set.has(v) ? set.delete(v) : set.add(v);
      b.setAttribute("aria-pressed", set.has(v));
      renderAll();
    });
  }

  function bind() {
    const sel = $("#f-region");
    sel.insertAdjacentHTML("beforeend", CITIES.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join(""));
    sel.addEventListener("change", () => setRegion(sel.value));

    const rank = t => { const i = TYPE_ORDER.indexOf(t); return i < 0 ? 99 : i; };
    const types = [...new Set(ROWS.map(r => r.type))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    chipGroup($("#f-type"), types, state.types);
    chipGroup($("#f-fond"), [...new Set(ROWS.map(r => r.fond))].sort(), state.fonds);

    $("#f-reset").addEventListener("click", () => {
      state.types.clear(); state.fonds.clear(); state.q = ""; $("#q").value = ""; state.school = null;
      document.querySelectorAll(".chip").forEach(c => c.setAttribute("aria-pressed", "false"));
      setRegion("경기도");
    });

    $("#map-metric").addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      state.metric = b.dataset.v;
      document.querySelectorAll("#map-metric button").forEach(x => x.setAttribute("aria-checked", x === b));
      renderMap(); renderRank();
    });

    let t; $("#q").addEventListener("input", e => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value; state.schoolLimit = 60; renderSchools(); }, 150); });

    $("#t-school thead").addEventListener("click", e => {
      const k = e.target.closest("th")?.dataset.k; if (!k) return;
      state.schoolSort = { k, asc: state.schoolSort.k === k ? !state.schoolSort.asc : ["name", "city", "type", "fond"].includes(k) };
      renderSchools();
    });
    $("#t-school tbody").addEventListener("click", e => {
      const tr = e.target.closest("tr[data-code]"); if (!tr) return;
      state.school = tr.dataset.code; renderSchools(); renderDetail();
      $("#detail").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    $("#d-close").addEventListener("click", () => { state.school = null; renderSchools(); renderDetail(); });

    $("#t-city").addEventListener("click", e => {
      const th = e.target.closest("th");
      if (th) { const k = th.dataset.k; state.citySort = { k, asc: state.citySort.k === k ? !state.citySort.asc : k === "name" }; renderCityTable(); return; }
      const tr = e.target.closest("tr[data-city]"); if (tr) { setRegion(state.region === tr.dataset.city ? "경기도" : tr.dataset.city); window.scrollTo({ top: 0, behavior: "smooth" }); }
    });

    $("#dl").addEventListener("click", () => {
      const cols = cityCols(), rows = sortBy(cityRows(), state.citySort);
      const v = (k, x) => x == null ? "" : k.startsWith("ret") || k === "rate" ? (x * 100).toFixed(2) + "%" : x;
      const csv = "﻿" + [cols.map(c => c[1]).join(",")].concat(rows.map(r => cols.map(([k]) => v(k, r[k])).join(","))).join("\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      a.download = `경기도_시군별_고교학생수_${L}_${scopeLabel().replace(/[ ·]+/g, "_")}.csv`;
      a.click(); URL.revokeObjectURL(a.href);
    });

    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { chartDefaults(); renderAll(); });
  }

  /* ───────── 시작 ───────── */

  (async function init() {
    document.title = CFG.TITLE; $("#title").textContent = CFG.TITLE;
    try {
      const [{ rows, from }, map] = await Promise.all([loadData(), fetch("data/gyeonggi-map.json").then(r => r.json())]);
      ROWS = rows; MAP = map;
      YEARS = [...new Set(ROWS.map(r => r.yr))].sort((a, b) => b - a);
      L = YEARS[0]; SHOWN = YEARS.slice(0, 3);
      CITIES = Object.keys(MAP.cities).sort((a, b) => a.localeCompare(b, "ko"));
      const extra = [...new Set(ROWS.map(r => r.city))].filter(c => !CITIES.includes(c));
      CITIES = CITIES.concat(extra);

      const total = agg(ROWS.filter(r => r.yr === L));
      $("#lede").textContent = `${SHOWN[SHOWN.length - 1]}~${L}학년도 공시 기준, 경기도 31개 시·군 고등학교 ${fmt(total.n)}개교 학생 ${fmt(total.t)}명의 학년별 추이입니다.`;
      $("#source").textContent = `자료: ${CFG.SOURCE}` + (STAMP ? ` · 수집 ${STAMP}` : "") + (from === "fallback" ? " · 예비 자료 표시 중" : "");
      chartDefaults(); bind(); renderAll();
    } catch (e) {
      console.error(e);
      $("#lede").innerHTML = `<span class="err">자료를 불러오지 못했습니다. 스프레드시트의 공유 설정이 '링크가 있는 모든 사용자: 뷰어'인지, DB 시트가 있는지 확인해 주세요. (${esc(e.message)})</span>`;
    }
  })();
})();
