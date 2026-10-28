/**
 * 경기도 고등학교 학년별 학생수 수집기 (학교알리미 Open API, apiType 63)
 *
 *  ▸ 메뉴 [학생수 데이터 → API에서 새로 수집] 을 누르면
 *      1) DB 시트       : 학교 × 공시연도 원자료 (웹사이트가 읽는 시트)
 *      2) 00_경기도_전체_요약 : 경기도·시군별 연도 합계와 전년비
 *      3) 01_가평군 … 31_화성시 : 학교별 학년 상세(코호트 증감률 포함)
 *    를 새로 만듭니다.
 *  ▸ 해마다 바꿀 곳은 LATEST_YEAR 하나입니다.
 */

// API 키는 코드에 적지 않고 '스크립트 속성'에 저장합니다.
//  ⚙️ 프로젝트 설정 → 스크립트 속성 → 속성 추가:  SCHOOLINFO_API_KEY = (발급받은 키)
const API_KEY = PropertiesService.getScriptProperties().getProperty("SCHOOLINFO_API_KEY");
const LATEST_YEAR = 2026;  // 최신 공시 연도
const SHOW_YEARS  = 3;     // 조회·표시 연도 수 (Open API는 최근 3년만 제공)

const DB_SHEET      = "DB";
const FIX_SHEET     = "보정";   // API에 빠진 학교를 손으로 입력하는 시트
const SUMMARY_SHEET = "00_경기도_전체_요약";

// 시군 → 학교알리미 시군구 코드 (일반구가 있는 시는 구 코드 전부)
// 화성시: 2025년까지 41590, 2026년부터 만세(41591)·효행(41593)·병점(41595)·동탄구(41597)
const REGION_MAP = {
  "가평군": ["41820"], "고양시": ["41281", "41285", "41287"], "과천시": ["41290"],
  "광명시": ["41210"], "광주시": ["41610"], "구리시": ["41310"], "군포시": ["41410"],
  "김포시": ["41570"], "남양주시": ["41360"], "동두천시": ["41250"],
  "부천시": ["41192", "41194", "41196"], "성남시": ["41131", "41133", "41135"],
  "수원시": ["41111", "41113", "41115", "41117"], "시흥시": ["41390"],
  "안산시": ["41271", "41273"], "안성시": ["41550"], "안양시": ["41171", "41173"],
  "양주시": ["41630"], "양평군": ["41830"], "여주시": ["41670"], "연천군": ["41800"],
  "오산시": ["41370"], "용인시": ["41461", "41463", "41465"], "의왕시": ["41430"],
  "의정부시": ["41150"], "이천시": ["41500"], "파주시": ["41480"], "평택시": ["41220"],
  "포천시": ["41650"], "하남시": ["41450"],
  "화성시": ["41590", "41591", "41593", "41595", "41597"]
};

const DB_HEADERS = [
  "공시연도", "시군", "시군구코드", "주소", "학교코드", "학교명", "학교유형", "설립", "주야",
  "1학년_남", "1학년_여", "2학년_남", "2학년_여", "3학년_남", "3학년_여",
  "기타_남", "기타_여", "남_계", "여_계", "총계", "자료출처"
];
const API_SOURCE = "학교알리미 API";
const FIX_SOURCE = "수동 입력";

/* ───────────────────────── 메뉴 ───────────────────────── */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("학생수 데이터")
    .addItem("API에서 새로 수집", "collectAll")
    .addItem("요약·시군 시트만 다시 만들기", "rebuildReports")
    .addSeparator()
    .addItem("보정 시트 열기 (API에 빠진 학교 입력)", "openFixSheet")
    .addToUi();
}

/* ───────────────────────── 수집 ───────────────────────── */

function years_() {
  const all = [];
  for (let i = 0; i < SHOW_YEARS; i++) all.push(LATEST_YEAR - i);
  return all;                       // 예) [2026, 2025, 2024]  (가장 오래된 해는 전년비 없음)
}

