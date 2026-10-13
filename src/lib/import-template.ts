import { importFields, type ImportField, type ImportMapping } from "./contracts";
import type { TransactionKind } from "./domain";

export const IMPORT_TEMPLATE = Object.freeze({
  id: "portlyzer-transactions-v1",
  filename: "portlyzer-transactions-v1.xlsx",
  sheetName: "거래내역",
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  url: "/api/imports/template",
});

export const importFieldLabels: Record<ImportField, string> = {
  date: "거래일", kind: "거래 유형", symbol: "종목 코드", exchange: "거래소", currency: "통화",
  quantity: "수량", price: "단가", amount: "금액", fee: "수수료", tax: "세금",
  toAccountId: "받는 계좌 ID", toCurrency: "도착 통화", toAmount: "환전 입금액",
  ratio: "분할 비율", memo: "메모", tags: "태그", sourceTransactionId: "원본 거래 ID",
};

export const templateFields = [
  "date", "kind", "currency", "symbol", "exchange", "quantity", "price", "amount",
  "fee", "tax", "memo", "tags", "sourceTransactionId", "toAccountId", "toCurrency", "toAmount", "ratio",
] as const satisfies readonly ImportField[];

export const templateKinds: Record<TransactionKind, string> = {
  BUY: "매수", SELL: "매도", DEPOSIT: "입금", WITHDRAWAL: "출금", DIVIDEND: "배당",
  INTEREST: "이자", FEE: "수수료", TAX: "세금", FX: "환전", TRANSFER: "이체", SPLIT: "분할", VALUATION: "평가",
};

export const templateFieldHelp: Record<ImportField, string> = {
  date: "필수. YYYY-MM-DD로 입력하세요. 같은 날짜의 거래는 위에서 아래 순서로 반영합니다.",
  kind: "필수. 매수·매도·입금 등 목록의 한국어 값을 선택하세요. 업로드 후 거래 내용을 다시 검증합니다.",
  currency: "필수. 실제 거래 통화 KRW 또는 USD를 선택하세요.",
  symbol: "종목 거래에 필요합니다. 005930처럼 앞자리 0을 유지하고 ETF·가상자산은 웹에서 먼저 등록하세요.",
  exchange: "종목 거래에 필요합니다. KRX, NASDAQ, NYSE 등 종목을 식별할 거래소를 입력하세요.",
  quantity: "매수·매도·증권 이체 수량입니다. 양수, 소수점 이하 최대 12자리. 계산식 대신 값을 입력하세요.",
  price: "매수·매도 체결 단가 또는 CUSTOM 자산의 단위당 평가액입니다. 매수·매도 금액 칸은 비워 두세요.",
  amount: "입금·출금·배당·이자·현금 이체·환전 출금의 총액입니다. 배당은 세전 금액, 세금은 별도 입력하세요.",
  fee: "거래 수수료입니다. 비우면 0. 거래 유형이 수수료인 경우에는 금액 칸에 입력하고 이 칸은 비우세요.",
  tax: "거래 세금입니다. 비우면 0. 거래 유형이 세금인 경우에는 금액 칸에 입력하고 이 칸은 비우세요.",
  memo: "선택. 거래에 남길 메모를 1,000자 이내로 입력하세요.",
  tags: "선택. 쉼표로 구분하며 태그당 40자, 최대 20개입니다.",
  sourceTransactionId: "선택. 원본 거래의 고유 식별자입니다. 재업로드 중복 확인에 사용하며 다른 거래에 재사용하지 마세요.",
  toAccountId: "이체에 필요합니다. 웹 가져오기 화면의 '이체용 계좌 ID'에서 받는 계좌의 ID를 확인하세요.",
  toCurrency: "환전에 필요합니다. 출금 통화와 다른 도착 통화를 선택하세요.",
  toAmount: "환전에 필요합니다. 실제 입금된 도착 통화 금액을 입력하세요.",
  ratio: "분할·병합에 필요합니다. 1주가 2주가 되면 2, 2주가 1주가 되면 0.5입니다.",
};

export const templateHeaders = templateFields.map((field) => importFieldLabels[field]);
export const templateListLiterals = [
  `"${Object.values(templateKinds).join(",")}"`,
  '"KRW,USD"',
] as const;

export function matchesTemplateHeaders(headers: string[]) {
  return headers.length === templateHeaders.length && headers.every((header, index) => header === templateHeaders[index]);
}

export function templateMapping(): ImportMapping {
  return Object.fromEntries(templateFields.map((field) => [field, importFieldLabels[field]]));
}

export function suggestImportMapping(headers: string[]): ImportMapping {
  const mapping: ImportMapping = {};
  for (const field of importFields) {
    const header = headers.find((name) => name.trim().toLowerCase() === field.toLowerCase() || name.trim() === importFieldLabels[field]);
    if (header) mapping[field] = header;
  }
  return mapping;
}
