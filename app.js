/* 경기도 고등학교 학년별 학생수 대시보드
 * 데이터: Google 스프레드시트 'DB' 시트 (Apps Script가 학교알리미 API에서 수집)
 */
(() => {
  "use strict";
  const CFG = window.APP_CONFIG;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const fmt = n => (n == null || !isFinite(n)) ? "–" : Math.round(n).toLocaleString("ko-KR");
  const trim0 = s => s.replace(/\.0$/, "");
  const compact = n => n >= 10000 ? trim0((n / 10000).toFixed(1)) + "만" : n >= 1000 ? trim0((n / 1000).toFixed(1)) + "천" : fmt(n);
  const pct = (r, d = 1) => (r == null || !isFinite(r)) ? "–" : (r > 0 ? "+" : r < 0 ? "−" : "") + Math.abs(r * 100).toFixed(d) + "%";
  const pctPlain = (r, d = 1) => (r == null || !isFinite(r)) ? "–" : (r * 100).toFixed(d) + "%";
  const ratio = (a, b) => (b > 0 ? a / b : null);
  const cls = r => r == null || !isFinite(r) || r === 0 ? "" : r > 0 ? "up" : "down";
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const TYPE_SHORT = { "일반고등학교": "일반고", "특수목적고등학교": "특목고", "특성화고등학교": "특성화고", "자율고등학교": "자율고" };
  const TYPE_ORDER = ["일반고", "자율고", "특목고", "특성화고"];
  const PAGE = 50;

  const state = {
    region: "경기도", types: new Set(), fonds: new Set(), q: "",
    metric: "rate", school: null,
    schoolSort: { k: "t", asc: false }, citySort: { k: "rate", asc: false }, schoolLimit: PAGE
  };
  let ROWS = [], YEARS = [], L = 0, SHOWN = [], CITIES = [], MAP = null, STAMP = "", FROM = "";
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
    if (["공시연도", "시군", "학교코드", "학교명", "총계"].some(n => ix(n) < 0)) throw new Error("DB 시트 머리글을 찾을 수 없습니다.");
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
        etc: num(r, "기타_남") + num(r, "기타_여"),
        m: num(r, "남_계"), w: num(r, "여_계"), t: num(r, "총계"),
        manual: str(r, "자료출처").includes("수동")
      };
    }).filter(Boolean);
  }

  async function fetchText(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.text();
  }

  // 기본: 저장소의 data/db.json (공시는 1년에 한 번이라 매번 시트를 읽지 않음)
  // 주소 끝에 ?live=1 을 붙이면 스프레드시트를 직접 읽어 게시 전 상태를 미리 볼 수 있음
  const LIVE = new URLSearchParams(location.search).has("live");
  async function loadData() {
    if (LIVE) {
      const sheetUrl = `https://docs.google.com/spreadsheets/d/${CFG.SHEET_ID}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(CFG.SHEET_NAME)}`;
      return { rows: toRows(parseCSV(await fetchText(sheetUrl))), from: "sheet" };
    }
    const res = await fetch(CFG.DATA_JSON, { cache: "no-cache" });   // 바뀌었을 때만 새로 받음(ETag 확인)
    if (!res.ok) throw new Error("자료 파일을 읽지 못했습니다 (HTTP " + res.status + ")");
    const d = await res.json();
    STAMP = d.meta?.collected || "";
    return { rows: toRows([d.columns].concat(d.rows.map(r => r.map(v => String(v))))), from: "json" };
  }

  /* ───────── 집계 ───────── */

  const inFilter = r => (!state.types.size || state.types.has(r.type)) && (!state.fonds.size || state.fonds.has(r.fond));
  const inRegion = r => state.region === "경기도" || r.city === state.region;
  const isDefault = () => state.region === "경기도" && !state.types.size && !state.fonds.size;

  function agg(list) {
    const a = { n: 0, t: 0, m: 0, w: 0, g1: 0, g2: 0, g3: 0 };
    list.forEach(r => { a.n++; a.t += r.t; a.m += r.m; a.w += r.w; a.g1 += r.g1; a.g2 += r.g2; a.g3 += r.g3; });
    return a;
  }
  function byYear(list) { const m = {}; YEARS.forEach(y => m[y] = agg(list.filter(r => r.yr === y))); return m; }
  const EMPTY = { n: 0, t: 0, m: 0, w: 0, g1: 0, g2: 0, g3: 0 };

  function cityStats(city) {
    const y = byYear(ROWS.filter(r => r.city === city && inFilter(r)));
    const cur = y[L], prev = y[L - 1] || EMPTY;
    return { name: city, y, n: cur.n, t: cur.t, g1: cur.g1,
             rate: prev.t ? cur.t / prev.t - 1 : null, ret12: ratio(cur.g2, prev.g1), ret23: ratio(cur.g3, prev.g2) };
  }

  /* ───────── 색 ───────── */

  const hex2rgb = h => { h = h.replace("#", ""); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
  const mix = (a, b, t) => { if (!a.startsWith("#")) a = rgb2hex(a); const A = hex2rgb(a), B = hex2rgb(b); return "rgb(" + A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(",") + ")"; };
  const rgb2hex = c => "#" + c.match(/\d+/g).slice(0, 3).map(n => (+n).toString(16).padStart(2, "0")).join("");
  const SEQ = ["#d9e8fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
  function seqColor(t) {
    t = Math.max(0, Math.min(1, t)); const p = t * (SEQ.length - 1), i = Math.min(Math.floor(p), SEQ.length - 2);
    return mix(SEQ[i], SEQ[i + 1], p - i);
  }
  function divColor(v, M) {
    if (v == null || !isFinite(v)) return css("--ctx");
    const t = Math.max(-1, Math.min(1, v / M));
    return t >= 0 ? mix(css("--mid"), css("--up-fill"), t) : mix(css("--mid"), css("--down-fill"), -t);
  }

  const METRIC_HELP = {
    rate: () => `${L - 1}년 대비 ${L}년 학생수가 늘었는지(빨강) 줄었는지(파랑) 비교합니다.`,
    total: () => `${L}년 공시 학생수입니다. 색이 진할수록 학생이 많습니다.`,
    ret12: () => `${L - 1}년 1학년이 ${L}년 2학년이 되면서 얼마나 남았는지입니다. 높을수록 막대가 길고 색이 진합니다. 순위의 점선이 100%(감소 없음)입니다.`
  };

  // 지표별 지도 색, 순위 막대(값·축 범위·눈금) 정의
  function metricInfo(stats) {
    const m = state.metric;
    if (m === "total") {
      const max = Math.max(...stats.map(s => s.t), 1);
      return { key: "total", label: `${L}년 학생수`, value: s => s.t, text: s => fmt(s.t) + "명", short: s => compact(s.t),
               color: s => seqColor(Math.sqrt(s.t / max)), legend: ["적음", "많음"], seq: true,
               bar: { val: s => s.t, min: 0, max: max * 1.15, tick: v => compact(v), color: () => css("--s1") } };
    }
    if (m === "ret12") {
      // 유지율은 높을수록 좋은 값 → 왼쪽 끝(최저치 아래)에서 오른쪽으로 채우는 막대, 진할수록 높음
      const vs = stats.map(s => s.ret12).filter(v => v != null).map(v => v * 100);
      const lo = Math.floor((Math.min(...vs) - 0.5) / 5) * 5, hi = Math.max(100.5, Math.ceil(Math.max(...vs) + 0.5));   // 시작점은 5% 단위로 내림
      const shade = s => s.ret12 == null ? css("--ctx") : seqColor(0.18 + 0.82 * Math.max(0, Math.min(1, (s.ret12 * 100 - lo) / (hi - lo))));
      return { key: "ret12", label: `1→2학년 유지율 (${L - 1}년 1학년 → ${L}년 2학년)`, value: s => s.ret12,
               text: s => pctPlain(s.ret12), short: s => pctPlain(s.ret12, 1),
               color: shade, legend: [pctPlain(lo / 100, 0), pctPlain(hi / 100, 0)], seq: true,
               bar: { val: s => s.ret12 * 100, min: lo, max: hi, tick: v => (Math.abs(v % 5) < 1e-9 ? v.toFixed(0) + "%" : ""), color: shade, ref: 100 } };
    }
    const M = Math.max(0.01, ...stats.map(s => s.rate).filter(v => v != null).map(Math.abs));
    const rv = stats.map(s => s.rate).filter(v => v != null).map(v => v * 100);
    return { key: "rate", label: `전년 대비 증감률 (${L - 1}→${L}년)`, value: s => s.rate, text: s => pct(s.rate), short: s => pct(s.rate),
             color: s => divColor(s.rate, M), legend: [pct(-M, 0), "0%", pct(M, 0)], center: 0,
             bar: { val: s => s.rate * 100, min: Math.min(0, ...rv), max: Math.max(0, ...rv), diverging: true, tick: v => v.toFixed(0) + "%",
                    color: s => s.rate >= 0 ? css("--up-fill") : css("--down-fill") } };
  }

  /* ───────── Chart.js 공통 ───────── */

  function chartDefaults() {
    if (window.ChartDataLabels) Chart.register(window.ChartDataLabels);
    // 범례가 정리된(detach·destroy) 차트로 늦게 들어온 이벤트는 Chart.js 범례 플러그인이 handleEvent 오류를 내므로 버림
    if (!Chart.registry.plugins.get("safeEvent")) Chart.register({ id: "safeEvent", beforeEvent: c => (c.legend ? undefined : false) });
    const D = Chart.defaults;
    D.font.family = getComputedStyle(document.body).fontFamily;
    D.font.size = 12.5;
    D.color = css("--ink-2");
    D.borderColor = css("--grid");
    D.maintainAspectRatio = false;
    // 애니메이션은 requestAnimationFrame에 의존해 백그라운드 탭·임베드 화면에서는 첫 프레임이 그려지지 않아 빈 그래프가 되므로 끔
    D.animation = false;
    Object.assign(D.plugins.legend.labels, { boxWidth: 12, boxHeight: 12, useBorderRadius: true, borderRadius: 3, padding: 14, color: css("--ink"), font: { size: 13, weight: "600" } });
    Object.assign(D.plugins.tooltip, { backgroundColor: css("--ink"), titleColor: css("--card"), bodyColor: css("--card"), footerColor: css("--card"),
                                       padding: 10, cornerRadius: 8, titleFont: { weight: "700", size: 13 }, bodyFont: { size: 12.5 } });
    if (D.plugins.datalabels) D.plugins.datalabels.display = false;
  }
  function draw(id, cfg) {
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
    // 같은 canvas를 다시 쓰면 일부 브라우저에서 이전 크기 상태가 남아 빈 그래프가 되므로 매번 새 canvas로 교체
    const old = document.getElementById(id);
    const fresh = old.cloneNode(false);
    fresh.removeAttribute("width"); fresh.removeAttribute("height"); fresh.removeAttribute("style");
    old.replaceWith(fresh);
    charts[id] = new Chart(fresh, cfg);
    requestAnimationFrame(() => { const c = charts[id]; if (c && c.canvas === fresh) c.resize(); });
  }
  const narrow = (id, px = 520) => (document.getElementById(id)?.parentElement.clientWidth || 999) < px;
  const BAR_LABEL_PX = 720;   // 막대 9개에 가로 숫자가 겹치지 않는 최소 폭
  const yAxis = (extra = {}) => ({ beginAtZero: true, grace: "12%", grid: { color: css("--grid") }, border: { display: false },
                                   ticks: { callback: v => compact(v), maxTicksLimit: 6 }, ...extra });
  const xAxis = () => ({ grid: { display: false }, border: { color: css("--axis") }, ticks: { color: css("--ink"), font: { size: 13, weight: "600" } } });
  // 막대 위 값: 좁은 화면에서는 세로로 세워 전체 숫자를 그대로 보여줌 (반올림하면 학년 간 차이가 사라짐)
  const valueLabels = (small) => ({
    display: true, anchor: "end", align: "end", offset: 3, clamp: true,
    rotation: small ? -90 : 0,
    color: css("--ink-2"), font: { size: small ? 10.5 : 11.5, weight: "600" },
    formatter: v => v == null ? "" : fmt(v)
  });

  /* ───────── 렌더: 범위·KPI ───────── */

  function scopeParts() {
    const p = [state.region === "경기도" ? "경기도 전체" : state.region];
    p.push(state.types.size ? [...state.types].join("·") : "모든 유형");
    if (state.fonds.size) p.push([...state.fonds].join("·"));
    return p;
  }
  const scopeLabel = () => scopeParts().join(" · ");

  function renderScope(list) {
    const cur = agg(list.filter(r => r.yr === L));
    $("#scope").innerHTML = `보는 범위: ${scopeParts().map(p => `<b>${esc(p)}</b>`).join(" ")} — ${L}년 ${fmt(cur.n)}개교 ${fmt(cur.t)}명`;
    $("#f-reset").hidden = isDefault();
  }

  function renderKPIs(list) {
    const y = byYear(list), cur = y[L], prev = y[L - 1] || EMPTY;
    const chg = (a, b) => {
      if (!b) return "";
      const r = a / b - 1;
      return `<span class="chg ${cls(r)}">${r > 0 ? "▲" : r < 0 ? "▼" : "–"} ${pct(r).replace(/^[+−]/, "")}</span>`;
    };
    const ret = ratio(cur.g2, prev.g1);
    const kpi = (k, v, unit, d, x) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}<small>${unit}</small></div><div class="d">${d}</div>${x ? `<div class="x">${x}</div>` : ""}</div>`;
    $("#kpis").innerHTML =
      kpi(`${L}년 전체 학생수`, fmt(cur.t), "명", `${chg(cur.t, prev.t)}${L - 1}년 ${fmt(prev.t)}명`, `남 ${fmt(cur.m)} · 여 ${fmt(cur.w)}`) +
      kpi(`${L}년 학교수`, fmt(cur.n), "개교", `${L - 1}년 ${fmt(prev.n)}개교`, cur.n ? `학교당 평균 ${fmt(cur.t / cur.n)}명` : "") +
      kpi(`${L}년 1학년(신입생)`, fmt(cur.g1), "명", `${chg(cur.g1, prev.g1)}${L - 1}년 1학년 ${fmt(prev.g1)}명`, `앞으로 고교 학생수의 선행 지표`) +
      kpi(`1→2학년 유지율`, pctPlain(ret), "", `${L - 1}년 1학년 ${fmt(prev.g1)} → ${L}년 2학년 ${fmt(cur.g2)}`, `100% 미만이면 1년 새 학생 감소`);
  }

  /* ───────── 렌더: 차트 ───────── */

  function renderTrend(list) {
    const y = byYear(list), xs = SHOWN.slice().reverse(), small = narrow("c-trend", BAR_LABEL_PX);
    const ds = (label, key, color) => ({ label, data: xs.map(yr => y[yr][key]), backgroundColor: color,
      borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "bottom", maxBarThickness: 40, categoryPercentage: 0.78, barPercentage: 0.9 });
    draw("c-trend", {
      type: "bar",
      data: { labels: xs.map(v => v + "년"), datasets: [ds("1학년", "g1", css("--s1")), ds("2학년", "g2", css("--s2")), ds("3학년", "g3", css("--s3"))] },
      options: {
        layout: { padding: { top: 6 } },
        plugins: {
          legend: { position: "top", align: "start" },
          datalabels: valueLabels(small),
          tooltip: { mode: "index", intersect: false,
            callbacks: { label: c => ` ${c.dataset.label}: ${fmt(c.raw)}명`,
                         footer: items => `1~3학년 합계: ${fmt(items.reduce((s, i) => s + i.raw, 0))}명` } }
        },
        scales: { x: xAxis(), y: yAxis(small ? { grace: "48%" } : {}) }
      }
    });
  }

  function renderCohort(list) {
    const y = byYear(list), small = narrow("c-cohort");
    const entries = YEARS.slice().sort((a, b) => a - b);
    const colors = [css("--s1"), css("--s2"), css("--s3"), css("--s4")];
    const datasets = entries.map((e, i) => ({
      label: `${e}년 입학`,
      data: [y[e]?.g1, y[e + 1]?.g2, y[e + 2]?.g3].map(v => v || null),
      borderColor: colors[i], backgroundColor: colors[i], borderWidth: 2.5, pointRadius: 5, pointHoverRadius: 7,
      pointBorderColor: css("--card"), pointBorderWidth: 2, tension: 0
    }));
    draw("c-cohort", {
      type: "line",
      data: { labels: ["1학년", "2학년", "3학년"], datasets },
      options: {
        layout: { padding: { top: 8, left: 8, right: 16 } },
        interaction: { mode: "nearest", intersect: false },
        plugins: {
          legend: { position: "top", align: "start" },
          datalabels: {
            display: ctx => ctx.dataset.data[ctx.dataIndex] != null ? "auto" : false,
            align: ctx => ctx.datasetIndex % 2 ? "bottom" : "top", offset: 6,
            color: css("--ink-2"), font: { size: small ? 10.5 : 11.5, weight: "600" }, textAlign: "center",
            formatter: (v, ctx) => {
              if (v == null) return "";
              const p = ctx.dataIndex > 0 ? ctx.dataset.data[ctx.dataIndex - 1] : null;
              const head = fmt(v);
              return p ? [head, `(${pct(v / p - 1)})`] : head;
            }
          },
          tooltip: { callbacks: {
            title: items => items[0].dataset.label + " · " + items[0].label,
            label: c => {
              const prev = c.dataIndex > 0 ? c.dataset.data[c.dataIndex - 1] : null;
              return ` ${fmt(c.raw)}명` + (prev ? `  (직전 학년 대비 ${pct(c.raw / prev - 1)})` : "");
            } } }
        },
        scales: { x: { ...xAxis(), offset: true }, y: yAxis({ beginAtZero: false, grace: "18%" }) }
      }
    });
  }

  /* ───────── 렌더: 지도·순위 ───────── */

  let mapCache = { info: null, byName: {} };

  function buildMap() {
    const svg = $("#map");
    svg.setAttribute("viewBox", MAP.viewBox);
    const ctx = Object.entries(MAP.context || {});
    svg.innerHTML =
      ctx.map(([n, c]) => `<path class="ctx" d="${c.d}"/>`).join("") +
      Object.entries(MAP.cities).map(([n, c]) => `<path class="city" data-city="${esc(n)}" d="${c.d}" tabindex="0" role="button" aria-label="${esc(n)}"></path>`).join("") +
      ctx.map(([n, c]) => `<text class="ctx-l" x="${c.x}" y="${c.y}" text-anchor="middle" dominant-baseline="middle">${esc(n)}</text>`).join("") +
      Object.entries(MAP.cities).map(([n, c]) =>
        `<text class="lab${c.a < 2600 ? " small" : ""}" data-city="${esc(n)}" x="${c.x}" y="${c.y}" text-anchor="middle">` +
        `<tspan class="n" x="${c.x}" dy="${c.a < 2600 ? "0.35em" : "-0.15em"}">${esc(n.replace(/(시|군)$/, ""))}</tspan>` +
        (c.a < 2600 ? "" : `<tspan class="v" x="${c.x}" dy="1.25em"></tspan>`) + `</text>`).join("");
    svg.querySelectorAll(".city").forEach(p => {
      const pick = () => setRegion(state.region === p.dataset.city ? "경기도" : p.dataset.city, true);
      p.addEventListener("click", pick);
      p.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
      p.addEventListener("mousemove", e => {
        const s = mapCache.byName[p.dataset.city], info = mapCache.info; if (!s || !info) return;
        showTip(e, `<b>${esc(s.name)}</b><br>${esc(info.label)}<br><b>${info.text(s)}</b><br>${L}년 학생수 ${fmt(s.t)}명 · ${fmt(s.n)}개교`);
      });
      p.addEventListener("mouseleave", hideTip);
    });
  }

  function renderMap() {
    const svg = $("#map");
    const stats = CITIES.map(cityStats), info = metricInfo(stats);
    const byName = Object.fromEntries(stats.map(s => [s.name, s]));
    mapCache = { info, byName };
    // 지도는 화면 폭에 맞춰 줄어들므로, 글자가 실제 화면에서 일정한 크기가 되도록 배율을 넘김
    const vbW = Number(MAP.viewBox.split(" ")[2]) || 800;
    svg.style.setProperty("--k", (vbW / Math.max(svg.clientWidth, 1)).toFixed(3));
    const showVals = svg.clientWidth >= 420;   // 좁으면 값은 순위 막대에서 보여 주고 지도는 이름만
    svg.classList.toggle("tiny", svg.clientWidth < 440);   // 아주 좁으면 작은 시의 이름은 숨김(눌러서 확인)
    svg.querySelectorAll(".city").forEach(p => {
      const s = byName[p.dataset.city];
      p.setAttribute("fill", s ? info.color(s) : css("--ctx"));
      p.classList.toggle("sel", p.dataset.city === state.region);
      p.setAttribute("aria-label", s ? `${s.name} ${info.text(s)}` : p.dataset.city);
    });
    svg.querySelectorAll(".lab .v").forEach(t => {
      const s = byName[t.parentNode.dataset.city];
      t.textContent = showVals && s ? info.short(s) : "";
    });
    svg.classList.toggle("has-sel", state.region !== "경기도");
    $("#map-title").textContent = `시·군 지도 — ${info.label}`;
    $("#metric-help").textContent = METRIC_HELP[state.metric]();
    const grad = info.seq ? `linear-gradient(90deg, ${SEQ.join(",")})`
      : `linear-gradient(90deg, ${css("--down-fill")}, ${css("--mid")}, ${css("--up-fill")})`;
    $("#map-legend").innerHTML = info.seq
      ? `<span>${info.legend[0]}</span><span class="bar" style="background:${grad}"></span><span>${info.legend[1]}</span>`
      : `<span>${info.legend[0]}</span><span class="bar" style="background:${grad}"></span><span>${info.legend[2]}</span><span class="note">가운데 ${info.legend[1]} · 회색 지역은 서울·인천</span>`;
  }

  function renderRank() {
    // 지역을 고르면 그 지역 학교 순위, 아니면 시·군 순위
    const schoolMode = state.region !== "경기도";
    const shortName = n => n.replace(/고등학교$/, "고");
    const stats = schoolMode
      ? schoolList().map(r => ({ ...r, full: r.name, name: shortName(r.name) }))
      : CITIES.map(cityStats);
    const info = metricInfo(stats);
    const sorted = stats.filter(s => info.value(s) != null).sort((a, b) => info.value(b) - info.value(a));
    const missing = stats.length - sorted.length;
    const isHL = s => schoolMode ? s.code === state.school : s.name === state.region;
    const anyHL = schoolMode ? !!state.school : true;
    const small = narrow("c-rank");
    $("#rank-title").textContent = schoolMode ? `${state.region} 학교 순위 — ${info.label}` : `시·군 순위 — ${info.label}`;
    $("#w-rank").style.height = (sorted.length * (small ? 24 : 22) + 60) + "px";
    const B = info.bar;
    const raw = sorted.map(B.val);
    // 증감률에서 신설·폐교 직전 학교처럼 극단값이 있으면 막대를 축 끝에서 자르고(라벨은 실제 값) 나머지가 보이게 함
    let lo = B.min, hi = B.max, clipped = new Set();
    if (B.diverging && raw.length > 4) {
      const abs = raw.map(Math.abs).sort((a, b) => a - b);
      const cap = Math.max(5, abs[Math.floor(abs.length * 0.8)] * 2.5);
      raw.forEach((v, i) => { if (Math.abs(v) > cap) clipped.add(i); });
      if (clipped.size) { lo = Math.max(B.min, -cap); hi = Math.min(B.max, cap); }
    }
    const vals = raw.map(v => Math.max(lo, Math.min(hi, v)));
    $("#rank-sub").innerHTML = schoolMode
      ? `${esc(scopeParts().slice(1).join(" · "))} 기준 ${sorted.length}개교` +
        (missing ? ` (작년 자료가 없는 신설 학교 ${missing}곳 제외)` : "") +
        (clipped.size ? ` · ▸ 표시는 값이 커서 막대를 잘라 그린 학교` : "") +
        ` · 막대를 누르면 학교 상세가 열립니다. <button type="button" class="btn ghost" id="rank-back">시·군 순위로 돌아가기</button>`
      : `${esc(scopeParts().slice(1).join(" · "))} 기준 · 막대를 누르면 그 지역의 학교 순위로 바뀝니다.`;
    const back = $("#rank-back"); if (back) back.onclick = () => setRegion("경기도");
    const colors = sorted.map(s => {
      let c = B.color(s);
      if (state.region !== "경기도" && anyHL && !isHL(s)) c = mix(c.startsWith("#") ? c : rgb2hex(c), css("--card"), 0.65);
      return c;
    });
    // 축 범위: 증감률은 0을 가운데 두고 양쪽 여유, 나머지는 왼쪽 끝에서 채움
    const span = (hi - lo) || 1;
    // 값 라벨이 막대 밖에 들어갈 자리를 픽셀 기준으로 확보 (값 범위가 넓어도 이름과 겹치지 않게)
    const labelPx = small ? 52 : 58;
    const nameW = Math.max(...sorted.map(s => s.name.length), 2) * (small ? 11.5 : 12.5) + 16;
    const plotW = Math.max(120, ($("#w-rank").clientWidth || 420) - nameW - 12);
    const extra = sides => labelPx * span / Math.max(60, plotW - sides * labelPx);
    const sides = (lo < 0 ? 1 : 0) + (hi > 0 ? 1 : 0);
    const xMin = B.diverging ? (lo < 0 ? lo - extra(sides) : 0) : lo;
    const xMax = B.diverging ? (hi > 0 ? hi + extra(sides) : 0) : hi + (B.ref ? 0 : span * 0.02);
    // 기준선 (유지율 100% = 감소 없음)
    const refLine = { id: "refLine", afterDatasetsDraw(ch) {
      if (!B.ref) return;
      const x = ch.scales.x.getPixelForValue(B.ref), { top, bottom } = ch.chartArea, g = ch.ctx;
      g.save(); g.strokeStyle = css("--ink-2"); g.lineWidth = 1.5; g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(x, top - 4); g.lineTo(x, bottom); g.stroke(); g.setLineDash([]);
      g.fillStyle = css("--ink-2"); g.font = `600 11px ${Chart.defaults.font.family}`; g.textAlign = "center";
      g.fillText("100%", x, top - 8); g.restore();
    } };
    draw("c-rank", {
      type: "bar", plugins: [refLine],
      data: { labels: sorted.map(s => s.name), datasets: [{ data: vals, backgroundColor: colors, borderRadius: 4, borderSkipped: false, barPercentage: 0.8, categoryPercentage: 0.9 }] },
      options: {
        indexAxis: "y",
        layout: { padding: { left: 4, right: B.diverging ? 8 : (small ? 48 : 58), top: B.ref ? 16 : 0 } },
        onClick: (e, els) => {
          if (!els.length) return;
          const it = sorted[els[0].index];
          // 클릭 처리 중에 그래프를 destroy하지 않도록 한 박자 늦춤
          setTimeout(() => { if (schoolMode) openSchool(it.code); else setRegion(state.region === it.name ? "경기도" : it.name, true); });
        },
        onHover: (e, els) => { e.native.target.style.cursor = els.length ? "pointer" : "default"; },
        plugins: {
          legend: { display: false },
          datalabels: {
            // 막대 끝(음수는 왼쪽 끝) 바깥에 값 표시
            display: true, anchor: ctx => (B.diverging && vals[ctx.dataIndex] < 0 ? "start" : "end"),
            align: ctx => (B.diverging && vals[ctx.dataIndex] < 0 ? "left" : "right"), offset: 4, clamp: false, clip: false,
            color: ctx => isHL(sorted[ctx.dataIndex]) ? css("--ink") : css("--ink-2"),
            backgroundColor: B.ref ? css("--card") : null, borderRadius: 3, padding: { top: 1, bottom: 1, left: 3, right: 3 },
            font: ctx => ({ size: small ? 10.5 : 11.5, weight: isHL(sorted[ctx.dataIndex]) ? "800" : "600" }),
            formatter: (v, ctx) => info.short(sorted[ctx.dataIndex]) + (clipped.has(ctx.dataIndex) ? " ▸" : "")
          },
          tooltip: { callbacks: { title: i => sorted[i[0].dataIndex].full || i[0].label,
                                  label: c => ` ${info.text(sorted[c.dataIndex])} · ${L}년 ${fmt(sorted[c.dataIndex].t)}명` } }
        },
        scales: {
          y: { grid: { display: false }, border: { color: css("--axis") },
               ticks: { autoSkip: false, color: c => sorted[c.index] && isHL(sorted[c.index]) ? css("--ink") : css("--ink-2"),
                        font: c => ({ size: small ? 11.5 : 12.5, weight: sorted[c.index] && isHL(sorted[c.index]) ? "800" : "500" }) } },
          x: { grid: { color: css("--grid") }, border: { display: false }, min: xMin, max: xMax,
               ticks: { maxTicksLimit: 6, includeBounds: false, callback: v => B.tick(v) } }
        }
      }
    });
  }

  /* ───────── 렌더: 학교 ───────── */

  function schoolList() {
    const q = state.q.trim().replace(/\s/g, "");
    const latest = ROWS.filter(r => r.yr === L && inFilter(r) && inRegion(r) && (!q || r.name.replace(/\s/g, "").includes(q)));
    const prevBy = Object.fromEntries(ROWS.filter(r => r.yr === L - 1).map(r => [r.code, r]));
    return latest.map(r => {
      const p = prevBy[r.code];
      return { ...r, rate: p && p.t ? r.t / p.t - 1 : null, ret12: p ? ratio(r.g2, p.g1) : null, isNew: !p };
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
    $("#school-title").textContent = `${scopeParts()[0]} 학교 목록`;
    $("#school-sub").textContent = `${scopeLabel()} · ${L}년 공시 ${fmt(list.length)}개교. 학교를 누르면 학년별 3개년 추이를 볼 수 있습니다.`;
    $("#t-school tbody").innerHTML = list.slice(0, state.schoolLimit).map(r => `
      <tr data-code="${esc(r.code)}" class="${r.code === state.school ? "sel" : ""}" tabindex="0">
        <td class="name">${esc(r.name)}${r.isNew ? ` <span class="tag new">${L}년 첫 공시</span>` : ""}${r.manual ? ` <span class="tag manual" title="학교알리미 API에 없어 공시 화면을 보고 직접 입력한 값">수동 입력</span>` : ""}<span class="go" aria-hidden="true">›</span>
          <small class="m-only">${esc(r.city)} · ${esc(r.type)} · ${esc(r.fond)}</small></td>
        <td class="opt">${esc(r.city)}</td><td class="opt"><span class="tag">${esc(r.type)}</span></td><td class="opt">${esc(r.fond)}</td>
        <td class="num"><b>${fmt(r.t)}</b></td><td class="num ${cls(r.rate)}">${pct(r.rate)}</td>
        <td class="num opt">${fmt(r.g1)}</td><td class="num opt">${fmt(r.g2)}</td><td class="num opt">${fmt(r.g3)}</td>
        <td class="num opt2">${pctPlain(r.ret12)}</td>
      </tr>`).join("") || `<tr><td colspan="10">조건에 맞는 학교가 없습니다. 검색어나 필터를 바꿔 보세요.</td></tr>`;
    const left = list.length - state.schoolLimit;
    $("#school-more").innerHTML = left > 0
      ? `<span>${fmt(Math.min(state.schoolLimit, list.length))} / ${fmt(list.length)}개교 표시</span>
         <button type="button" class="btn" data-more="${PAGE}">${fmt(Math.min(PAGE, left))}개 더 보기</button>
         <button type="button" class="btn ghost" data-more="all">모두 보기</button>` : (list.length ? `<span>${fmt(list.length)}개교 모두 표시</span>` : "");
    markSorted("#t-school", state.schoolSort);
  }

  function renderDetail() {
    const box = $("#detail");
    const rows = state.school ? ROWS.filter(r => r.code === state.school).sort((a, b) => a.yr - b.yr) : [];
    if (!rows.length) { box.hidden = true; return; }
    const last = rows[rows.length - 1];
    box.hidden = false;
    const small = narrow("c-school", BAR_LABEL_PX);   // 상자를 연 뒤에 폭을 재야 정확함
    $("#d-title").textContent = last.name;
    const manualYrs = rows.filter(r => r.manual).map(r => r.yr + "년");
    $("#d-sub").textContent = [last.addr || last.city, last.type, last.fond].filter(Boolean).join(" · ") +
      (manualYrs.length ? ` · ${manualYrs.join(", ")} 자료는 API에 없어 직접 입력한 값` : "");
    const xs = SHOWN.slice().reverse().map(y => rows.find(r => r.yr === y) || { yr: y, g1: null, g2: null, g3: null });
    const ds = (label, k, color) => ({ label, data: xs.map(r => r[k]), backgroundColor: color,
      borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "bottom", maxBarThickness: 34, categoryPercentage: 0.78, barPercentage: 0.9 });
    draw("c-school", {
      type: "bar",
      data: { labels: xs.map(r => r.yr + "년"), datasets: [ds("1학년", "g1", css("--s1")), ds("2학년", "g2", css("--s2")), ds("3학년", "g3", css("--s3"))] },
      options: { layout: { padding: { top: 6 } },
                 plugins: { legend: { position: "top", align: "start" }, datalabels: valueLabels(small),
                            tooltip: { mode: "index", intersect: false, callbacks: { label: c => ` ${c.dataset.label}: ${fmt(c.raw)}명` } } },
                 scales: { x: xAxis(), y: yAxis(small ? { grace: "48%" } : {}) } }
    });
    const by = Object.fromEntries(rows.map(r => [r.yr, r]));
    const coh = (cur, prv) => prv ? `<small class="${cls(cur / prv - 1)}">${pct(cur / prv - 1)}</small>` : "";
    const tr = SHOWN.map(y => {
      const r = by[y], p = by[y - 1];
      if (!r) return `<tr><td>${y}년</td><td colspan="6">공시 없음</td></tr>`;
      const rate = p && p.t ? r.t / p.t - 1 : null;
      return `<tr><td><b>${y}년</b></td><td class="num">${fmt(r.g1)}</td>
        <td class="num">${fmt(r.g2)}${coh(r.g2, p && p.g1)}</td><td class="num">${fmt(r.g3)}${coh(r.g3, p && p.g2)}</td>
        <td class="num opt">${fmt(r.etc)}</td><td class="num"><b>${fmt(r.t)}</b></td><td class="num ${cls(rate)}">${pct(rate)}</td></tr>`;
    }).join("");
    $("#t-detail").innerHTML = `<thead><tr><th>연도</th><th class="num">1학년</th><th class="num">2학년</th><th class="num">3학년</th><th class="num opt">기타</th><th class="num">합계</th><th class="num">전년 대비</th></tr></thead><tbody>${tr}</tbody>
      <caption style="caption-side:bottom;text-align:left;color:var(--muted);font-size:.82em;padding-top:8px;white-space:normal">2·3학년 아래 작은 숫자는 전년도 한 학년 아래(같은 입학생) 대비 증감률입니다.</caption>`;
  }

  /* ───────── 렌더: 시군 표 ───────── */

  function cityRows() {
    return CITIES.map(cityStats).map(s => {
      const o = { name: s.name, n: s.n, rate: s.rate, ret12: s.ret12, ret23: s.ret23, g1: s.g1 };
      SHOWN.forEach(y => o["t" + y] = s.y[y] ? s.y[y].t : 0);
      return o;
    });
  }
  function totalRow() {
    const y = byYear(ROWS.filter(inFilter)), cur = y[L], prev = y[L - 1] || EMPTY;
    const o = { name: "경기도 전체", n: cur.n, rate: prev.t ? cur.t / prev.t - 1 : null, ret12: ratio(cur.g2, prev.g1), ret23: ratio(cur.g3, prev.g2), g1: cur.g1 };
    SHOWN.forEach(yy => o["t" + yy] = y[yy].t);
    return o;
  }
  function cityCols() {
    return [["name", "시·군"], ["n", `학교수(${L})`]]
      .concat(SHOWN.slice().reverse().map(y => ["t" + y, `${y}년 학생수`]))
      .concat([["rate", "전년 대비"], ["g1", `${L}년 1학년`], ["ret12", "1→2 유지율"], ["ret23", "2→3 유지율"]]);
  }
  function renderCityTable() {
    const rows = sortBy(cityRows(), state.citySort), cols = cityCols(), tot = totalRow();
    const cell = (k, v) => k === "name" ? esc(v) : k === "rate" ? `<span class="${cls(v)}">${pct(v)}</span>` : k.startsWith("ret") ? pctPlain(v) : fmt(v);
    const tr = (r, extra = "") => `<tr ${extra}>${cols.map(([k]) => `<td class="${k === "name" ? "name" : "num"}">${cell(k, r[k])}</td>`).join("")}</tr>`;
    $("#t-city").innerHTML = `<caption class="sr">시군별 합계 표</caption>
      <thead><tr>${cols.map(([k, l]) => `<th scope="col" data-k="${k}" class="${k === "name" ? "" : "num"}">${l}</th>`).join("")}</tr></thead>
      <tbody>${tr(tot, 'class="total" data-city="경기도"')}${rows.map(r => tr(r, `data-city="${esc(r.name)}" class="${r.name === state.region ? "sel" : ""}" tabindex="0"`)).join("")}</tbody>`;
    $("#city-sub").textContent = `${scopeParts().slice(1).join(" · ")} 기준 · 머리글을 누르면 정렬, 행을 누르면 그 지역을 선택합니다.`;
    markSorted("#t-city", state.citySort);
  }

  function markSorted(sel, s) {
    $$(sel + " thead th").forEach(th => {
      th.classList.toggle("sorted", th.dataset.k === s.k);
      th.classList.toggle("asc", th.dataset.k === s.k && s.asc);
      th.setAttribute("aria-sort", th.dataset.k === s.k ? (s.asc ? "ascending" : "descending") : "none");
    });
  }

  /* ───────── 유의사항 ───────── */

  function renderNotes() {
    const codes = y => new Map(ROWS.filter(r => r.yr === y).map(r => [r.code, r]));
    const now = codes(L), before = codes(L - 1);
    const added = [...now.values()].filter(r => !before.has(r.code));
    const gone = [...before.values()].filter(r => !now.has(r.code));
    const list = arr => arr.map(r => `${esc(r.name)}(${esc(r.city)})`).join(", ");
    const items = [];
    const manual = ROWS.filter(r => r.manual);
    if (manual.length) items.push(`<b>직접 입력한 자료 ${manual.length}건</b>: ${manual.map(r => `${esc(r.name)}(${r.yr}년)`).join(", ")}. 학교알리미 Open API에 빠져 있어 학교알리미 공시 화면의 학년별 학생수를 보고 입력했습니다. 학교 목록에 <span class="tag manual">수동 입력</span>으로 표시됩니다.`);
    if (added.length) items.push(`<b>${L}년에 처음 공시된 학교 ${added.length}곳</b>: ${list(added)}. 신설 학교는 1학년만 있어 해당 지역의 학생수 증가와 1학년 수에 반영됩니다.`);
    if (gone.length) items.push(`<b>${L - 1}년에는 있었지만 ${L}년 자료에 없는 학교 ${gone.length}곳</b>: ${list(gone)}. 통폐합·교명 변경·공시 누락 여부를 학교알리미에서 확인하세요. 이 학교들의 ${L - 1}년 학생수(${fmt(gone.reduce((s, r) => s + r.t, 0))}명)는 전년 대비 증감률에 감소로 반영됩니다.`);
    items.push(`<b>화성시</b>는 2026년 2월 만세·효행·병점·동탄 4개 구가 생겨 ${2026}년 자료부터 구 단위로 수집해 합산했습니다.`);
    items.push(`학교알리미 Open API는 <b>최근 3개 공시연도</b>(${SHOWN[SHOWN.length - 1]}~${L}년)만 제공하므로, 가장 오래된 해의 전년 대비 증감률은 계산할 수 없습니다.`);
    items.push(`학년 진행(유지율)은 지역 합계로 계산해 학교 신설·폐교, 시·군 사이 전학이 함께 반영됩니다.`);
    $("#notes").innerHTML = items.map(t => `<li>${t}</li>`).join("");
  }

  /* ───────── 전체 렌더 ───────── */

  function renderAll() {
    const list = ROWS.filter(r => inFilter(r) && inRegion(r));
    $("#f-region").value = state.region;
    $("#render-err")?.remove();
    if (!$("#map-note")?.classList.contains("flash")) idleMapNote();
    // 한 부분에서 오류가 나도 나머지는 그려지도록 각각 따로 실행
    [() => renderScope(list), () => renderKPIs(list), () => renderTrend(list), () => renderCohort(list),
     renderMap, renderRank, renderSchools, renderDetail, renderCityTable].forEach(fn => {
      try { fn(); } catch (e) { console.error("그리기 오류:", e); showRenderError(e); }
    });
  }
  function showRenderError(e) {
    let box = $("#render-err");
    if (!box) { box = document.createElement("p"); box.id = "render-err"; box.className = "err"; $("#main").prepend(box); }
    box.textContent = `일부 화면을 그리지 못했습니다: ${e && e.message ? e.message : e} — 이 문구를 캡처해 알려 주세요.`;
  }
  function setRegion(r, notify) {
    state.region = r; state.schoolLimit = PAGE;
    if (state.school && !ROWS.some(x => x.code === state.school && inRegion(x))) state.school = null;
    renderAll();
    if (notify) showMapNote(r);
  }

  // 지도·순위에서 지역을 바꾸면 화면 밖(위쪽)의 요약이 바뀐 것을 바로 알려 줌
  let noteTimer;
  function showMapNote(r) {
    const n = $("#map-note"); if (!n) return;
    const cur = agg(ROWS.filter(x => x.yr === L && inFilter(x) && inRegion(x)));
    n.innerHTML = (r === "경기도"
      ? `<b>경기도 전체</b>로 돌아왔습니다.`
      : `<b>${esc(r)}</b> 선택 — ${L}년 ${fmt(cur.n)}개교 ${fmt(cur.t)}명. 위 요약·추이와 아래 학교 목록이 ${esc(r)} 기준으로 바뀌었습니다. 같은 지역을 다시 누르면 경기도 전체로 돌아갑니다.`) +
      ` <button type="button" class="btn ghost" data-go="s-summary">요약 보기 ↑</button>`;
    n.hidden = false;
    n.classList.remove("flash"); void n.offsetWidth; n.classList.add("flash");
    clearTimeout(noteTimer); noteTimer = setTimeout(() => idleMapNote(), 10000);
  }
  function idleMapNote() {
    const n = $("#map-note"); if (!n) return;
    n.hidden = false; n.classList.remove("flash");
    n.innerHTML = state.region === "경기도"
      ? `지역을 누르면 페이지 전체가 그 지역 기준으로 바뀝니다.`
      : `지금 <b>${esc(state.region)}</b> 기준입니다. 같은 지역을 다시 누르면 경기도 전체로 돌아갑니다.`;
  }

  /* ───────── 툴팁 ───────── */
  function showTip(e, html) {
    const t = $("#tip"); t.innerHTML = html; t.hidden = false;
    const w = t.offsetWidth, h = t.offsetHeight;
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + w > innerWidth - 8) x = e.clientX - w - 14;
    if (y + h > innerHeight - 8) y = e.clientY - h - 14;
    t.style.left = Math.max(8, x) + "px"; t.style.top = Math.max(8, y) + "px";
  }
  function hideTip() { $("#tip").hidden = true; }

  /* ───────── 이벤트 ───────── */

  function chipGroup(el, values, set) {
    el.innerHTML = values.map(v => `<button type="button" class="chip" aria-pressed="false" data-v="${esc(v)}">${esc(v)}</button>`).join("");
    el.addEventListener("click", e => {
      const b = e.target.closest(".chip"); if (!b) return;
      const v = b.dataset.v;
      set.has(v) ? set.delete(v) : set.add(v);
      b.setAttribute("aria-pressed", set.has(v));
      state.schoolLimit = PAGE; renderAll();
    });
  }

  function openSchool(code) {
    state.school = code; renderSchools(); renderDetail(); renderRank();
    $("#detail").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function bind() {
    const sel = $("#f-region");
    sel.insertAdjacentHTML("beforeend", CITIES.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join(""));
    sel.addEventListener("change", () => setRegion(sel.value));

    const rank = t => { const i = TYPE_ORDER.indexOf(t); return i < 0 ? 99 : i; };
    chipGroup($("#f-type"), [...new Set(ROWS.map(r => r.type))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)), state.types);
    chipGroup($("#f-fond"), [...new Set(ROWS.map(r => r.fond))].sort(), state.fonds);

    $("#map-note").addEventListener("click", e => {
      const b = e.target.closest("[data-go]"); if (b) document.getElementById(b.dataset.go).scrollIntoView({ behavior: "smooth" });
    });

    $("#f-reset").addEventListener("click", () => {
      state.types.clear(); state.fonds.clear(); state.school = null;
      $$(".chip").forEach(c => c.setAttribute("aria-pressed", "false"));
      setRegion("경기도");
    });

    // 제목을 누르면 필터를 모두 풀고 맨 위(초기 화면)로 이동
    const goHome = () => { $("#f-reset").click(); scrollTo({ top: 0, behavior: "smooth" }); };
    $("#title").addEventListener("click", goHome);
    $("#title").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goHome(); } });

    $("#metric").addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      state.metric = b.dataset.v;
      $$("#metric button").forEach(x => x.setAttribute("aria-checked", x === b));
      renderMap(); renderRank();
    });

    let t; $("#q").addEventListener("input", e => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value; state.schoolLimit = PAGE; renderSchools(); }, 150); });

    $("#t-school thead").addEventListener("click", e => {
      const k = e.target.closest("th")?.dataset.k; if (!k) return;
      state.schoolSort = { k, asc: state.schoolSort.k === k ? !state.schoolSort.asc : ["name", "city", "type", "fond"].includes(k) };
      renderSchools();
    });
    const tbody = $("#t-school tbody");
    tbody.addEventListener("click", e => { const tr = e.target.closest("tr[data-code]"); if (tr) openSchool(tr.dataset.code); });
    tbody.addEventListener("keydown", e => { const tr = e.target.closest("tr[data-code]"); if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openSchool(tr.dataset.code); } });
    $("#school-more").addEventListener("click", e => {
      const b = e.target.closest("[data-more]"); if (!b) return;
      state.schoolLimit = b.dataset.more === "all" ? 1e9 : state.schoolLimit + PAGE; renderSchools();
    });
    $("#d-close").addEventListener("click", () => { state.school = null; renderSchools(); renderDetail(); renderRank(); $("#t-school").scrollIntoView({ behavior: "smooth", block: "start" }); });

    const pickCity = tr => { if (!tr) return; const c = tr.dataset.city; setRegion(c === "경기도" || state.region === c ? "경기도" : c); $("#s-summary").scrollIntoView({ behavior: "smooth" }); };
    $("#t-city").addEventListener("click", e => {
      const th = e.target.closest("thead th");
      if (th) { const k = th.dataset.k; state.citySort = { k, asc: state.citySort.k === k ? !state.citySort.asc : k === "name" }; renderCityTable(); return; }
      pickCity(e.target.closest("tr[data-city]"));
    });
    $("#t-city").addEventListener("keydown", e => { if (e.key === "Enter") pickCity(e.target.closest("tr[data-city]")); });

    $("#dl").addEventListener("click", () => {
      const cols = cityCols(), rows = [totalRow()].concat(sortBy(cityRows(), state.citySort));
      const v = (k, x) => x == null ? "" : k.startsWith("ret") || k === "rate" ? (x * 100).toFixed(2) + "%" : x;
      const csv = "﻿" + [cols.map(c => c[1]).join(",")].concat(rows.map(r => cols.map(([k]) => v(k, r[k])).join(","))).join("\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      a.download = `경기도_시군별_고교학생수_${L}_${scopeParts().slice(1).join("_").replace(/[ ·]+/g, "_")}.csv`;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    // 창 크기·색상 모드 변화에 맞춰 다시 그림 (라벨 밀도, 순위 막대 높이, 지도 값 표시)
    let lastW = innerWidth, rt;
    addEventListener("resize", () => {
      if (Math.abs(innerWidth - lastW) < 40) return;
      lastW = innerWidth; clearTimeout(rt); rt = setTimeout(renderAll, 200);
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { chartDefaults(); renderAll(); });
    // 숨겨진 탭에서 크기가 0으로 잡혔다가 다시 보일 때 그래프를 다시 맞춤
    document.addEventListener("visibilitychange", () => { if (!document.hidden) Object.values(charts).forEach(c => { c.resize(); c.update("none"); }); });
  }

  /* ───────── 시작 ───────── */

  // 그래프는 다음 프레임에 그려지므로, 그때 난 오류도 화면에 보이게 함
  addEventListener("error", e => { if (ROWS.length) showRenderError(e.error || e.message); });
  addEventListener("unhandledrejection", e => { if (ROWS.length) showRenderError(e.reason); });

  (async function init() {
    document.title = CFG.TITLE; $("#title").textContent = CFG.TITLE;
    try {
      const [{ rows, from }, map] = await Promise.all([loadData(), fetch("data/gyeonggi-map.json", { cache: "no-cache" }).then(r => r.json())]);
      ROWS = rows; MAP = map; FROM = from;
      YEARS = [...new Set(ROWS.map(r => r.yr))].sort((a, b) => b - a);
      L = YEARS[0]; SHOWN = YEARS.slice(0, 3);
      CITIES = Object.keys(MAP.cities).sort((a, b) => a.localeCompare(b, "ko"));
      CITIES = CITIES.concat([...new Set(ROWS.map(r => r.city))].filter(c => !CITIES.includes(c)));

      const y = byYear(ROWS), cur = y[L], prev = y[L - 1] || EMPTY;
      const r = prev.t ? cur.t / prev.t - 1 : null;
      $("#lede").innerHTML = `${L}년 경기도 고등학교는 <b>${fmt(cur.n)}개교, 학생 ${fmt(cur.t)}명</b>으로 ${L - 1}년보다 <b class="${cls(r)}">${pct(r).replace(/^[+−]/, "")} ${r < 0 ? "줄었습니다" : "늘었습니다"}</b>. 지역·학교유형별로 학년마다 학생수가 어떻게 바뀌는지 살펴보세요.`;
      $("#meta").textContent = `${SHOWN[SHOWN.length - 1]}~${L}년 공시 · 31개 시·군` + (STAMP ? ` · 자료 수집 ${STAMP}` : "");
      $("#source").textContent = `자료: ${CFG.SOURCE}` + (STAMP ? ` · 수집 ${STAMP}` : "") +
        (from === "sheet" ? " · 미리보기: 스프레드시트를 직접 읽는 중 (게시된 자료가 아님)" : "");
      if (from === "sheet") {
        const pv = document.createElement("p"); pv.className = "preview";
        pv.innerHTML = "<b>미리보기</b> — 스프레드시트의 현재 내용을 직접 읽고 있습니다. 게시된 사이트에는 GitHub의 <b>자료 갱신</b>을 실행해야 반영됩니다.";
        $("#main").before(pv);
      }

      chartDefaults(); buildMap(); bind(); renderNotes(); renderAll();
    } catch (e) {
      console.error(e);
      $("#lede").innerHTML = `<span class="err">자료를 불러오지 못했습니다. 스프레드시트 공유가 '링크가 있는 모든 사용자: 뷰어'인지, DB 시트가 있는지 확인해 주세요. (${esc(e.message)})</span>`;
    }
  })();
})();
