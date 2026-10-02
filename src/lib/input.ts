import Decimal from "decimal.js";
import { z } from "zod";

export const currencyInput = z.enum(["KRW", "USD"]);
export const idInput = z.string().min(1).max(100);
export const decimalInput = z.string()
  .regex(/^(0|[1-9]\d{0,16})(\.\d{1,12})?$/, "0 이상의 숫자를 입력하세요. 정수 17자리, 소수 12자리까지 가능합니다.");
export const positiveInput = decimalInput.refine((value) => new Decimal(value).gt(0), "0보다 커야 합니다.");
export const dayInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 형식이어야 합니다.")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value && value >= "1900-01-01" && value <= "2100-12-31";
  }, "유효한 날짜를 입력하세요 (1900-01-01 이후).");
export const optionalDay = dayInput.nullish().transform((value) => value ?? null);
export const dateOf = (day: string) => new Date(`${day}T00:00:00.000Z`);
export const today = () => new Date().toISOString().slice(0, 10);
export const dayOf = (date: Date) => date.toISOString().slice(0, 10);
export const shiftDay = (day: string, count: number) => new Date(dateOf(day).getTime() + count * 86400000).toISOString().slice(0, 10);