function collectAll() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!API_KEY) {
    SpreadsheetApp.getUi().alert("API 키가 없습니다.\n⚙️ 프로젝트 설정 → 스크립트 속성에 SCHOOLINFO_API_KEY 를 추가해 주세요.");
    return;
  }
  const jobs = [];
  years_().forEach(yr => {
    Object.keys(REGION_MAP).forEach(city => {
      REGION_MAP[city].forEach(code => jobs.push({ yr, city, code }));
    });
  });

  const rows = [];
  const seen = {};
  const BATCH = 20;

  for (let i = 0; i < jobs.length; i += BATCH) {
    const slice = jobs.slice(i, i + BATCH);
    const responses = UrlFetchApp.fetchAll(slice.map(j => ({
      url: `https://www.schoolinfo.go.kr/openApi.do?apiKey=${API_KEY}&apiType=63` +
           `&pbanYr=${j.yr}&schulKndCode=04&sidoCode=41&sggCode=${j.code}`,
      muteHttpExceptions: true
    })));

    responses.forEach((res, k) => {
      const job = slice[k];
      let json;
      try { json = JSON.parse(res.getContentText()); }
      catch (e) { Logger.log(`응답 해석 실패 ${job.yr} ${job.city} ${job.code}`); return; }
      if (json.resultCode !== "success" || !json.list) return;   // 해당 연도에 없는 구 코드 등은 정상적으로 건너뜀

      json.list.forEach(s => {
        const key = job.yr + "|" + s.SCHUL_CODE;
        if (seen[key]) return;
        seen[key] = true;
        const n = f => Number(s[f] || 0);
        rows.push([
          job.yr, job.city, job.code, s.ADRCD_NM || "", s.SCHUL_CODE, s.SCHUL_NM,
          s.HS_KND_SC_NM || "", s.FOND_SC_CODE || "", s.DGHT_CRSE_SC_CODE || "",
          n("COL_M1"), n("COL_W1"), n("COL_M2"), n("COL_W2"), n("COL_M3"), n("COL_W3"),
          n("COL_M7") + n("COL_M8"), n("COL_W7") + n("COL_W8"),
          n("COL_MSUM"), n("COL_WSUM"), n("SUM") || (n("COL_MSUM") + n("COL_WSUM")),
          API_SOURCE
        ]);
      });
    });
    Utilities.sleep(300);
  }

  if (!rows.length) {
    SpreadsheetApp.getUi().alert("받은 데이터가 없습니다. 실행 로그를 확인해 주세요.");
    return;
  }

  const fixed = mergeFixes_(ss, rows, seen);

  rows.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]) || a[5].localeCompare(b[5]));

  const db = ss.getSheetByName(DB_SHEET) || ss.insertSheet(DB_SHEET);
  if (db.getFilter()) db.getFilter().remove();
  db.clear();
  db.getRange(1, 1, 1, DB_HEADERS.length).setValues([DB_HEADERS])
    .setFontWeight("bold").setBackground("#1F4E78").setFontColor("white");
  db.getRange(2, 1, rows.length, DB_HEADERS.length).setValues(rows);
  db.setFrozenRows(1);
  db.getRange(1, 1, rows.length + 1, DB_HEADERS.length).createFilter();

  // 마지막 수집 시각 기록 (웹사이트 하단에 표시)
  const stamp = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd HH:mm");
  db.getRange(1, DB_HEADERS.length + 2).setValue("수집시각");
  db.getRange(2, DB_HEADERS.length + 2).setValue(stamp);

  rebuildReports();
  ss.toast(`${rows.length.toLocaleString()}건 수집 완료 (${LATEST_YEAR - SHOW_YEARS + 1}~${LATEST_YEAR})` +
           (fixed.used.length ? ` · 수동 입력 ${fixed.used.length}건 반영` : "") +
           (fixed.skipped.length ? ` · API에 생겨서 건너뛴 보정 ${fixed.skipped.length}건` : ""), "완료", 15);
}

