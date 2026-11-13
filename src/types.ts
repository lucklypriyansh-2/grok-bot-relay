export const RESULT_STATUSES = ["done", "rejected", "needs_approval"] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export type ArtifactInfo = {
  name: string;
  size?: number;
  sha256?: string;
  content_type?: string;
  description?: string;
};

export type GrokResult = {
  request_id: string;
  status: ResultStatus;
  answer: string;
  finished_at: string;
  /** Files in <results_dir>/<request_id>/; full detail lives there. */
  artifacts?: ArtifactInfo[];
};

export type PendingResult = {
  request_id: string;
  status: "pending";
  message: string;
};

export type RelayOutcome = GrokResult | PendingResult;

export type SubmitTaskInput = {
  task: string;
  context?: string;
  bot?: string;
  requestId?: string;
};
