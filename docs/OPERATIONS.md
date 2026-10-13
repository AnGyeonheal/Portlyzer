# 운영 및 배포

## 배포 전 필수 설정

1. 신뢰할 수 있는 PostgreSQL과 TLS, 백업/복구 절차를 준비한다.
2. `BETTER_AUTH_SECRET`, DB 비밀번호를 각각 충분히 긴 난수로 설정한다.
   `.env`는 저장소/이미지/클라이언트 번들에 포함하지 않는다.
3. `BETTER_AUTH_URL`은 실제 HTTPS 공개 출처로 지정한다.
   개발용 루프백 URL과 운영 URL을 혼용하지 않는다.
4. 외부 주가 사용/재배포 권한을 확인한다. 개인 API 키만으로 다중 사용자 서비스 권리가
   생기지 않는다. [제공자 문서](DATA_PROVIDERS.md)의 이용 조건을 확인한다.
5. 필요 없으면 `ENABLE_DEMO=false`로 설정한다. 데모 계정도 DB 공간을 소비하므로
   수명 정책을 정하되, 일반 사용자와 구별 없이 삭제하지 않는다.
6. SMTP 발신 계정/도메인을 설정하고 실제 메일 수신을 확인한다. 이메일 인증, 비밀번호
   복구/변경, 다른 세션 해제, 본인 비밀번호 재확인 후 탈퇴는 구현되어 있다.
   MFA, 조직별 운영 알림 수신처와 법적 개인정보 처리방침은 별도 운영 결정 사항이다.

## 배포 전 검사와 실행

- `npm run build`: Next standalone 빌드, 정적 파일 포함, 복사된 `.env*` 제거.
- `npm run start -- --port 3000`: 준비된 standalone 실행. 기본 바인딩은 루프백이다.
- `npm run check:readiness`: 환경 설정, 준비된 빌드 ID, DB 연결, 마이그레이션 완료/체크섬 확인.
- `npm run check:readiness -- --public`: 공개용 필수 설정까지 검사한다. 설정 검사 통과는
  DNS/HTTPS 프록시, 실제 메일 발송, 백업 운영, 데이터 라이선스 검증을 대신하지 않는다.

`APP_MODE=local`은 루프백 출처만 허용한다. `APP_MODE=public`은 비루프백 HTTPS 출처,
PostgreSQL TLS(`sslmode=verify-full` 권장), SMTP 및 `AUTH_REQUIRE_EMAIL_VERIFICATION=true`를
요구한다. 구성 오류는 서버 시작 시 종료 원인으로 표시되며 비밀값 자체는 출력하지 않는다.
DB/인증/메일 비밀값은 운영 환경에서 새로 발급해 런타임에 주입한다.
로컬 환경 파일이나 백업 키를 standalone/Docker 산출물에 넣지 않는다.

기본 `compose.yaml`은 루프백 개발/개인 사용용 앱과 비 TLS 로컬 DB를 묶은 구성이다.
공개 모드에서 이 DB 설정을 그대로 쓰면 시작 검사가 거절한다. 관리형 TLS DB를 사용하는
배포에서는 migrator/runner 이미지를 각각 만들고 운영 환경 파일을 주입해 사용할 수 있다.
아래는 실행 예시이며 이 저장소 작업에서 공개 배포를 실행했다는 의미가 아니다.

```sh
docker build --target migrator -t portlyzer-migrate .
docker build --target runner -t portlyzer .
docker run --rm --env-file .env portlyzer-migrate
docker run --name portlyzer --env-file .env -p 127.0.0.1:3000:3000 portlyzer
```

이때 환경 파일의 `APP_MODE=public`, HTTPS 출처, TLS `DATABASE_URL`과 SMTP 설정을 먼저
완성한다. 호스트의 HTTPS 프록시를 3000 포트로 연결하고 프로세스 재시작/비밀 주입/백업
일정은 배포 플랫폼에서 관리한다. Compose의 DB URL 덮어쓰기와 혼동하지 않는다.

### Windows 로컬 실행기

프로젝트 루트에서 `.\portlyzer.cmd start`를 실행한다. `.local-tools`의 Node 24를 우선 사용하며
PostgreSQL 도구는 `PG_BIN` 또는 `.local-tools\pgsql\bin`에서 찾는다.
DB 시작/마이그레이션/빌드/상태 확인이 포함되며 `start --skip-build`는 기존 빌드 재사용용이다.
`status`, `check`, `backup`, `restore --file FILE --database NEW_NAME`, `stop`도 제공한다.
안정된 Node가 PATH에 있으면 `npm run local:start`, `local:status`, `local:stop`도 가능하다.
이 프로세스 제어기는 Windows용이며 다른 OS는 Compose 또는 개별 npm/DB 명령을 사용한다.

