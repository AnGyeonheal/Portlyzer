# Portlyzer

실제 거래 원장을 입력하고 투자 성과를 분석하는 한국어 포트폴리오 관리 웹 애플리케이션입니다.
주식/ETF(한국·미국), 현금, 암호화폐, 사용자 정의 자산을 KRW/USD로 관리합니다.
투자 권유나 세금 신고 프로그램이 아니며, 예측값은 확정 수익이 아닙니다.

## 구성

Next.js 16 · React 19 · TypeScript · Tailwind CSS · Radix/shadcn UI 구성 요소 · Recharts ·
PostgreSQL 17 · Prisma 6 · Better Auth · Zod · Decimal.js · Vitest · Playwright.
UI/API는 단일 애플리케이션이며 원장 계산과 외부 제공자는 독립 모듈입니다.

## 빠른 시작: Docker Compose

Node.js 24 LTS와 Docker Compose가 필요합니다.

```sh
npm ci
npm run setup:local
docker compose up --build -d
```

`setup:local`은 `.env.example`을 바탕으로 임의의 개발용 비밀번호/인증 비밀키를 생성합니다.
기존 `.env`는 덮어쓰지 않습니다. 이미 설정한 경우 `POSTGRES_PASSWORD`,
`BETTER_AUTH_URL`(브라우저에서 접근할 정확한 출처)을 확인하세요.
위 기본 설정은 **http://127.0.0.1:3000**으로 접속합니다.
DB 준비 → 마이그레이션 → 웹 앱 순서로 실행됩니다. DB 볼륨은 재시작해도 유지됩니다.
`docker compose down -v`는 데이터 삭제이므로 평소 종료에는 사용하지 마세요.

```sh
docker compose logs --tail=100 app
docker compose stop
docker compose start
```

`.env`의 주소를 `localhost`로 설정했다면 브라우저도 `localhost`를 사용하세요.
`localhost`와 `127.0.0.1`은 인증/CSRF 정책에서 서로 다른 출처입니다.

## 직접 실행

```sh
npm ci
npm run setup:local
# .env의 DATABASE_URL을 사용 가능한 PostgreSQL에 맞게 설정
npm run db:migrate
npm run dev
```

Windows PowerShell에서 실행 정책으로 npm 스크립트가 차단되면 `npm.cmd`, `npx.cmd`를 사용하세요.
Docker 없이 별도 PostgreSQL 바이너리가 있다면 `PG_BIN`에 `initdb`/`pg_ctl` 디렉터리를 지정한 뒤
`npm run db:local -- start`를 사용할 수 있습니다. `PG_DATA` 기본값은 무시되는 `.local-db`이고,
기존 클러스터는 재초기화하지 않습니다. 종료는 `npm run db:local -- stop`입니다.
Node/PostgreSQL 전역 설치나 시스템 서비스를 임의 변경하지 않습니다.

## 처음 사용하는 흐름

1. 회원가입(12자 이상 비밀번호) 후 설정에서 포트폴리오와 계좌를 만듭니다.
2. 거래내역에서 수동 거래를 입력하거나 CSV/XLSX를 업로드합니다.
3. 열 매핑 → 행 검증/수정 → 중복 여부 확인 → 미리보기 → 확정을 진행합니다.
4. 설정에서 종목 시세를 입력/CSV 업로드하고, 필요하면 실제 Frankfurter/ECB 환율을 갱신합니다.
5. 기간·계좌·포트폴리오·표시 통화를 선택해 모든 분석을 확인합니다.

**시작 잔고는 입금 거래와 실제 취득 이력으로 입력하세요.** 잔고 부족을 가상 입금으로
조용히 보정하지 않습니다. 과거 거래를 삭제해 잔고가 음수가 되면 삭제가 거절됩니다.
수정 시에는 원본과 변경 이력이 남으며 이전 날짜부터 분석이 다시 계산됩니다.

