/** Types for ./plan.mjs (used by the tests). */

export interface Manifest {
  name: string;
  runIds: string[];
  posts: number;
  minPostId: number;
  maxPostId: number;
  sourceIdsSha256: string;
}

export interface ResetDb {
  query(sql: string): Promise<Record<string, unknown>[]>;
  run(statements: string[]): Promise<void>;
}

export interface Snapshot {
  hasJobCountry: boolean;
  scope: { posts: number; minPostId: number | null; maxPostId: number | null; sourceIdsSha256: string };
  legacyRowsOutsideScope: number;
  otherPosts: number;
  legacyRuns: Record<string, unknown>[];
  activeIngestion: { processingRuns: number; searchesInFlight: number };
  totals: Record<string, number>;
  schema: string[];
  consistency: Record<string, number>;
}

export interface ResetReport {
  manifest: string;
  state: 'ready' | 'done' | 'blocked';
  reasons: string[];
  before: Record<string, unknown>;
  executed: boolean;
  after: Record<string, unknown> | null;
  problems: string[];
}

export function validateManifest(manifest: Manifest): string[];
export function scopeWhere(manifest: Manifest, options?: { hasJobCountry?: boolean }): string;
export function fingerprint(sourceIds: Iterable<string>): Promise<string>;
export function inspect(db: Pick<ResetDb, 'query'>, manifest: Manifest, now: Date): Promise<Snapshot>;
export function evaluate(snapshot: Snapshot, manifest: Manifest): { state: 'ready' | 'done' | 'blocked'; reasons: string[] };
export function resetStatements(manifest: Manifest, options?: { hasJobCountry?: boolean }): string[];
export function verify(before: Snapshot, after: Snapshot): string[];
export function runLegacyReset(
  db: ResetDb,
  manifest: Manifest,
  options?: { execute?: boolean; confirm?: string; now?: Date },
): Promise<ResetReport>;