시작 터미널은 서버가 끝날 때까지 유지된다. 다른 터미널의 `stop`은 비밀 토큰을 사용하는
로컬 named pipe로 실행기 자신이 만든 자식 프로세스만 종료한다. 토큰은 무시되는
`.local-state`에 저장하며 웹 API로 노출하지 않는다. 중복 실행과 잘못된 토큰은 거절한다.
프로세스 이름/PID 재사용을 근거로 다른 프로그램을 종료하지 않는다.
터미널 강제 종료 후 제어 채널이 사라졌다면 `start`가 같은 프로젝트의 오래된 상태를 회수한다.
앱을 먼저 Ctrl+C로 끝낸 뒤 DB만 종료하려면 `npm run db:local -- stop`을 사용한다.
PowerShell 실행 정책, Windows 서비스, 자동 부팅 설정은 변경하지 않는다.

## 이메일과 계정 수명

환경 설정 예시의 빈 항목을 실제 발신 서비스 값으로 설정한다.

```text
MAIL_ENABLED=true
AUTH_REQUIRE_EMAIL_VERIFICATION=true
ENABLE_DEMO=false
MAIL_FROM=no-reply@YOUR_VERIFIED_DOMAIN
SMTP_HOST=YOUR_SMTP_HOST
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=YOUR_SMTP_USER
SMTP_PASSWORD=INJECT_FROM_SECRET_MANAGER
```

587은 STARTTLS, 465는 `SMTP_SECURE=true`를 사용한다. 원격 SMTP는 TLS를 필수로 요구하고
인증서 검증을 끄지 않는다. 평문 SMTP는 로컬 테스트 수신기에만 허용된다.
운영 발신 도메인의 SPF/DKIM/DMARC와 공급자 발송 제한도 설정한다.
메일 설정이 없으면 복구 UI를 숨기며 데모 비활성화 시 데모 버튼도 표시하지 않는다.

가입 후 메일 인증 전에는 세션을 만들 수 없다. 미인증 사용자가 로그인하면 새 인증 메일을
요청한다. 인증/재설정 링크 유효 기간은 1시간이다. 재설정 토큰은 재사용할 수 없고 재설정 후
모든 세션을 폐기한다. 일반 비밀번호 변경은 현재 세션만 유지하고 다른 세션을 폐기한다.
익명 인증 쓰기 요청에도 정확한 Origin과 요청 제한을 적용한다.
메일 실패는 사고 ID와 종류만 기록하고 HTTP 503으로 알린다. 라이브러리가 내부 전송 예외를
흡수해도 요청별 컨텍스트가 실패를 보존한다. 이메일/비밀번호/토큰/SMTP 응답 전문은 로그에 남기지 않는다.
메일 발송 실패 후 가입 기록이 남았다면 로그인 화면에서 다시 인증 메일을 요청한다.
프록시 접근 로그에도 인증 URL의 토큰/쿼리가 남지 않도록 수집 정책을 적용한다.

탈퇴는 이메일 재입력/영구 삭제 동의/현재 비밀번호를 요구한다. 서버도 비밀번호 없는 삭제를
거절하며 본인 사용자에 연결된 데이터만 DB 외래키 cascade로 제거한다.
다른 사용자의 데이터는 보존한다. 거래 한 건의 삭제는 여전히 감사 이력이 남는 논리 삭제다.
운영 백업의 보존 기간과 탈퇴 후 백업 만료 정책은 개인정보 처리방침에 별도 고지한다.

## 실행 구조

- `Dockerfile`: Node 24 다단계 빌드, 비루트 런타임, Next standalone.
- `compose.yaml`: PostgreSQL 영속 볼륨, healthcheck, 일회성 migration 서비스, 웹 앱.
- `/api/health`: 인증 없이 DB 연결 가용성만 반환하며 상세 스키마/오류는 노출하지 않는다.
- `deploy/Caddyfile`: 별도 리버스 프록시에 사용할 HTTPS 설정 예시. `APP_HOST`와
  네트워크/DNS를 운영자가 구성해야 한다. 이 저장소 작업에서 공개 배포는 수행하지 않았다.
- CI: PostgreSQL 기반 타입/린트/단위·통합/빌드/Chromium E2E.
  메일 E2E, 별도 DB 복원, Compose 빌드·기동 smoke job도 포함한다. 원격 CI 및 Docker의
  실제 실행 여부는 완료 보고서에서 구분하며 YAML 구성만으로 통과를 주장하지 않는다.
  Ubuntu 24.04 러너의 기본 PostgreSQL 클라이언트는 16이므로, CI는 17 클라이언트가
  없을 때 공식 서명된 PGDG 저장소에서 설치해 17 서버 백업의 버전 불일치를 방지한다.

