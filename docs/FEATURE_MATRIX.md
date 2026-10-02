# 공개 기능 조사 및 대응표

조사일: 2026-10-02. **공개 문서 확인**은 Portseido에 로그인하여 동작을 검증했다는 뜻이 아니다.
비공개 화면/수치 알고리즘/실제 권한 정책은 미확인이다. 제품명/문구/시각 자산은 복제하지 않는다.
Portlyzer 구현의 최종 상태와 검증은 [DELIVERY.md](DELIVERY.md)를 참고한다.

| 영역 | Portseido 공개 문서로 확인한 기능 | 미확인 또는 제한 | Portlyzer 대응 |
| --- | --- | --- | --- |
| 대시보드 | 통합 지표/성과/수입/배분 [개요](https://support.portseido.com/000-what-is-portseido/), [선택 포트폴리오 통합](https://support.portseido.com/product-update/2025-06-01/) | 로그인 화면 배치/갱신/오류 상태 | 독자적 한국어 대시보드 및 공통 필터 |
| 수익률 | SR/TWR/MWR/낙폭/Beta/Sharpe [분석](https://www.portseido.com/portfolio-analyzer/), [수익률 안내](https://support.portseido.com/003-mwr-vs-twr/) | 일별 경계/솔버/누락 데이터 정책 | Decimal 원장, 명시적 일말 현금흐름 정책. Beta/Sharpe는 미구현 |
| 벤치마크 | 동일 입금 시점 가상 투자 [가이드](https://support.portseido.com/004-benchmarking-portfolio/) | 구현 수치/데이터 조정 | 같은 기간/통화 가격수익률, 동일 현금 흐름 가상 투자 |
| 보유 자산 | 현금 구분, 실현/미실현/배당/수수료 포함 [현금](https://support.portseido.com/011-auto-deposit/), [보유 수익률](https://support.portseido.com/product-update/2025-07-01/) | 전체 열/정밀도/자동 대사 | 현금 부족 차단, 자동 가상 입금 없음 |
| 배분 | 종목/자산군/산업/업종 [분석](https://www.portseido.com/portfolio-analyzer/) | ETF 구성종목 투시/분류 출처 | 종목/자산군/국가/업종/통화/계좌, 미분류 및 목표 |
| 배당 | 수령/예정 캘린더, 12개월 예상 [배당](https://www.portseido.com/dividend-tracker/), [자동 배당](https://support.portseido.com/013-auto-cash-dividend/) | 추정 알고리즘/중복 방지/지급일 누락 | 실제/공시/추정 구분, 거래 입금 우선, 수동 이벤트/대사 |
| 거래/가져오기 | 수동/증권사 파일/검토·수정, Google Sheets [설정](https://support.portseido.com/001-setting-up-portfolio/), [입력](https://support.portseido.com/add-import-trades/), [원본과 조정](https://support.portseido.com/008-transactions-overview/) | 파서별 정확성/중복/충돌 정책 | CSV/XLSX 범용 매핑, 원본/수정 이력, 원자적 확정. Google Sheets 동기화는 미구현 |
| 거래 분석 | 보유/일부/전량 매도, 원가/손익/기간/벤치마크, FIFO/LIFO/평균 [2026-04 업데이트](https://support.portseido.com/product-update/2026-04-01/) | 복잡한 기업행동/반올림 | FIFO/이동평균, 거래 메모/태그/매수 단위 추적 |
| 목표 | **모바일 앱** Goal Tracker [2024-09 업데이트](https://support.portseido.com/product-update/2024-09-01/) | 웹 동등 기능/계산 가정 미확인 | 웹 자산/월 배당 목표, 명시적 가정 시뮬레이션 |
| 계정/포트폴리오 | 복수/All 보기 [설정](https://support.portseido.com/002-configure-portfolio-settings/), [삭제 요청](https://support.portseido.com/999-delete-account/) | 인증/MFA/권한/계좌 엔터티 | 라이브러리 인증, 사용자 격리, 복수 계좌/포트폴리오 |
| 통화/설정 | 표시 통화/환율 효과/현금 결제 [설정](https://support.portseido.com/002-configure-portfolio-settings/), [복수 통화](https://support.portseido.com/006-multiple-cash-currencies/) | 모든 설정의 플랜별 범위 | KRW/USD, 원가 방식/벤치마크/개인 설정 |

이전 [원가 가이드](https://support.portseido.com/005-how-to-calculate-cost-basis/)의 LIFO 미지원 문구와
2026-04 거래 분석 업데이트의 LIFO 지원 문구는 다르다. 최신 업데이트가 이전 화면 전체에도
소급 적용된다고 추측하지 않는다. Portlyzer는 요청된 FIFO/이동평균만 지원한다.

## 의도적으로 지원한다고 표시하지 않는 항목

- 실제 샘플을 확인하지 않은 국내 증권사 전용 파일 파서
- 접근 권한/문서가 없는 증권사 API 및 자동 동기화
- 세법에 근거하지 않은 ISA/연금 세금 자동 확정
- 권리 허락 없는 외부 주가 재배포, 무료 실시간/완전한 시세 보장
- ETF 구성종목 투시, 공매도/레버리지/파생상품, 이메일 인증·비밀번호 복구 메일 발송

원본 거래와 사용자 수정값을 분리하므로 향후 API 원본 동기화는 수정값을 덮어쓰지 않고
별도 검토 흐름으로 확장할 수 있다. 현재 증권사 자동 동기화는 미구현이다.