범용 예시는 [거래 CSV](samples/standard-transactions.csv),
[시세 CSV](samples/standard-prices.csv), [환율 CSV](samples/standard-fx.csv)를 제공합니다.
예제의 모든 가격/환율은 **테스트용 가정값**이며 실제 시장 데이터가 아닙니다.
USD 계좌에 거래와 시세 예제를 입력하고 2025-01-02~2025-01-07/USD를 선택하면
현금 3,802.25 + 주식 7×210 = **5,272.25 USD**, 순입금 5,000 USD,
총손익 **272.25 USD**가 됩니다. 업로드된 새 종목의 기본 유형은 주식이며
ETF/암호화폐/사용자 정의 자산은 사전에 종목을 만들거나 분류를 수정하세요.

실제 샘플을 검증하지 않은 국내 증권사 전용 파서는 지원한다고 표시하지 않습니다.

## 데모와 샘플 DB

로그인 화면의 데모 버튼은 **별도 사용자·세션·데이터**를 만듭니다. 실제 계정에
데모 거래를 넣지 않으며 외부 데이터 장애를 데모로 대체하지 않습니다.
데모에는 항상 배너가 표시됩니다. 운영에서 필요 없으면 `ENABLE_DEMO=false`로 설정하세요.

고정된 데모 계정이 필요한 경우 서버 환경변수에 `SEED_DEMO_EMAIL`,
`SEED_DEMO_PASSWORD`(12자 이상)를 설정한 뒤 `npm run db:seed`를 실행합니다.
일반 사용자는 seed 대상이 될 수 없고, 이미 생성된 데모 거래를 덮어쓰지 않습니다.
비밀번호를 저장소나 셸 기록에 남기지 마세요.

## 데이터 제공자

- **Frankfurter / ECB**: 키 없는 실제 일별 USD/KRW 기준 환율. 관측일·출처·가져온 시각을 저장합니다.
- **Alpha Vantage**: 선택적 미국 주식/ETF 일별 원시 종가. 서버 API 키와 적절한 사용 권리 확인이 필요합니다.
  `ALPHA_VANTAGE_LICENSE_ACK=true`는 권한을 발급하지 않으며 운영자가 권리를 확인했다는 설정입니다.
- **수동 입력/CSV**: 한국 주식, 암호화폐, 사용자 자산, 과거 시세·환율 보완.
- **데모**: 분리된 예제 데이터. 실제 시세가 아닙니다.

무료 실시간/정확성/가용성 또는 모든 시장의 완전한 과거 이력을 보장하지 않습니다.
설정과 약관/출처/지원 범위는 [데이터 제공자 문서](docs/DATA_PROVIDERS.md)를 확인하세요.

## 검증 명령

```sh
npm run typecheck
npm run lint
npm run test:unit
# 별도의 테스트 DB에 마이그레이션한 후 RUN_INTEGRATION=1 설정
npm run test:integration
npm run build
npx playwright install chromium
npm run test:e2e
```

통합 테스트는 `RUN_INTEGRATION=1`일 때만 실제 DB를 사용합니다.
테스트별 임시 사용자만 정리하며 전체 DB 초기화 명령은 없습니다.
실제 실행 결과와 미실행 검증을 [완료 보고서](docs/DELIVERY.md)에 구분합니다.

재시작 검증은 첫 E2E 이후 앱 프로세스를 실제 종료/재시작하고
`RUN_RESTART_PROBE=1`로 `npx playwright test restart.spec.ts`를 별도 실행합니다.
CI에서는 두 Playwright 실행 사이에 관리되는 웹 서버가 종료되므로 새 프로세스에서 검증합니다.
현재 작업의 최종 결과는 **401개 단위·통합·라이브 테스트, 2개 E2E, 별도 재시작 E2E 1개 통과**입니다.

## 문서

- [공개 기능 조사 및 대응표](docs/FEATURE_MATRIX.md)
- [아키텍처/설계 선택](docs/ARCHITECTURE.md)
- [금융 계산 정책](docs/CALCULATION_POLICY.md)
- [제공자 설정과 이용 조건](docs/DATA_PROVIDERS.md)
- [운영과 배포](docs/OPERATIONS.md)
- [구현 상태, 검증 결과, 남은 작업](docs/DELIVERY.md)