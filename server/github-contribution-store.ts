import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { GITHUB_BROKER_REVISION, type GitHubBrokerAuditRecord, type GitHubBrokerStoreState } from "./github-contribution-record.js";

const EMPTY: GitHubBrokerStoreState = { schemaVersion: 1, records: [] };

export class GitHubContributionStore {
  private queue: Promise<void> = Promise.resolve();
  private state: GitHubBrokerStoreState = EMPTY;

  private constructor(private readonly filePath: string) {}

  static async open(filePath: string) {
    const store = new GitHubContributionStore(filePath);
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as GitHubBrokerStoreState;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.records)) throw new Error("GitHub broker store has an unsupported schema");
      store.state = structuredClone(parsed);
      store.verifyChain();
      await chmod(filePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await store.persist(EMPTY);
    }
    return store;
  }

  records() { return structuredClone(this.state.records); }

  latest(idempotencyKey: string) {
    return this.state.records.filter((record) => record.idempotencyKey === idempotencyKey).at(-1);
  }

  append(input: Omit<GitHubBrokerAuditRecord, "schemaVersion" | "sequence" | "brokerRevision" | "previousHash" | "recordHash">) {
    let value!: GitHubBrokerAuditRecord;
    const operation = this.queue.then(async () => {
      const previous = this.state.records.at(-1);
      const base = {
        schemaVersion: 1 as const,
        sequence: (previous?.sequence ?? 0) + 1,
        brokerRevision: GITHUB_BROKER_REVISION,
        ...structuredClone(input),
        previousHash: previous?.recordHash ?? "0".repeat(64),
      };
      value = { ...base, recordHash: hash(base) };
      await this.persist({ schemaVersion: 1, records: [...this.state.records, value] });
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation.then(() => structuredClone(value));
  }

  private async persist(state: GitHubBrokerStoreState) {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
    await chmod(this.filePath, 0o600);
    this.state = structuredClone(state);
  }

  private verifyChain() {
    let previousHash = "0".repeat(64);
    let sequence = 1;
    for (const record of this.state.records) {
      const { recordHash, ...base } = record;
      if (record.schemaVersion !== 1 || record.brokerRevision !== GITHUB_BROKER_REVISION
        || record.sequence !== sequence || record.previousHash !== previousHash || hash(base) !== recordHash) {
        throw new Error("GitHub broker audit chain is invalid");
      }
      previousHash = recordHash; sequence += 1;
    }
  }
}

function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
