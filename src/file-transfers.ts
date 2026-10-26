export const STANDARD_FILE_SIZE = 1024 * 1024 * 1024;
export const PLUS_FILE_SIZE = 2048 * 1024 * 1024;
const CHUNK_SIZE = 16 * 1024 * 1024;
type Transfer = {
  user: string;
  size: number;
  offset: number;
  busy: boolean;
  expires: number;
};
export class FileTransfers {
  private jobs = new Map<string, Transfer>();
  constructor(private clock = Date.now) {}
  prune() {
    for (const [id, job] of this.jobs)
      if (!job.busy && job.expires <= this.clock()) this.jobs.delete(id);
  }
  create(user: string, size: number, maximum: number) {
    this.prune();
    if (
      !Number.isSafeInteger(size) ||
      size <= 25 * 1024 * 1024 ||
      size > maximum ||
      maximum > PLUS_FILE_SIZE
    )
      throw Error(`1ファイル${maximum / 1024 / 1024} MiBまでです`);
    if (
      this.jobs.size >= 2048 ||
      [...this.jobs.values()].filter((job) => job.user === user).length >= 5
    )
      throw Error("送信中の添付が多すぎます");
    const id = crypto.randomUUID();
    this.jobs.set(id, {
      user,
      size,
      offset: 0,
      busy: false,
      expires: this.clock() + 3600000,
    });
    return { id, size };
  }
  reserve(user: string, id: string, offset: number, encryptedSize: number) {
    const job = this.jobs.get(id);
    if (
      !job ||
      job.user !== user ||
      job.expires <= this.clock() ||
      job.busy ||
      offset !== job.offset ||
      encryptedSize !== Math.min(CHUNK_SIZE, job.size - job.offset) + 16
    )
      throw Error("添付の送信情報が一致しません");
    job.busy = true;
    let finished = false;
    return (success: boolean) => {
      if (finished) return;
      finished = true;
      job.busy = false;
      if (success) job.offset += encryptedSize - 16;
      if (job.offset === job.size) this.jobs.delete(id);
    };
  }
  cancel(user: string, id: string) {
    const job = this.jobs.get(id);
    if (job?.user === user && !job.busy) this.jobs.delete(id);
  }
}
