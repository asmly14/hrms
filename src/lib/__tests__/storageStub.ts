/**
 * In-memory localStorage stub for node-environment tests.
 * db.ts guards seeding behind `typeof localStorage === 'undefined'`, so
 * installing this stub in beforeEach keeps tests fully deterministic.
 */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
}

/** Install (or reset) the stub and return it. */
export function installLocalStorage(): MemoryStorage {
  const stub = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: stub,
    configurable: true,
    writable: true,
  });
  return stub;
}
