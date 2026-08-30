export type StageEffect = (effect: string) => void;

/** In production the committer is a PostgreSQL transaction; tests can use a deterministic sink. */
export class AtomicUnitOfWork {
  constructor(private readonly commit: (effects: readonly string[]) => void | Promise<void>) {}

  async execute(work: (stage: StageEffect) => void | Promise<void>): Promise<void> {
    const pending: string[] = [];
    await work((effect) => pending.push(effect));
    await this.commit(Object.freeze([...pending]));
  }
}
