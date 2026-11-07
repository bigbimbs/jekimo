/** One V8 stack frame without line and column numbers, and whether it is in-app. */
export interface StackFrame {
  frame: string;
  inApp: boolean;
}
