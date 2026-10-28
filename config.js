// 웹사이트 설정 — 스프레드시트를 바꾸면 이 파일만 고치면 됩니다.
window.APP_CONFIG = {
  // 데이터 원본 스프레드시트 ID (주소의 /d/ 와 /edit 사이)
  SHEET_ID: "1jSNoE_ZDHx7MpSsSCwtGXOjPXgCFwJ-KdCkCCQQOoiU",
  // Apps Script가 원자료를 쓰는 시트 이름
  SHEET_NAME: "DB",
  // 사이트가 읽는 자료 파일. 스프레드시트에서 GitHub Actions로 만들어짐 (README 참고)
  DATA_JSON: "data/db.json",
  // 사이트 제목
  TITLE: "경기도 고등학교 학년별 학생수 추이",
  // 출처 표기
  SOURCE: "학교알리미 공시정보 Open API (학년별·학급별 학생수)"
};
