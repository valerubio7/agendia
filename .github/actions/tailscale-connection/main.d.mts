interface Stat {
  uid: number; mode: number;
  isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; isSocket(): boolean;
}
interface IO {
  mkdtemp(path: string): Promise<string>; realpath(path: string): Promise<string>;
  chmod(path: string, mode: number): Promise<void>;
  writeFile(path: string, data: string | Uint8Array, options: { mode: number; flag: string }): Promise<void>;
  appendFile(path: string, data: string): Promise<void>; readFile(path: string, encoding: string): Promise<string>;
  lstat(path: string): Promise<Stat>; unlink(path: string): Promise<void>;
  rm(path: string, options: { recursive: boolean }): Promise<void>;
}
export interface Dependencies {
  io: IO; env: Record<string, string>; uid: number; platform: string; arch: string;
  run(file: string, args: string[]): Promise<string>; proc(pid: string): Promise<string>;
  launch(args: string[], log: string): Promise<void>; pause(): Promise<void>;
  fetch(url: string | URL, options: RequestInit): Promise<Response>;
  digest?: ((bytes: Uint8Array) => string) | undefined; log(message: string): void;
}
export const PIN: Readonly<{ version: string; url: string; sha256: string }>;
export function connect(overrides?: Partial<Dependencies>): Promise<void>;
export function cleanup(directory?: string, overrides?: Partial<Dependencies>): Promise<void>;
export function reportFailure(): void;
