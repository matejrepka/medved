// Jednoduchá vyrovnávacia pamäť (cache) s časovou platnosťou.
//
// Dáta nesťahujeme pri každom requeste — to by zbytočne zaťažovalo
// tumedved.sk aj Google News. Namiesto toho výsledok uložíme a po dobu
// `ttlMs` ho vraciame z pamäte. Po vypršaní sa stiahne na pozadí.

export class TtlCache {
  /**
   * @param {() => Promise<any>} fetcher funkcia, ktorá stiahne čerstvé dáta
   * @param {number} ttlMs platnosť v milisekundách
   * @param {string} name názov pre logy
   */
  constructor(fetcher, ttlMs, name = "cache") {
    this.fetcher = fetcher;
    this.ttlMs = ttlMs;
    this.name = name;
    this.value = null;
    this.fetchedAt = 0;
    this.inFlight = null; // zabráni súbežnému viacnásobnému sťahovaniu
    this.lastError = null;
  }

  get isFresh() {
    return this.value !== null && Date.now() - this.fetchedAt < this.ttlMs;
  }

  async _refresh() {
    if (this.inFlight) return this.inFlight; // už sa sťahuje — pripojíme sa
    this.inFlight = (async () => {
      try {
        const data = await this.fetcher();
        this.value = data;
        this.fetchedAt = Date.now();
        this.lastError = null;
        console.log(`[${this.name}] obnovené — ${Array.isArray(data) ? data.length : "?"} položiek`);
        return data;
      } catch (err) {
        this.lastError = err;
        console.error(`[${this.name}] chyba pri sťahovaní:`, err.message);
        throw err;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /**
   * Vráti dáta. Ak sú čerstvé, ihneď z pamäte. Ak vypršali, ale máme
   * staršiu kópiu, vrátime ju a obnovíme na pozadí (stale-while-revalidate).
   * Ak nemáme nič, počkáme na prvé stiahnutie.
   */
  async get() {
    if (this.isFresh) return this.value;

    if (this.value !== null) {
      this._refresh().catch(() => {}); // obnov na pozadí, chybu ignoruj
      return this.value;
    }

    return this._refresh();
  }

  /** Vynúti čerstvé stiahnutie a počká naň. */
  async forceRefresh() {
    this.fetchedAt = 0;
    return this._refresh();
  }

  get meta() {
    return {
      fetchedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null,
      fresh: this.isFresh,
      count: Array.isArray(this.value) ? this.value.length : null,
      error: this.lastError ? this.lastError.message : null,
    };
  }
}
