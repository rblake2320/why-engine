import { loadAllCases, tokenize } from "../core/recall";
import { assertSafeRepoPath } from "../core/path-policy";
import { runQualityGate } from "../core/quality-gate";

/**
 * Stats: fleet-level insight over the case store.
 *
 * The recurring-pattern detector is the important part: it clusters cases
 * whose root causes share a high Jaccard token overlap. A cluster of size
 * >= 2 means the same class of failure happened more than once — i.e. a
 * prevention that did not hold. That is the highest-value signal a
 * root-cause system can surface.
 */

export interface StatsInput {
  repoPath: string;
  /** Jaccard similarity threshold for clustering root causes. Default 0.5. */
  similarityThreshold?: number;
}

export interface RecurringCluster {
  caseIds: string[];
  titles: string[];
  sharedTerms: string[];
}

export interface StatsResult {
  totalCases: number;
  bySensitivity: Record<string, number>;
  topTags: Array<{ tag: string; count: number }>;
  casesWithSecretFindings: number;
  averageQualityScore: number;
  casesWithGeneralizablePattern: number;
  recurringClusters: RecurringCluster[];
  oldestCase?: string;
  newestCase?: string;
}

export function computeStats(input: StatsInput): StatsResult {
  assertSafeRepoPath(input.repoPath);
  const threshold = input.similarityThreshold ?? 0.5;
  const cases = loadAllCases(input.repoPath);

  const bySensitivity: Record<string, number> = {};
  const tagCounts = new Map<string, number>();
  let secretCases = 0;
  let qualityTotal = 0;
  let withPattern = 0;
  let oldest: string | undefined;
  let newest: string | undefined;

  for (const c of cases) {
    bySensitivity[c.sensitivity] = (bySensitivity[c.sensitivity] ?? 0) + 1;
    for (const tag of c.tags ?? []) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
    if ((c.secretScanResult?.secretsFound ?? 0) > 0 || (c.secretScanResult?.findings?.length ?? 0) > 0) {
      secretCases += 1;
    }
    if (c.generalizablePattern && c.generalizablePattern.trim().length >= 20) {
      withPattern += 1;
    }
    qualityTotal += runQualityGate({
      title: c.title,
      rootCause: c.rootCause,
      whyNotCaught: c.whyNotCaught,
      whyFixWorked: c.whyFixWorked,
      preventNextTime: c.preventNextTime,
      generalizablePattern: c.generalizablePattern
    }).score;
    if (!oldest || c.createdAt < oldest) {
      oldest = c.createdAt;
    }
    if (!newest || c.createdAt > newest) {
      newest = c.createdAt;
    }
  }

  const topTags = Array.from(tagCounts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, 10);

  // Cluster recurring root causes via union-find over pairwise Jaccard.
  const tokenSets = cases.map((c) => new Set(tokenize(`${c.title} ${c.rootCause}`)));
  const parent = cases.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a: number, b: number): void => {
    parent[find(a)] = find(b);
  };
  for (let i = 0; i < cases.length; i += 1) {
    for (let j = i + 1; j < cases.length; j += 1) {
      if (jaccard(tokenSets[i], tokenSets[j]) >= threshold) {
        union(i, j);
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < cases.length; i += 1) {
    const rootIdx = find(i);
    const group = groups.get(rootIdx) ?? [];
    group.push(i);
    groups.set(rootIdx, group);
  }
  const recurringClusters: RecurringCluster[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) {
      continue;
    }
    let shared = new Set(tokenSets[members[0]]);
    for (const idx of members.slice(1)) {
      shared = new Set(Array.from(shared).filter((t) => tokenSets[idx].has(t)));
    }
    recurringClusters.push({
      caseIds: members.map((idx) => cases[idx].caseId),
      titles: members.map((idx) => cases[idx].title),
      sharedTerms: Array.from(shared).sort().slice(0, 12)
    });
  }
  recurringClusters.sort((a, b) => b.caseIds.length - a.caseIds.length);

  return {
    totalCases: cases.length,
    bySensitivity,
    topTags,
    casesWithSecretFindings: secretCases,
    averageQualityScore: cases.length > 0 ? Math.round(qualityTotal / cases.length) : 0,
    casesWithGeneralizablePattern: withPattern,
    recurringClusters,
    oldestCase: oldest,
    newestCase: newest
  };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (a.size + b.size - intersection);
}

export function formatStatsResult(result: StatsResult): string {
  const lines: string[] = [
    `Cases: ${result.totalCases}`,
    `Sensitivity: ${Object.entries(result.bySensitivity)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ") || "n/a"}`,
    `Average quality score: ${result.averageQualityScore}`,
    `Cases with generalizable pattern: ${result.casesWithGeneralizablePattern}`,
    `Cases with secret findings: ${result.casesWithSecretFindings}`
  ];
  if (result.oldestCase) {
    lines.push(`Range: ${result.oldestCase} .. ${result.newestCase}`);
  }
  if (result.topTags.length > 0) {
    lines.push(`Top tags: ${result.topTags.map((t) => `${t.tag}(${t.count})`).join(", ")}`);
  }
  if (result.recurringClusters.length > 0) {
    lines.push("");
    lines.push("RECURRING ROOT CAUSES (prevention did not hold):");
    for (const cluster of result.recurringClusters) {
      lines.push(`  x${cluster.caseIds.length}: ${cluster.titles.join(" | ")}`);
      lines.push(`     shared terms: ${cluster.sharedTerms.join(", ")}`);
    }
  } else {
    lines.push("No recurring root-cause clusters detected.");
  }
  return `${lines.join("\n")}\n`;
}
