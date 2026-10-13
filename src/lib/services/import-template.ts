import ExcelJS from "exceljs";
import { IMPORT_FILE_LIMITS } from "../contracts";
import { IMPORT_TEMPLATE, importFieldLabels, templateFieldHelp, templateFields, templateListLiterals } from "../import-template";

export async function createImportTemplate(): Promise<Uint8Array<ArrayBuffer>> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Portlyzer";
  workbook.title = "Portlyzer 거래내역 입력 양식 v1";
  workbook.subject = "2행부터 연속해서 작성하세요. 예시 거래는 포함되어 있지 않습니다.";
  const sheet = workbook.addWorksheet(IMPORT_TEMPLATE.sheetName, {
    views: [{ state: "frozen", xSplit: 3, ySplit: 1, activeCell: "A2" }],
  });
  sheet.columns = templateFields.map((field) => ({
    header: importFieldLabels[field], key: field,
    width: field === "memo" ? 36 : field === "toAccountId" || field === "sourceTransactionId" ? 32 : field === "currency" || field === "toCurrency" ? 12 : 18,
    style: { numFmt: "@", font: { name: "맑은 고딕", size: 11 }, alignment: { vertical: "middle" } },
  }));
  sheet.getRow(1).height = 32;
  for (const [index, field] of templateFields.entries()) {
    const header = sheet.getRow(1).getCell(index + 1);
    const required = ["date", "kind", "currency"].includes(field);
    header.font = { name: "맑은 고딕", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: required ? "FF0E8074" : "FF173E58" } };
    const list = field === "kind" ? templateListLiterals[0]
      : field === "currency" || field === "toCurrency" ? templateListLiterals[1] : undefined;
    for (let row = 2; row <= IMPORT_FILE_LIMITS.rows + 1; row++) {
      sheet.getCell(row, index + 1).dataValidation = {
        type: list ? "list" : "textLength", formulae: list ? [list] : [IMPORT_FILE_LIMITS.cellLength],
        ...(list ? {} : { operator: "lessThanOrEqual" as const }),
        allowBlank: true, showInputMessage: true, promptTitle: importFieldLabels[field], prompt: templateFieldHelp[field],
        showErrorMessage: true, errorStyle: "stop", errorTitle: "입력값 확인",
        error: list ? "목록에 있는 값을 선택하세요." : "한 셀은 4,096자 이내로 입력하세요. 자세한 필드 검증은 업로드 후 수행합니다.",
      };
    }
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
