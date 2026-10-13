"use client";

import { importFieldLabels, templateFieldHelp, templateFields } from "@/lib/import-template";
import { Hint, TableWrap } from "./shared";
import { useWorkspace } from "./workspace-context";

export function ImportTemplateGuide() {
  const { data } = useWorkspace();
  return <div className="form-stack">
    <Hint>파일 하나는 선택한 계좌 하나에 반영합니다. 양식의 열 이름·순서를 유지하고 2행부터 빈 줄 없이 작성하세요.
      초록색 열인 거래일·거래 유형·통화는 모든 거래에서 필수입니다. 예시 거래는 양식에 들어 있지 않습니다.</Hint>
    <details className="details">
      <summary>거래 유형별 작성 방법</summary>
      <TableWrap><table><thead><tr><th>거래 유형</th><th>거래일·유형·통화 외에 필요한 값</th><th>주의할 점</th></tr></thead><tbody>
        <tr><td>매수 · 매도</td><td>종목 코드, 거래소, 수량, 단가</td><td>금액은 비우고 수수료·세금은 별도로 입력합니다.</td></tr>
        <tr><td>입금 · 출금 · 이자</td><td>금액</td><td>입출금은 실제 금액으로 기록합니다.</td></tr>
        <tr><td>배당</td><td>종목 코드, 거래소, 세전 금액</td><td>원천징수액은 세금 열에 입력합니다.</td></tr>
        <tr><td>수수료 · 세금</td><td>금액</td><td>독립된 비용 거래는 금액 열만 쓰고 같은 이름의 비용 열은 비웁니다.</td></tr>
        <tr><td>환전</td><td>금액, 도착 통화, 환전 입금액</td><td>통화는 출금 통화입니다. 같은 계좌의 실제 두 금액을 입력합니다.</td></tr>
        <tr><td>이체</td><td>받는 계좌 ID와 금액, 또는 종목 코드·거래소·수량</td><td>현금 이체와 증권 이체를 구분하며 통화를 임의로 바꾸지 않습니다.</td></tr>
        <tr><td>분할</td><td>종목 코드, 거래소, 분할 비율</td><td>1주가 2주면 2, 2주가 1주면 0.5입니다.</td></tr>
        <tr><td>평가</td><td>미리 등록한 CUSTOM 종목 코드·거래소, 단가</td><td>총액이 아닌 단위당 가격이며 0도 입력할 수 있습니다.</td></tr>
      </tbody></table></TableWrap>
      <p className="text-sm text-muted">매수 전에 실제 입금·취득 이력을 넣어 주세요. 없는 잔고를 자동으로 만들지 않습니다.
        같은 날짜는 위에서 아래 순서이며, 수수료·세금을 비우면 0으로 처리합니다.</p>
    </details>
    <details className="details">
      <summary>열별 입력 안내 · 정밀도와 파일 제한</summary>
      <TableWrap><table><thead><tr><th>열</th><th>작성 방법</th></tr></thead><tbody>
        {templateFields.map((field) => <tr key={field}><td>{importFieldLabels[field]}</td><td>{templateFieldHelp[field]}</td></tr>)}
      </tbody></table></TableWrap>
      <p className="text-sm text-muted">입력 셀은 텍스트 형식입니다. 종목 코드의 앞자리 0과 소수를 유지하세요.
        최대 2 MiB·2,000건이며 단일 시트만 지원합니다. 셀 수식·매크로·병합·숨김·외부 연결은 사용할 수 없습니다.
        양식에 미리 들어 있는 고정 목록과 글자 수 검사는 사용할 수 있습니다.</p>
    </details>
    <details className="details">
      <summary>이체용 계좌 ID</summary>
      <p className="text-sm text-muted">이체 행의 받는 계좌 ID에 아래 값을 복사하세요. 출발 계좌는 업로드할 때 선택합니다.</p>
      <TableWrap><table><thead><tr><th>계좌</th><th>기본 통화</th><th>받는 계좌 ID</th></tr></thead><tbody>
        {data.accounts.map((account) => <tr key={account.id}><td>{account.name}</td><td>{account.currency}</td><td><code>{account.id}</code></td></tr>)}
      </tbody></table></TableWrap>
    </details>
  </div>;
}