/* ─────────────────── 보정(수동 입력) ─────────────────── */

/**
 * 보정 시트의 행을 DB에 합칩니다.
 *  - 같은 공시연도·학교코드가 API에 있으면 API 값을 쓰고 보정 행은 건너뜁니다.
 *  - 학년별 인원이 비어 있는 행은 아직 입력 전으로 보고 건너뜁니다.
 *  - 남_계·여_계·총계가 비어 있으면 학년별 인원과 기타를 더해 채웁니다.
 */
function mergeFixes_(ss, rows, seen) {
  const used = [], skipped = [];
  const sh = ss.getSheetByName(FIX_SHEET);
  if (!sh || sh.getLastRow() < 2) return { used, skipped };
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const ix = name => head.indexOf(name);
  sh.getRange(2, 1, sh.getLastRow() - 1, head.length).getValues().forEach(r => {
    const v = name => (ix(name) < 0 ? "" : r[ix(name)]);
    const num = name => Number(v(name) || 0);
    const yr = Number(v("공시연도")), code = String(v("학교코드")).trim();
    if (!yr || !code) return;
    const grades = ["1학년_남", "1학년_여", "2학년_남", "2학년_여", "3학년_남", "3학년_여"].map(num);
    if (grades.every(x => x === 0)) return;                      // 아직 숫자를 넣지 않은 행
    const key = yr + "|" + code;
    if (seen[key]) { skipped.push(v("학교명")); return; }        // API에 이미 있음
    seen[key] = true;
    const etcM = num("기타_남"), etcW = num("기타_여");
    const m = num("남_계") || grades[0] + grades[2] + grades[4] + etcM;
    const w = num("여_계") || grades[1] + grades[3] + grades[5] + etcW;
    rows.push([
      yr, String(v("시군")), String(v("시군구코드")), String(v("주소")), code, String(v("학교명")),
      String(v("학교유형")), String(v("설립")), String(v("주야") || "주간"),
      ...grades, etcM, etcW, m, w, num("총계") || m + w, FIX_SOURCE
    ]);
    used.push(v("학교명"));
  });
  return { used, skipped };
}

/** 보정 시트가 없으면 만들고 엽니다. */
function openFixSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(FIX_SHEET);
  if (!sh) {
    sh = ss.insertSheet(FIX_SHEET);
    sh.getRange(1, 1, 1, DB_HEADERS.length - 1).setValues([DB_HEADERS.slice(0, -1)])
      .setFontWeight("bold").setBackground("#7F6000").setFontColor("white");
    sh.setFrozenRows(1);
    sh.getRange(1, DB_HEADERS.length + 1).setValue(
      "API에 빠진 학교를 학교알리미 '학년별·학급별 학생수' 공시를 보고 입력하세요. 학년별 남·여만 넣으면 계는 자동 계산됩니다.");
  }
  ss.setActiveSheet(sh);
}

/* ─────────────────── 요약·시군 시트 ─────────────────── */

function readDb_() {
  const db = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DB_SHEET);
  if (!db || db.getLastRow() < 2) throw new Error("DB 시트가 비어 있습니다. 먼저 'API에서 새로 수집'을 실행하세요.");
  return db.getRange(2, 1, db.getLastRow() - 1, DB_HEADERS.length).getValues()
    .map(r => ({
      yr: Number(r[0]), city: r[1], code: r[4], name: r[5], type: r[6],
      g: [ { m: r[9],  w: r[10] }, { m: r[11], w: r[12] }, { m: r[13], w: r[14] } ],
      m: Number(r[17]), w: Number(r[18]), t: Number(r[19])
    }));
}

