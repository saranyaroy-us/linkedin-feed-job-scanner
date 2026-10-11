/** Labels of the deterministic job-relevance classifier (src/classification/job-relevance.ts). */
export const RELEVANCE_LABELS = ['relevant', 'needs_review', 'unrelated', 'not_a_job'] as const;
export type Relevance = (typeof RELEVANCE_LABELS)[number];
/** A relevance label, or every post ("all"): what the dashboard and API list. */
export type RelevanceView = Relevance | 'all';

/** Target functions; "none" for every other role. */
export const PERSONAS = ['revenue_operations', 'sales_operations', 'vendor_manager', 'none'] as const;
export type Persona = (typeof PERSONAS)[number];

/** How clearly the post advertises an actual opening. */
export const HIRING_INTENTS = ['strong', 'weak', 'none', 'commentary'] as const;
export type HiringIntent = (typeof HIRING_INTENTS)[number];

/** Where the role title the label rests on came from. */
export const ROLE_TITLE_SOURCES = ['job_card', 'listing', 'labeled', 'header', 'team'] as const;
export type RoleTitleSource = (typeof ROLE_TITLE_SOURCES)[number];

/** Bumped whenever the rules change, so the backfill can re-label older classifications. */
export const CLASSIFIER_VERSION = 1;

export interface JobClassification {
  relevance: Relevance;
  persona: Persona;
  hiring_intent: HiringIntent;
  /** The role title the label rests on; null when none was found. */
  role_title: string | null;
  title_source: RoleTitleSource | null;
  /** The exact phrase that decided the label (a role title or "join our … team"); never whole post text. */
  evidence_text: string | null;
  /** Short, human-readable reason for the label. */
  reason: string;
}

/** Classification columns as listed with a post (all null for a post that has not been classified). */
export interface PostClassificationFields {
  relevance: Relevance | null;
  persona: Persona | null;
  hiring_intent: HiringIntent | null;
  evidence_text: string | null;
  relevance_reason: string | null;
}
