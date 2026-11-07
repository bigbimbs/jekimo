export interface RecomputeOptions {
  projectId?: string;
  clock?: () => Date;
}

export interface RecomputeResult {
  projects: number;
  fingerprints: number;
}
