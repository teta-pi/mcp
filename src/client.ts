const API_BASE = process.env.TETA_PI_API_URL ?? "http://localhost:8000/api/v1";

// Matches api/app/schemas/business.py :: BusinessSearchResult
export interface BusinessSearchResult {
  id: string;
  entity_type: "business" | "person" | "organization";
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
  agent_endpoint: string | null;
  agent_endpoint_verified: boolean;
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
  entity_type?: string;
  has_agent_endpoint?: boolean;
  limit?: number;
  offset?: number;
}): Promise<{ results: BusinessSearchResult[]; total: number }> {
  const qs = new URLSearchParams({ q: params.q });
  if (params.level && params.level !== "any") qs.set("level", params.level);
  if (params.country) qs.set("country", params.country);
  if (params.entity_type) qs.set("entity_type", params.entity_type);
  if (params.has_agent_endpoint != null) qs.set("has_agent_endpoint", String(params.has_agent_endpoint));
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

// ── New in architecture sync June 23 ─────────────────────────────────────────

export interface EndpointVerifyResult {
  endpoint: string;
  entity_id: string | null;
  is_active: boolean;
  belongs_to_entity: boolean;
  data_consistent: boolean;
  last_checked: string;
  verification_proof: string | null;
}

// Per-component TWIRA breakdown (α·T + β·I + γ·P), each 0–1
export interface TwiraBreakdown {
  score: number;
  t: number;
  i: number;
  p: number;
}

export interface IntentResolution {
  entity_id: string;
  entity_type: string;
  entity_name: string;
  relevance_score: number;
  verification_level: string;
  agent_endpoint: string | null;
  agent_endpoint_verified: boolean;
  country: string | null;
  registry_id: string | null;
  // Present on TWIRA-ranked results (absent on keyword-fallback results)
  twira: TwiraBreakdown | null;
  first_verified_at: string | null;
  proof_url: string | null;
}

export async function verifyEndpoint(params: {
  endpoint_url: string;
  entity_id?: string;
}): Promise<EndpointVerifyResult> {
  return apiFetch<EndpointVerifyResult>("/verify-endpoint", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function resolveIntent(params: {
  query: string;
  entity_types?: string[];
  min_trust?: number;
  verified_only?: boolean;
  has_agent_endpoint?: boolean;
}): Promise<{ query: string; results: IntentResolution[] }> {
  return apiFetch("/resolve-intent", {
    method: "POST",
    body: JSON.stringify(params),
  });
}
