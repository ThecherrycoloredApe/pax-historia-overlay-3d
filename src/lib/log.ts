const PREFIX = '[PaxOverlay]';

export function log(...args: unknown[]): void {
  console.log(PREFIX, ...args);
}

export function warn(...args: unknown[]): void {
  console.warn(PREFIX, ...args);
}
