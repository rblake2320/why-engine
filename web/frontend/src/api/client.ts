const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

export const api = {
  health: () => request<{ status: string; version: string }>("/health"),

  outbox: {
    list: (repoPath: string) =>
      request<{ cases: WhyCase[]; total: number }>(`/outbox?repoPath=${encodeURIComponent(repoPath)}`),
    get: (repoPath: string, caseId: string) =>
      request<WhyCase>(`/outbox/${caseId}?repoPath=${encodeURIComponent(repoPath)}`),
  },

  cases: {
    capture: (body: CaptureRequest) =>
      request<{ success: boolean; data: unknown }>("/cases/capture", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    analyze: (body: AnalyzeRequest) =>
      request<{ success: boolean; data: unknown }>("/cases/analyze", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    publish: (body: PublishRequest) =>
      request<{ success: boolean; data: unknown }>("/cases/publish", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  },

  audit: {
    verify: (repoPath: string) =>
      request<{ success: boolean; data: unknown }>(`/audit/verify?repoPath=${encodeURIComponent(repoPath)}`),
  },
};

// Types
export interface WhyCase {
  caseId: string;
  idempotencyKey: string;
  createdAt: string;
  title: string;
  rootCause: string;
  whyNotCaught: string;
  whyFixWorked: string;
  preventNextTime: string;
  generalizablePattern?: string;
  tags: string[];
  sensitivity: "public" | "internal" | "restricted";
  secretScanResult: { clean: boolean; secretsFound: number };
  links?: { issueUrl?: string; prUrl?: string };
}

export interface CaptureRequest {
  repoPath: string;
  commitRange?: string;
  title: string;
  rootCause: string;
  whyNotCaught: string;
  whyFixWorked: string;
  preventNextTime: string;
  generalizablePattern?: string;
  tags?: string[];
  sensitivity?: "public" | "internal" | "restricted";
  target?: "api" | "outbox" | "both";
  dryRun?: boolean;
}

export interface AnalyzeRequest {
  repoPath: string;
  evidenceId?: string;
  title: string;
  rootCause: string;
  whyNotCaught: string;
  whyFixWorked: string;
  preventNextTime: string;
  generalizablePattern?: string;
  tags?: string[];
  sensitivity?: "public" | "internal" | "restricted";
  issueUrl?: string;
  prUrl?: string;
}

export interface PublishRequest {
  repoPath: string;
  caseId: string;
  target?: "api" | "outbox" | "both";
  dryRun?: boolean;
  problemId?: string;
  keepHistory?: boolean;
}
