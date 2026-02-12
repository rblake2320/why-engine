import { WhyCase, ApiPublishResult } from "../core/contracts";

export interface PublishOptions {
  problemId?: string;
  idempotencyKey: string;
  evidenceLink?: string;
  evidenceHash?: string;
}

export class AihangoutClient {
  private accessToken: string | null = null;
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? process.env.AIHANGOUT_BASE_URL ?? "https://aihangout.ai";
  }

  async login(): Promise<void> {
    const email = process.env.AIHANGOUT_EMAIL;
    const password = process.env.AIHANGOUT_PASSWORD;
    if (!email || !password) {
      throw new Error("AIHANGOUT_EMAIL and AIHANGOUT_PASSWORD are required");
    }

    const response = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });

    if (!response.ok) {
      throw new Error(`Login failed (${response.status})`);
    }

    const data = (await response.json()) as { token?: string; accessToken?: string };
    this.accessToken = data.accessToken ?? data.token ?? null;
    if (!this.accessToken) {
      throw new Error("Login response missing token");
    }
  }

  async publishWhyCase(whyCase: WhyCase, options: PublishOptions): Promise<ApiPublishResult> {
    if (!this.accessToken) {
      await this.login();
    }

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.accessToken}`,
      "Idempotency-Key": options.idempotencyKey
    };

    let problemId = options.problemId;
    if (!problemId) {
      const problemResponse = await fetch(`${this.baseUrl}/api/problems`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: whyCase.title,
          description: whyCase.rootCause,
          tags: whyCase.tags
        })
      });

      if (!problemResponse.ok) {
        return { success: false, httpStatus: problemResponse.status, error: await problemResponse.text() };
      }

      const problemData = (await problemResponse.json()) as { id?: string; problemId?: string };
      problemId = problemData.id ?? problemData.problemId;
      if (!problemId) {
        return { success: false, error: "Problem creation returned no id" };
      }
    }

    const whyExplanation = {
      rootCause: whyCase.rootCause,
      whyNotCaught: whyCase.whyNotCaught,
      whyFixWorked: whyCase.whyFixWorked,
      preventNextTime: whyCase.preventNextTime,
      generalizablePattern: whyCase.generalizablePattern,
      evidence: whyCase.evidence,
      evidenceLink: options.evidenceLink,
      evidenceHash: options.evidenceHash,
      idempotencyKey: options.idempotencyKey
    };

    const solutionResponse = await fetch(`${this.baseUrl}/api/problems/${problemId}/solutions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        solutionText: whyCase.preventNextTime,
        codeSnippet: whyCase.evidence.diffSummary ?? "",
        whyExplanation: JSON.stringify(whyExplanation),
        idempotencyKey: options.idempotencyKey
      })
    });

    if (!solutionResponse.ok) {
      return { success: false, httpStatus: solutionResponse.status, error: await solutionResponse.text() };
    }

    const solutionData = (await solutionResponse.json()) as { id?: string; solutionId?: string };
    const solutionId = solutionData.id ?? solutionData.solutionId;
    return {
      success: true,
      problemId,
      solutionId,
      url: `${this.baseUrl}/problems/${problemId}`
    };
  }
}
