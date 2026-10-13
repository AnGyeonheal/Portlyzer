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

### 현재 Windows 환경: 운영용 실행

프로젝트 전용 Node 24와 PostgreSQL을 준비한 환경에서는 아래 명령만 사용하면 됩니다.
PowerShell 실행 정책 변경 없이 `.cmd` 진입점이 프로젝트의 Node를 우선 선택합니다.

```powershell
.\portlyzer.cmd start
# 다른 터미널에서
.\portlyzer.cmd status
.\portlyzer.cmd check
.\portlyzer.cmd backup
.\portlyzer.cmd stop
```

`start`는 DB 시작 → 마이그레이션 → 빌드 → **standalone 운영 서버** → 상태 확인 순서입니다.
기본 접속 주소는 **http://127.0.0.1:3000**이며 시작한 터미널을 열어 두세요.
이미 검증한 빌드를 재사용할 때만 `start --skip-build`를 사용합니다.
종료 명령은 인증된 로컬 제어 채널로 이 실행기가 만든 앱만 중지한 뒤 지정한 로컬 DB를 종료합니다.
다른 서버를 포트나 프로세스 이름으로 일괄 종료하지 않습니다. 자동 부팅/OS 서비스 등록은 하지 않습니다.

별도 PostgreSQL을 사용하는 일반 환경에서는 `npm run build` 후 `npm run start`를 사용합니다.
`build`의 후처리는 정적 파일을 standalone에 포함하고 복사된 환경 파일을 제거합니다.
`start`는 개발 서버가 아니라 이 산출물을 실행합니다. 개발할 때만 `npm run dev`를 사용하세요.

### 백업과 계정 복구

- `.\portlyzer.cmd backup`: AES-256-GCM 암호화 DB 백업을 `.backups`에 생성합니다.
- 기본 키는 `.local-state\backup.key`에 생성됩니다. **백업 파일과 키를 서로 다른 안전한 장소에 보관**하세요.
  키를 잃으면 복구할 수 없습니다. 운영자는 `BACKUP_PASSPHRASE`를 비밀 관리 도구에서 주입할 수도 있습니다.
- 복원은 `.\portlyzer.cmd restore --file ".backups\YOUR_BACKUP.pbackup" --database portlyzer_restore_check`처럼
  **새 DB에만** 가능합니다. 기존 DB 덮어쓰기나 초기화는 하지 않습니다.
- 설정의 **계정·보안**에서 비밀번호 변경 및 비밀번호 재확인 후 계정 영구 삭제를 제공합니다.
- 이메일 인증/비밀번호 재설정은 SMTP 설정 후 활성화됩니다. 기본 로컬 모드에서는 메일 버튼을 숨깁니다.
  공개 모드는 HTTPS·DB TLS·메일·이메일 인증이 없으면 시작을 거절합니다.

메일 설정, 복원 전환, 정기 백업/갱신 및 배포 체크리스트는 [운영 문서](docs/OPERATIONS.md)를 따르세요.

## 처음 사용하는 흐름

1. 회원가입(12자 이상 비밀번호) 후 설정에서 포트폴리오와 계좌를 만듭니다.
2. **거래 내역 → 파일 가져오기**에서 빈 표준 엑셀 양식을 내려받아 작성합니다.
3. 계좌 선택 → **엑셀 업로드·검증** → 행 수정/중복 확인 → 미리보기 → 확정을 진행합니다.
   표준 양식의 열은 자동으로 연결됩니다. 수동 거래 추가와 일반 CSV/XLSX 열 매핑도 유지합니다.
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

### 거래 입력 형식

기본 방식은 **표준 XLSX 양식 v1**입니다. 한국어 열 이름, 거래 유형/통화 선택 목록과 입력 안내가
있으며 예시 거래를 넣지 않은 빈 파일입니다. 거래일·거래 유형·통화는 모든 행에 필요합니다.
매수·매도에는 종목 코드/거래소/수량/단가, 입출금에는 금액을 입력합니다.
배당은 세전 금액과 세금을 분리합니다. 사용하지 않는 열은 비우고 이름·순서는 유지하세요.

파일 하나는 선택한 계좌 하나에 반영하며 최대 2 MiB·2,000건입니다.
입력 셀을 텍스트 형식으로 유지해 종목 코드 앞자리 0과 소수 정밀도를 보존합니다.
양식 마지막의 빈 서식 행은 무시하지만 중간 빈 행은 검증/제외 대상으로 남깁니다.
자세한 열 순서, 거래별 필수값, 이체/환전 방법은 [엑셀 작성 안내](docs/IMPORT_TEMPLATE.md)를 참고하세요.

## 데모와 샘플 DB

로그인 화면의 데모 버튼은 **별도 사용자·세션·데이터**를 만듭니다. 실제 계정에
데모 거래를 넣지 않으며 외부 데이터 장애를 데모로 대체하지 않습니다.
데모에는 항상 배너가 표시됩니다. 연초/최근 1년 조회와 시작일 전일의 벤치마크까지
합성 관측치를 제공합니다. 공개 모드의 이메일 인증을 활성화할 때는 `ENABLE_DEMO=false`로 설정하세요.

고정된 데모 계정이 필요한 경우 서버 환경변수에 `SEED_DEMO_EMAIL`,
`SEED_DEMO_PASSWORD`(12자 이상)를 설정한 뒤 `npm run db:seed`를 실행합니다.
일반 사용자는 seed 대상이 될 수 없고, 이미 생성된 데모 거래를 덮어쓰지 않습니다.
기존 데모에 seed를 다시 실행하면 빠진 DEMO 관측치만 보충하며 원장과 기존 관측값은 보존합니다.
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

통합 테스트와 E2E는 `RUN_INTEGRATION=1`일 때만 실제 DB를 사용합니다.
테스트별 임시 사용자만 정리하며 전체 DB 초기화 명령은 없습니다.
실제 실행 결과와 미실행 검증을 [완료 보고서](docs/DELIVERY.md)에 구분합니다.
백업 복원 테스트는 `portlyzer_test` 또는 `portlyzer_test_...` 이름의 전용 DB에
`RUN_BACKUP_TESTS=1`도 지정해야 합니다. 일반 사용자 DB로 E2E를 실행하지 마세요.
`RUN_MAIL_E2E=1`로 E2E를 별도 실행하면 외부 발송 없이 로컬 SMTP 수신기로
이메일 인증·재설정·실패 처리·계정 탈퇴를 검사합니다.

재시작 검증은 첫 E2E 이후 앱 프로세스를 실제 종료/재시작하고
`RUN_RESTART_PROBE=1`로 `npx playwright test restart.spec.ts`를 별도 실행합니다.
Playwright는 실행 중인 사용자 서버를 재사용하지 않고 별도 서버를 소유·종료합니다.
두 실행 사이에 실제 프로세스가 바뀌며, 최신 테스트 수와 결과는 완료 보고서를 기준으로 합니다.

## 문서

- [공개 기능 조사 및 대응표](docs/FEATURE_MATRIX.md)
- [아키텍처/설계 선택](docs/ARCHITECTURE.md)
- [금융 계산 정책](docs/CALCULATION_POLICY.md)
- [제공자 설정과 이용 조건](docs/DATA_PROVIDERS.md)
- [운영과 배포](docs/OPERATIONS.md)
- [구현 상태, 검증 결과, 남은 작업](docs/DELIVERY.md)
- [거래내역 엑셀 양식 작성 안내](docs/IMPORT_TEMPLATE.md)