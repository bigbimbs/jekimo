export interface WaterfallSpan {
  id: string;
  eventId: string;
  parentId?: string;
  name: string;
  operation: string;
  status: "ok" | "error";
  start: number;
  duration: number;
  depth: number;
  missingParent: boolean;
}
