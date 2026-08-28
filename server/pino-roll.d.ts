declare module "pino-roll" {
  import type { EventEmitter } from "node:events";
  export interface PinoRollDestination extends EventEmitter {
    write(chunk: string): boolean;
    flush(callback?: (error?: Error) => void): void;
    end(): void;
    destroy(): void;
  }
  export interface PinoRollOptions {
    file: string;
    size?: string | number;
    frequency?: string | number;
    extension?: string;
    mkdir?: boolean;
    mode?: number;
    minLength?: number;
    maxLength?: number;
    limit?: { count: number; removeOtherLogFiles?: boolean };
  }
  export default function build(options: PinoRollOptions): Promise<PinoRollDestination>;
}