function rebuildReports() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const data = readDb_();
  const shown = years_().slice(0, SHOW_YEARS);
  const cities = Object.keys(REGION_MAP).sort((a, b) => a.localeCompare(b));

  // 합계 계산
  const tot = {};   // tot[city][yr] = {m,w,t,n}
  ["경기도"].concat(cities).forEach(c => { tot[c] = {}; years_().forEach(y => tot[c][y] = { m: 0, w: 0, t: 0, n: 0 }); });
  data.forEach(d => {
    [d.city, "경기도"].forEach(c => {
      if (!tot[c] || !tot[c][d.yr]) return;
      tot[c][d.yr].m += d.m; tot[c][d.yr].w += d.w; tot[c][d.yr].t += d.t; tot[c][d.yr].n += 1;
    });
  });
  const rate = (cur, prev) => (prev > 0 ? (cur - prev) / prev : "");

  /* 1) 전체 요약 시트 */
  const sum = ss.getSheetByName(SUMMARY_SHEET) || ss.insertSheet(SUMMARY_SHEET, 0);
  sum.clear(); sum.clearConditionalFormatRules();
  if (sum.getFilter()) sum.getFilter().remove();
  const sumHead = ["시·군명", "공시연도", "학교수", "남(명)", "여(명)", "계(명)", "지역 증감률(전년비)"];
  const sumRows = [];
  ["경기도"].concat(cities).forEach(c => {
    shown.forEach(y => {
      const cur = tot[c][y], prev = tot[c][y - 1];
      sumRows.push([c, y + "년", cur.n, cur.m, cur.w, cur.t, rate(cur.t, prev ? prev.t : 0)]);
    });
  });
  sum.getRange(1, 1, 1, sumHead.length).setValues([sumHead])
    .setBackground("#4472C4").setFontColor("white").setFontWeight("bold").setHorizontalAlignment("center");
  const sumRange = sum.getRange(2, 1, sumRows.length, sumHead.length);
  sumRange.setValues(sumRows).setBorder(true, true, true, true, true, true).setHorizontalAlignment("center");
  sum.getRange(2, 3, sumRows.length, 4).setNumberFormat("#,##0");
  sum.getRange(2, 7, sumRows.length, 1).setNumberFormat("0.00%");
  sum.getRange(2, 1, SHOW_YEARS, sumHead.length).setBackground("#F2F2F2").setFontWeight("bold");
  sum.setConditionalFormatRules(rateColorRules_(sum.getRange(2, 7, sumRows.length, 1)));
  sum.getRange(1, 1, sumRows.length + 1, sumHead.length).createFilter();
  sum.setFrozenRows(1);
  sum.setColumnWidth(1, 150);
  sum.setColumnWidths(2, 6, 110);

  /* 2) 시군별 상세 시트 */
  const byCitySchool = {};
  data.forEach(d => {
    byCitySchool[d.city] = byCitySchool[d.city] || {};
    const s = byCitySchool[d.city][d.code] = byCitySchool[d.city][d.code] || { name: d.name, type: d.type, yrs: {} };
    s.yrs[d.yr] = d;
    if (d.yr === LATEST_YEAR) { s.name = d.name; s.type = d.type; }   // 최신 교명 우선
  });

  cities.forEach((city, idx) => {
    const sheetName = String(idx + 1).padStart(2, "0") + "_" + city;
    const sh = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
    sh.clear(); sh.clearConditionalFormatRules();

    sh.getRange("A1:H1").merge().setFontWeight("bold")
      .setValue(`✅ ${city} 고등학교 학생수 (${shown[shown.length - 1]}~${LATEST_YEAR} 공시)`);

    // 지역 요약
    const head = ["구분(관내총합)", "공시연도", "학교수", "남(명)", "여(명)", "계(명)", "전년비 증감률"];
    const body = shown.map(y => {
      const cur = tot[city][y], prev = tot[city][y - 1];
      return [city, y + "년", cur.n, cur.m, cur.w, cur.t, rate(cur.t, prev ? prev.t : 0)];
    });
    sh.getRange(3, 1, 1, head.length).setValues([head]).setBackground("#D9E1F2").setFontWeight("bold").setHorizontalAlignment("center");
    sh.getRange(4, 1, body.length, head.length).setValues(body)
      .setBorder(true, true, true, true, true, true).setHorizontalAlignment("center");
    sh.getRange(4, 3, body.length, 4).setNumberFormat("#,##0");
    sh.getRange(4, 7, body.length, 1).setNumberFormat("0.00%");

    // 학교별 상세 (8행 머리글)
    const dHead = ["학교명", "학교유형", "공시연도", "학년구분", "남(명)", "여(명)", "계(명)", "증감률"];
    const dRows = [dHead];
    const boldRows = [];
    const schools = Object.values(byCitySchool[city] || {}).sort((a, b) => a.name.localeCompare(b.name));
    schools.forEach(s => {
      let first = true;
      shown.forEach(y => {
        const cur = s.yrs[y];
        if (!cur) return;
        const prev = s.yrs[y - 1];
        const lines = [
          ["전체합계", cur.m, cur.w, cur.t, prev ? prev.t : 0],
          ["3학년", cur.g[2].m, cur.g[2].w, cur.g[2].m + cur.g[2].w, prev ? prev.g[1].m + prev.g[1].w : 0],  // 전년 2학년 대비
          ["2학년", cur.g[1].m, cur.g[1].w, cur.g[1].m + cur.g[1].w, prev ? prev.g[0].m + prev.g[0].w : 0],  // 전년 1학년 대비
          ["1학년", cur.g[0].m, cur.g[0].w, cur.g[0].m + cur.g[0].w, 0]
        ];
        lines.forEach((l, i) => {
          if (i === 0) boldRows.push(dRows.length + 8);
          dRows.push([first ? s.name : "", first ? s.type : "", i === 0 ? y + "년 공시" : "", l[0], l[1], l[2], l[3], rate(l[3], l[4])]);
          first = false;
        });
      });
    });

    const dRange = sh.getRange(8, 1, dRows.length, dHead.length);
    dRange.setValues(dRows).setBorder(true, true, true, true, true, true).setHorizontalAlignment("center");
    sh.getRange(8, 1, 1, dHead.length).setBackground("#1F4E78").setFontColor("white").setFontWeight("bold");
    if (dRows.length > 1) {
      sh.getRange(9, 5, dRows.length - 1, 3).setNumberFormat("#,##0");
      sh.getRange(9, 8, dRows.length - 1, 1).setNumberFormat("0.00%");
    }
    if (boldRows.length) sh.getRangeList(boldRows.map(r => `A${r}:H${r}`)).setBackground("#F2F2F2").setFontWeight("bold");

    sh.setConditionalFormatRules(
      rateColorRules_(sh.getRange(4, 7, body.length, 1))
        .concat(dRows.length > 1 ? rateColorRules_(sh.getRange(9, 8, dRows.length - 1, 1)) : [])
    );
    sh.setFrozenRows(8);
    sh.setColumnWidth(1, 220);
    sh.setColumnWidth(2, 120);
    sh.setColumnWidths(3, 6, 90);
  });

  sortSheets_(ss);
  SpreadsheetApp.flush();
}

/* ───────────────────────── 보조 ───────────────────────── */

function rateColorRules_(range) {
  return [
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setFontColor("#C00000").setRanges([range]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0).setFontColor("#0070C0").setRanges([range]).build()
  ];
}

function sortSheets_(ss) {
  const sheets = ss.getSheets().slice().sort((a, b) => a.getName().localeCompare(b.getName()));
  sheets.forEach((s, i) => { ss.setActiveSheet(s); ss.moveActiveSheet(i + 1); });
  const db = ss.getSheetByName(DB_SHEET);
  if (db) { ss.setActiveSheet(db); ss.moveActiveSheet(ss.getSheets().length); }   // DB는 맨 뒤
  ss.setActiveSheet(ss.getSheets()[0]);
}