운영 마이그레이션은 배포 전 백업 후 `npm run db:migrate`로 적용한다.
`prisma db push`, DB 재생성, 볼륨 삭제를 운영 배포 절차로 사용하지 않는다.
인스턴스 수를 늘리기 전 연결 풀, 업로드/분석 부하, 프록시 IP 신뢰 정책을 점검한다.

## 데이터 및 감사

거래 원본/수정 이력을 별도 보존하고 삭제 거래는 논리 삭제한다.
분개/기업행동 인덱스는 현재 유효 거래에서 재생성된다. API 읽기와 쓰기는 소유자 ID를
조건에 포함한다. 사용자 내보내기에는 본인의 원본/수정/원장/가격/환율/일정/목표가
포함되지만 비밀번호 해시, 세션 토큰, 인증 제공자 토큰은 포함하지 않는다.

비어 있지 않은 계좌는 감사 이력 보존을 위해 삭제가 제한된다. 포트폴리오 삭제는
계좌와 거래를 없애지 않고 분류 연결을 해제한다. 일반/ISA/연금은 메타데이터이며
검증되지 않은 세율/공제 규칙을 적용하지 않는다.

원장·업로드 내용을 일반 로그에 쓰지 않는다. 서버 오류는 종류와 사고 ID만 기록한다.
제공자 실패는 사용자별 작업에 출처/오류 코드/시간을 저장한다. 실제 개인정보가 담긴
사용자 DB를 CI 테스트 데이터나 실패 스크린샷 생성에 사용하지 않는다.

## 인증/요청 제한

Better Auth의 DB 세션, httpOnly/sameSite 쿠키, 암호 해시와 DB 기반 인증 요청 제한을 사용한다.
쓰기 API는 정확한 Origin을 요구하며 별도의 사용자별 분당 제한을 적용한다.
임의 `userId`를 본문에서 받아 권한으로 사용하지 않는다.
업로드는 실제 스트림 크기, 파일 형식/행 수, XLSX 압축 해제 예산을 검사한다.
권한 검사와 원장 변경은 DB 트랜잭션 안에서도 다시 수행한다.

사용하지 않는 만료 세션, 인증/API 제한 버킷, 오래된 실패 작업의 보존 기간을 정한다.
정리 작업은 **종류·기준일·소유 범위가 명시된 운영 작업**으로 수행하고 원장/원본을
편의상 함께 삭제하지 않는다. 자동 전체 사용자 데이터 삭제는 구현하지 않는다.

## 갱신 작업

사용자별/기간별 외부 데이터 갱신은 UI 또는 `npm run data:refresh` CLI로 실행한다.
실행 방법은 [제공자 문서](DATA_PROVIDERS.md)에 있다.
외부 스케줄러/OS 작업 스케줄러에서 명시한 사용자만 대상으로 실행할 수 있다.
요청 캐시, 호출 예산, 중복 실행 방지와 실패 기록은 서비스 계층에 있다.
공개 인증 우회 cron 엔드포인트를 제공하지 않는다.
매일 실행할 작업에는 `npm run data:refresh -- --user-id USER_ID --provider FRANKFURTER --days 7`을
사용할 수 있다. UTC 기준 최근 7일이며 고정 `--from`/`--to`와 혼용하지 않는다.
실패 작업은 설정 화면에 보존되고 CLI 종료 코드 1(실패), 2(이미 실행 중)를 스케줄러가 감시해야 한다.

시세를 찾지 못한 날은 0원이 아니다. 마지막 관측값의 허용 유효 기간, 경고 및 계산
불가 처리는 [계산 정책](CALCULATION_POLICY.md)을 따른다. 수동 관측값은 갱신 시
덮어쓰지 않고 별도 출처로 보존한다. 수동 값이 같은 날짜의 자동 값보다 우선한다.

## 백업/복구와 확인

PostgreSQL 논리 백업(`pg_dump`) 또는 관리형 DB의 시점 복구를 사용하고 주기적으로
별도 DB 복원을 검증한다. 새 DB에 마이그레이션/복구한 뒤 사용자 로그인,
원장 개수, 가격/환율 기준일, 샘플 NAV, 내보내기, 사용자 격리를 확인한다.
백업에는 민감한 증권내역이 있으므로 접근 통제/암호화/보존 기한을 적용한다.

### 암호화 백업과 새 DB 복원

