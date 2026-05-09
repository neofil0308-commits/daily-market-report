# GitHub 설정 가이드 (컴퓨터 꺼져도 자동 실행)

## 1단계 — GitHub 저장소 만들기

1. https://github.com 에서 **New repository** 클릭
2. Repository name: `daily-market-report` (원하는 이름)
3. **Private** 선택 (API 키 코드 보호)
4. **Create repository** 클릭

---

## 2단계 — 코드 올리기 (처음 1회만)

이 폴더에서 PowerShell 열고 아래 명령어 실행:

```powershell
cd "c:\Users\neofi\content report"

git init
git add .
git commit -m "init: daily market report"
git remote add origin https://github.com/[계정명]/[저장소명].git
git push -u origin main
```

> `.env` 파일은 `.gitignore`에 등록되어 있어 **자동으로 제외**됩니다.

---

## 3단계 — GitHub Secrets 등록 (API 키)

저장소 페이지 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

아래 목록을 하나씩 등록하세요:

| Secret 이름 | 값 (.env 파일 참조) |
|---|---|
| `GOOGLE_API_KEY` | .env의 GOOGLE_API_KEY 값 |
| `BOK_API_KEY` | .env의 BOK_API_KEY 값 |
| `NAVER_CLIENT_ID` | .env의 NAVER_CLIENT_ID 값 |
| `NAVER_CLIENT_SECRET` | .env의 NAVER_CLIENT_SECRET 값 |
| `NOTION_API_KEY` | .env의 NOTION_API_KEY 값 |
| `NOTION_PAGE_ID` | .env의 NOTION_PAGE_ID 값 |
| `NOTION_ARCHIVE_DB_ID` | `4011a9c5b6d6472b9f535fefc02964ff` |
| `GMAIL_SENDER` | .env의 GMAIL_SENDER 값 |
| `GMAIL_APP_PASSWORD` | .env의 GMAIL_APP_PASSWORD 값 |
| `GMAIL_RECIPIENT` | .env의 GMAIL_RECIPIENT 값 |
| `GITHUB_PAGES_BASE` | 4단계 완료 후 입력 |

---

## 4단계 — GitHub Pages 활성화

1. 저장소 → **Settings** → **Pages**
2. **Source**: `Deploy from a branch`
3. **Branch**: `gh-pages` / `/ (root)`
4. **Save** 클릭
5. 주소 확인: `https://[계정명].github.io/[저장소명]`

그 주소를 3단계의 `GITHUB_PAGES_BASE` Secret으로 등록:
- 예: `https://neofi.github.io/daily-market-report`

---

## 5단계 — 첫 수동 실행 테스트

저장소 → **Actions** → **Daily Market Report** → **Run workflow** → **Run workflow**

- ✅ 초록 체크: 정상 작동
- Gmail 수신 확인
- Notion "📁 리포트 아카이브" 데이터베이스에 행 추가 확인
- `https://[계정명].github.io/[저장소명]/outputs/YYYY-MM-DD/report.html` 접속 확인

---

## 자동 실행 일정

| 요일 | KST | UTC |
|---|---|---|
| 월~금 | 08:00 | 23:00 (전날) |

GitHub Actions 서버가 실행하므로 **PC가 꺼져 있어도 자동 발송**됩니다.

---

## 이후 코드 수정 시 반영 방법

```powershell
cd "c:\Users\neofi\content report"
git add .
git commit -m "update: 수정 내용"
git push
```

push 하는 순간 다음 실행부터 자동 반영됩니다.
