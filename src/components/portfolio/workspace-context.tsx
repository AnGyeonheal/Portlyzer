"use client";

import { createContext, useContext } from "react";
import type { WorkspaceData } from "@/lib/contracts";
import type { Currency } from "@/lib/domain";

export type View = "dashboard" | "holdings" | "performance" | "allocation" | "dividends" | "transactions" | "trades" | "goals" | "settings";
export interface Filters { from: string; to: string; currency: Currency; accountId: string; portfolioId: string }
export interface WorkspaceContextValue {
  data: WorkspaceData;
  filters: Filters;
  setFilters: (filters: Filters) => void;
  refresh: () => void;
  notify: (message: string) => void;
  navigate: (view: View) => void;
  openTransaction: () => void;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("WorkspaceContext가 필요합니다.");
  return context;
}
