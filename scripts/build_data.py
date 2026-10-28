#!/usr/bin/env python3
"""스프레드시트 'DB' 시트를 웹사이트용 data/db.json 으로 변환합니다.

사용법
  python scripts/build_data.py                 # config.js의 시트에서 바로 받아 변환
  python scripts/build_data.py 내려받은.csv     # 로컬 CSV로 변환

시트가 '링크가 있는 모든 사용자: 뷰어'로 공유되어 있어야 합니다.
표준 라이브러리만 사용합니다.
"""
import csv, io, json, re, sys, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "db.json"

COLUMNS = [
    "공시연도", "시군", "시군구코드", "주소", "학교코드", "학교명", "학교유형", "설립", "주야",
    "1학년_남", "1학년_여", "2학년_남", "2학년_여", "3학년_남", "3학년_여",
    "기타_남", "기타_여", "남_계", "여_계", "총계", "자료출처",
]
NUMERIC = {"공시연도"} | {c for c in COLUMNS if c.endswith(("_남", "_여", "_계")) or c == "총계"}


def sheet_config():
    js = (ROOT / "config.js").read_text(encoding="utf-8")
    sid = re.search(r'SHEET_ID:\s*"([^"]+)"', js).group(1)
    name = re.search(r'SHEET_NAME:\s*"([^"]+)"', js).group(1)
    return sid, name


def fetch_sheet_csv():
    sid, name = sheet_config()
    url = (f"https://docs.google.com/spreadsheets/d/{sid}/gviz/tq?tqx=out:csv&headers=1"
           f"&sheet={urllib.parse.quote(name)}")
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read().decode("utf-8")


def to_int(v):
    v = str(v).replace(",", "").strip()
    return int(float(v)) if v else 0


def build(text):
    table = [r for r in csv.reader(io.StringIO(text)) if any(c.strip() for c in r)]
    head = [h.strip() for h in table[0]]
    missing = [c for c in COLUMNS if c not in head and c != "자료출처"]
    if missing:
        sys.exit(f"DB 시트에 필요한 열이 없습니다: {missing}")
    ix = {c: head.index(c) for c in COLUMNS if c in head}
    stamp = ""
    if "수집시각" in head and len(table) > 1:
        stamp = table[1][head.index("수집시각")].strip()

    rows, seen = [], set()
    for r in table[1:]:
        r = r + [""] * (len(head) - len(r))
        get = lambda c: r[ix[c]].strip() if c in ix else ""
        if not get("공시연도") or not get("학교코드"):
            continue
        key = (get("공시연도"), get("학교코드"))
        if key in seen:
            sys.exit(f"같은 연도·학교코드가 두 번 있습니다: {key}")
        seen.add(key)
        rows.append([to_int(get(c)) if c in NUMERIC else get(c) for c in COLUMNS])

    # 간단한 검산: 학년별 + 기타 = 총계
    bad = [r[5] for r in rows if sum(r[9:17]) != r[19]]
    if bad:
        print(f"주의: 학년 합계와 총계가 다른 학교 {len(bad)}곳 (예: {bad[:3]})", file=sys.stderr)

    rows.sort(key=lambda r: (-r[0], r[1], r[5]))
    years = sorted({r[0] for r in rows}, reverse=True)
    return {
        "meta": {"source": "학교알리미 공시정보 Open API (apiType 63) + 수동 보정",
                 "collected": stamp, "years": years, "count": len(rows)},
        "columns": COLUMNS,
        "rows": rows,
    }


def main():
    text = Path(sys.argv[1]).read_text(encoding="utf-8-sig") if len(sys.argv) > 1 else fetch_sheet_csv()
    data = build(text)
    new = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    old = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
    if old == new:
        print("변경 없음")
        return
    OUT.write_text(new, encoding="utf-8")
    m = data["meta"]
    print(f"db.json 갱신: {m['count']}건, 연도 {m['years']}, 수집 {m['collected']}")


if __name__ == "__main__":
    main()
