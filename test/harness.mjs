// 本機模擬環境：node:sqlite 模擬 D1、Map 模擬 R2。只供開發測試，不會部署。
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

class Stmt {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params.map(p => Array.isArray(p) ? new Uint8Array(p) : p);
  }
  bind(...p) {
    for (const v of p) if (v === undefined) throw new Error("D1_TYPE_ERROR: undefined bind in: " + this.sql);
    return new Stmt(this.db, this.sql, p);
  }
  _s() {
    return this.db.sqlite.prepare(this.sql);
  }
  async first(col) {
    const row = this._s().get(...this.params);
    if (!row) return null;
    const plain = { ...row };
    return col ? plain[col] : plain;
  }
  async all() {
    return { results: this._s().all(...this.params).map((r) => ({ ...r })), success: true };
  }
  async run() {
    const s = this._s();
    if (/\breturning\b/i.test(this.sql)) {
      const rows = s.all(...this.params);
      return { results: rows, meta: { changes: rows.length } };
    }
    const r = s.run(...this.params);
    return { meta: { changes: Number(r.changes) }, success: true };
  }
  _exec() {
    const s = this._s();
    if (/^\s*(select|with)\b/i.test(this.sql) || /\breturning\b/i.test(this.sql)) {
      return { results: s.all(...this.params).map((r) => ({ ...r })) };
    }
    const r = s.run(...this.params);
    return { results: [], meta: { changes: Number(r.changes) } };
  }
}

export class FakeD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON;");
    this.failNextBatch = false;
  }
  migrate(file) {
    this.sqlite.exec(readFileSync(file, "utf8"));
  }
  prepare(sql) {
    return new Stmt(this, sql);
  }
  async batch(stmts) {
    if (this.failNextBatch) {
      this.failNextBatch = false;
      throw new Error("simulated D1 failure");
    }
    this.sqlite.exec("BEGIN");
    try {
      const out = stmts.map((s) => s._exec());
      this.sqlite.exec("COMMIT");
      return out;
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }
}

export class FakeR2 {
  constructor() {
    this.objects = new Map();
  }
  async put(key, value, opts = {}) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    if (opts.sha256) {
      const h = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
      if (h !== opts.sha256) throw new Error("R2 sha256 mismatch");
    }
    this.objects.set(key, { bytes: new Uint8Array(bytes), httpMetadata: opts.httpMetadata, customMetadata: opts.customMetadata, uploaded: new Date() });
    return { key, size: bytes.byteLength };
  }
  async head(key) {
    const o = this.objects.get(key);
    if (!o) return null;
    return { key, size: o.bytes.byteLength, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata, uploaded: o.uploaded };
  }
  async get(key) {
    const o = this.objects.get(key);
    if (!o) return null;
    return { body: new Blob([o.bytes]).stream(), size: o.bytes.byteLength, httpMetadata: o.httpMetadata };
  }
  async delete(keys) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
  async list({ limit = 1000 } = {}) {
    const objects = [...this.objects.entries()].slice(0, limit).map(([key, o]) => ({ key, size: o.bytes.byteLength, uploaded: o.uploaded }));
    return { objects, truncated: false };
  }
}

export function makeEnv() {
  const DB = new FakeD1();
  DB.migrate(new URL("../migrations/0001_init.sql", import.meta.url));
  DB.migrate(new URL("../migrations/0002_upload_slots.sql", import.meta.url));
  DB.migrate(new URL("../migrations/0003_import_staging.sql", import.meta.url));
  DB.migrate(new URL("../migrations/0004_ai_workflow.sql", import.meta.url));
  DB.migrate(new URL("../migrations/0005_taxonomy_layout.sql", import.meta.url));
  DB.migrate(new URL("../migrations/0006_price_settings.sql", import.meta.url));
  DB.migrate(new URL("../migrations/0007_d1_thumbnails.sql", import.meta.url));
  DB.migrate(new URL("../migrations/0008_doll_dressing.sql", import.meta.url));
  DB.migrate(new URL("../migrations/0009_avatar_v2.sql", import.meta.url));
  DB.migrate(new URL("../migrations/0010_doll_phase3.sql", import.meta.url));
  return {
    DB,
    IMAGES: new FakeR2(),
    ASSETS: { fetch: async () => new Response("<!doctype html><title>asset</title>", { headers: { "content-type": "text/html" } }) },
    MAX_UPLOAD_MB: "25",
    TOKEN_DAILY_CALL_LIMIT: "3000",
    TOKEN_DAILY_UPLOAD_MB: "800",
    UPLOAD_LINK_MAX_MINUTES: "1440",
  };
}