```powershell
.\portlyzer.cmd backup
.\portlyzer.cmd restore --file ".backups\YOUR_BACKUP.pbackup" --database portlyzer_restore_check
```

동일 기능의 플랫폼 독립 CLI는 `npm run db:backup -- --output PATH`와
`npm run db:restore -- --file PATH --database NEW_NAME`이다. PostgreSQL 17 이상 클라이언트와
저장소의 관리 도구 의존성이 필요하며 최소 standalone 웹 이미지 안에서 실행하는 명령은 아니다.
`pg_dump`의 일관된 스냅샷을 AES-256-GCM으로 암호화하며 비밀번호는 자식 프로세스 환경으로만 전달한다.
기존 백업 파일과 DB를 덮어쓰지 않는다. 잘못된 키/손상된 파일은 DB 생성 전에 거절한다.
복원은 새 DB를 만든 뒤 단일 트랜잭션으로 수행하며, 실패한 새 DB는 조사할 수 있도록 남겨 둔다.
원본 DB는 건드리지 않는다. 임시 복호화 파일은 성공/실패 종료 경로에서 제거한다.

키는 `BACKUP_PASSPHRASE`(32자 이상), 또는 `BACKUP_KEY_FILE`(기본 `.local-state\backup.key`)에서
읽는다. 별도 설정이 없으면 첫 백업 시 난수 키를 생성한다. 키 내용은 출력하지 않는다.
백업과 키를 분리해 접근 통제된 오프라인 장소에 보관하고 로컬 폴더 ACL/디스크 암호화도 점검한다.
`.backups`, `.local-state`, `*.pbackup`은 Git/Docker/린트 대상에서 제외된다.
백업 파일과 기존 인증 비밀키를 함께 보존해야 세션까지 동일하게 복구할 수 있다.
설정의 사용자 JSON 내보내기는 비밀번호/세션을 제외하며 DB 전체 복원 기능과 다르다.

복원 검증 후 실제 전환은 앱 종료 → 운영자가 `DATABASE_URL`을 검증한 새 DB로 변경 →
`db:migrate`/`check:readiness` → 앱 재시작 순서다. 이전 DB 삭제는 자동으로 수행하지 않는다.
정기 백업은 OS 작업 스케줄러에서 저장소를 작업 디렉터리로 지정하고 `portlyzer.cmd backup`을
호출하도록 설정할 수 있다. 실패 종료 코드를 감시하고 일정 기간마다 별도 DB 복원을 실행한다.
스케줄/보존 기간은 운영자가 결정하며 자동 등록이나 무차별 오래된 백업 삭제는 하지 않는다.

## 의존성

lockfile을 사용하며 `npm ci`로 재현한다. 필요한 설치 스크립트만 `allowScripts`에
명시한다. CSV 파서의 프로토타입 관련 수정이 포함된 7.0.3 이상을 사용한다.
Prisma 설정의 `deepmerge-ts`와 ExcelJS의 `uuid`는 호환되는 패치 버전으로 좁게
override했으며 Prisma 생성 및 XLSX 테스트로 호환성을 검증한다.
`npm audit fix --force`로 Prisma/ExcelJS를 임의 다운그레이드하지 않는다.

Prisma Client는 설치 후 생성한다. 스키마를 수정하면 `npm run db:generate`를 실행한다.
Windows에서는 실행 중인 Node 프로세스가 Prisma DLL을 잠글 수 있으므로 생성/의존성
교체 전에 이 앱의 개발 서버와 DB 사용 테스트를 종료한다. 다른 Node 프로세스를
이름으로 일괄 종료하지 않는다. 타입 검사/빌드는 불필요하게 DLL을 재생성하지 않는다.
PostgreSQL 로그는 `PG_DATA` 안이 아닌 형제 경로(기본 `.local-db.log`)에 둔다.
Windows 장애 복구가 자신의 열린 로그 파일을 동기화하다 공유 위반으로 지연되는 것을 방지한다.

2026-10-03 점검: `npm audit --omit=dev --audit-level=moderate`는 알려진 취약점 0건이다.
전체 audit는 린트 의존성 `braces <=3.0.3`의
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)를 의존 경로 포함 5건으로 보고한다.
점검 당시 upstream 수정 버전이 없으며 Next 14로 강제 다운그레이드하지 않았다.
신뢰할 수 없는 glob 입력을 린트 작업에 주입하지 말고 수정 릴리스가 나오면 잠금 파일을 갱신해 재검증한다.
이는 운영 런타임 의존성과 구분한 미해결 개발 도구 경고이며 보안 무결성 보증을 뜻하지 않는다.
