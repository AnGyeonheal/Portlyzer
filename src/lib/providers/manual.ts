import { BaseProvider } from "./base";

export class ManualProvider extends BaseProvider {
  readonly id = "MANUAL" as const;
}
