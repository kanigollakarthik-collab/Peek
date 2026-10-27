// Collects single requests that arrive close together and hands them to
// runBatch() in groups of up to maxSize. runBatch(items) resolves to an array
// with one result per item; an Error in that array rejects just that item.

export class Batcher {
  constructor({ maxSize, waitMs, runBatch }) {
    this.maxSize = maxSize;
    this.waitMs = waitMs;
    this.runBatch = runBatch;
    this.queue = [];
    this.timer = null;
  }

  add(item) {
    return new Promise((resolve, reject) => {
      this.queue.push({ item, resolve, reject });
      if (this.queue.length >= this.maxSize) this.flush();
      else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.waitMs);
    });
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    while (this.queue.length) {
      const group = this.queue.splice(0, this.maxSize);
      this.runBatch(group.map((g) => g.item)).then(
        (results) =>
          group.forEach((g, i) => {
            const r = results[i];
            if (r instanceof Error) g.reject(r);
            else g.resolve(r);
          }),
        (err) => group.forEach((g) => g.reject(err)),
      );
    }
  }
}
