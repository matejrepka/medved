export class ScheduledDataStore {
  constructor({ name, fetcher, loadStored, saveFresh, recordRun, intervalMs }) {
    this.name = name;
    this.fetcher = fetcher;
    this.loadStored = loadStored;
    this.saveFresh = saveFresh;
    this.recordRun = recordRun;
    this.intervalMs = intervalMs;

    this.value = null;
    this.fetchedAt = 0;
    this.loadedAt = 0;
    this.nextRefreshAt = null;
    this.inFlight = null;
    this.timer = null;
    this.lastError = null;
  }

  async start() {
    await this.loadFromDatabase().catch((err) => {
      console.error(`[${this.name}] DB load failed:`, err.message);
    });

    this.refresh("startup").catch(() => {});
    this.scheduleNext();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  scheduleNext() {
    this.nextRefreshAt = Date.now() + this.intervalMs;
    this.timer = setTimeout(() => {
      this.refresh("scheduled").catch(() => {}).finally(() => this.scheduleNext());
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async loadFromDatabase() {
    if (!this.loadStored) return [];
    const data = await this.loadStored();
    if (Array.isArray(data) && data.length > 0) {
      const scrapedTimes = data
        .map((item) => new Date(item._scrapedAt || 0).getTime())
        .filter((time) => Number.isFinite(time) && time > 0);

      this.value = data.map(({ _scrapedAt, ...item }) => item);
      this.loadedAt = Date.now();
      if (scrapedTimes.length > 0) {
        this.fetchedAt = Math.max(...scrapedTimes);
      }
      console.log(`[${this.name}] loaded ${this.value.length} items from Supabase`);
    }
    return data;
  }

  async refresh(reason = "manual") {
    if (this.inFlight) return this.inFlight;

    const startedAt = new Date().toISOString();
    this.inFlight = (async () => {
      try {
        const data = await this.fetcher();
        const finishedAt = new Date().toISOString();
        this.value = data;
        this.fetchedAt = Date.now();
        this.lastError = null;

        if (this.saveFresh) {
          await this.saveFresh(data, finishedAt);
        }
        await this.record("success", reason, data.length, null, startedAt, finishedAt);

        console.log(`[${this.name}] refreshed ${data.length} items (${reason})`);
        return data;
      } catch (err) {
        const finishedAt = new Date().toISOString();
        this.lastError = err;
        await this.record("error", reason, null, err.message, startedAt, finishedAt);
        console.error(`[${this.name}] refresh failed:`, err.message);
        throw err;
      } finally {
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }

  async record(status, reason, itemCount, errorMessage, startedAt, finishedAt) {
    if (!this.recordRun) return;
    try {
      await this.recordRun({
        source: this.name,
        status,
        reason,
        itemCount,
        errorMessage,
        startedAt,
        finishedAt,
      });
    } catch (err) {
      console.error(`[${this.name}] scrape run log failed:`, err.message);
    }
  }

  async get() {
    if (this.value !== null) return this.value;
    if (this.inFlight) return this.inFlight;

    await this.loadFromDatabase().catch((err) => {
      console.error(`[${this.name}] DB reload failed:`, err.message);
    });

    if (this.value !== null) return this.value;
    return [];
  }

  get meta() {
    return {
      fetchedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null,
      loadedAt: this.loadedAt ? new Date(this.loadedAt).toISOString() : null,
      nextRefreshAt: this.nextRefreshAt
        ? new Date(this.nextRefreshAt).toISOString()
        : null,
      refreshing: Boolean(this.inFlight),
      count: Array.isArray(this.value) ? this.value.length : null,
      error: this.lastError ? this.lastError.message : null,
    };
  }
}
