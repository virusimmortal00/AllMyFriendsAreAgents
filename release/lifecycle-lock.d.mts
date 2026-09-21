export function withLifecycleLock<T>(root: string, action: () => T | Promise<T>): Promise<T>;
