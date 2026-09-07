/**
 * Where command output goes.
 *
 * Commands write through `log` and `Spinner` rather than touching stdout, so
 * the interactive program can capture them and render the output inside a panel
 * instead of handing the whole terminal over and back. Without a sink installed
 * everything falls through to the real streams, which is what the plain CLI
 * wants.
 */

export type OutputStream = 'out' | 'err' | 'status';
export type Sink = (text: string, stream: OutputStream) => void;

let sink: Sink | null = null;

export function setSink(next: Sink | null): void {
  sink = next;
}

export const isCaptured = (): boolean => sink !== null;

/** Returns true when the text was captured, false to fall through to stdout. */
export function emit(text: string, stream: OutputStream = 'out'): boolean {
  if (!sink) return false;
  sink(text, stream);
  return true;
}

