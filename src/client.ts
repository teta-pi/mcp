const API_BASE = process.env.TETA_PI_API_URL ?? "http://localhost:8000/api/v1";

// Matches api/app/schemas/business.py :: BusinessSearchResult
export interface BusinessSearchResult {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  verification_level: "none" | "registry" | "partial" | "full" | "live";
  badges: string[];
  relevance_score: number;
  country: string | null;
  block_count: number;
  registry_id: string | null;
  registry_data: Record<string, unknown> | null;
  ai_categories: {
    industry?: string;
    sub_category?: string;
    claims?: string[];
    confidence?: number;
  } | null;
}

// Matches api/app/schemas/business.py :: AgentBusinessProfile
// returned by GET /businesses/{id}/preview
export interface AgentBusinessProfile {
  id: string;
  name: string;
  description: string | null;
  registry: Record<string, unknown> | null;
  trust_level: string;
  blocks: AgentBlock[];
}

export interface AgentBlock {
  title: string;
  description: string | null;
  media: AgentMedia[];
}

export interface AgentMedia {
  type: string;
  c2pa_verified: boolean;
  c2pa_signer: string | null;
  captured_at: string | null;
  bitcoin_confirmed: boolean;
  bitcoin_block: number | null;
}

// Matches GET /businesses/{id}/proof
export interface VerificationProof {
  registry_proof: {
    source: string;
    verified_at: string | null;
    data_hash: string | null;
  };
  c2pa_proofs: Array<{
    media_id: string;
    manifest_hash: string;
    signer: string | null;
  }>;
  bitcoin_proofs: Array<{
    media_id: string;
    bitcoin_block: number | null;
    ots_proof_url: string;
  }>;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function searchBusinesses(params: {
  q: string;
  level?: string;
  country?: string;
  limit?: number;
  offset?: number;
}): Promise<{ results: BusinessSearchResult[]; total: number }> {
  const qs = new URLSearchParams({ q: params.q });
  if (params.level && params.level !== "any") qs.set("level", params.level);
  if (params.country) qs.set("country", params.country);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.offset) qs.set("offset", String(params.offset));

  const results = await apiFetch<BusinessSearchResult[]>(`/search?${qs}`);
  return { results, total: results.length };
}

export async function getBusinessProfile(id: string): Promise<AgentBusinessProfile> {
  return apiFetch<AgentBusinessProfile>(`/businesses/${id}/preview`);
}

export async function getVerificationProof(id: string): Promise<VerificationProof> {
  return apiFetch<VerificationProof>(`/businesses/${id}/proof`);
}
