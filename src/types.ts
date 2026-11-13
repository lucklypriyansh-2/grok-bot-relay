export const RESULT_STATUSES = ["done", "rejected", "needs_approval"] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export type GrokResult = {
  request_id: string;
  status: ResultStatus;
  answer: string;
  finished_at: string;
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
