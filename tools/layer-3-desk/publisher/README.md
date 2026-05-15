# Layer 3 · Publisher (발행)

> 최종 발행 에이전트. Gmail·Notion·GitHub Pages 세 채널로 리포트를 발송한다.

## 한 줄 역할

설계된 HTML을 메일 본문(Gmail) + 아카이브(Notion) + 정적 페이지(GitHub Pages)로 동시 발행하고 중복 발송을 방지한다.

## 진입점

```js
import { publish } from './layer-3-desk/publisher/index.js';
const result = await publish(date, html, desktopData, outputDir, reportUrl, tfResults, editorialPlan);
```

## 입력

| 인자 | 설명 |
|------|------|
| `date` | YYYY-MM-DD |
| `html` | `buildHtml()` 결과 (GitHub Pages 발행용) |
| `data` | orchestrator의 desktopData (메일 카드 빌드용) |
| `outputDir` | flag 파일 저장 경로 |
| `reportUrl` | GitHub Pages URL ("전체 보기" CTA용) |
| `tfResults`, `editorialPlan` | 메일 카드용 |

## 출력

```ts
{
  skipped: boolean,        // 이미 발송됨이면 true
  reason?: 'local_flag' | 'notion_db',
  sentAt?: string,
  gmailSent: boolean,
  notionArchived: boolean,
}
```

## 채널 (`channels/`)

| 파일 | 역할 |
|------|------|
| `channels/gmail.js` | nodemailer + Gmail 앱 비밀번호 |
| `channels/notion.js` | Notion SDK, 아카이브 DB에 페이지 생성 |

## 중복 발송 방지

| 환경 | 메커니즘 |
|------|---------|
| **로컬** | `outputs/{date}/sent.flag`·`gmail.flag`·`notion.flag` 파일 존재 검사 |
| **GA** | 위 + Notion DB 날짜 조회 (워크스페이스 휘발성 대응) |

각 채널마다 별도 flag — Gmail은 됐는데 Notion만 실패하면 다음 실행에서 Notion만 재시도.

## 실패 처리

- Gmail 실패 → throw (필수 채널이므로 발송 끊김 알림)
- Notion 실패 → warn, Gmail은 그대로 완료 처리. 다음 실행에서 Notion만 재시도.
- GitHub Pages는 워크플로우 외부 단계(`peaceiris/actions-gh-pages`)에서 별도 처리.

## 환경 변수

```
GMAIL_SENDER, GMAIL_APP_PASSWORD, GMAIL_RECIPIENT
NOTION_API_KEY, NOTION_ARCHIVE_DB_ID
PAGES_BASE_URL
```

## 발전 기록

- 2026-05-13: 단계별 flag 분리 (gmail.flag/notion.flag) — 한쪽만 재시도 가능.
- 2026-05-12: 중복 발송 방지 이중화 (로컬 flag + Notion DB).
