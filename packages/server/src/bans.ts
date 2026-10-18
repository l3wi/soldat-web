import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isIP } from 'node:net';
import type { BanSummary } from '@soldat-web/protocol';
import { sourceIp } from './hardening.ts';

function validAddress(address: string): boolean {
  return Boolean(isIP(address) || (address.endsWith('/64') && isIP(address.slice(0,-3)) === 6 && sourceIp(address.slice(0,-3)) === address));
}
export interface BanRecord extends BanSummary { address: string }
/** Global stores are shared by every match; local stores never escape their match. */
export class BanStore {
  private records: BanRecord[] = [];
  private pending: Promise<unknown> = Promise.resolve();
  private readonly file: string | undefined;
  private constructor(file?: string) { this.file = file; }
  static async load(file?: string): Promise<BanStore> {
    if (file !== undefined && (typeof file !== 'string' || !file.trim())) throw new Error('Invalid banFile');
    const store = new BanStore(file === undefined ? undefined : resolve(file));
    if (!file) return store;
    let text: string;
    try { const handle = await open(resolve(file), 'r'); try { const info = await handle.stat(); if (info.size > 512 * 1024) throw new Error('Ban file exceeds limit'); text = await handle.readFile('utf8'); } finally { await handle.close(); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return store; throw error; }
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data) || data.length > 256) throw new Error('Invalid ban file');
    const ids = new Set<string>();
    for (const entry of data) {
      if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== 'address,expiresAt,global,id,nickname,reason' || typeof entry.id !== 'string' || !/^[a-f0-9-]{36}$/.test(entry.id) || ids.has(entry.id) || typeof entry.address !== 'string' || !validAddress(entry.address) || typeof entry.nickname !== 'string' || !entry.nickname.length || Buffer.byteLength(entry.nickname) > 48 || typeof entry.reason !== 'string' || Buffer.byteLength(entry.reason) > 256 || /[\p{Cc}\p{Cf}]/u.test(entry.nickname + entry.reason) || !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt < 0 || entry.expiresAt > Date.now() + 43200 * 60000 || entry.global !== true) throw new Error('Invalid ban file record');
      ids.add(entry.id);
      if (entry.expiresAt > Date.now()) store.records.push(entry as BanRecord);
    }
    return store;
  }
  contains(address: string): boolean { return this.records.some(b => b.address === address && b.expiresAt > Date.now()); }
  summaries(): BanSummary[] { return this.records.filter(b => b.expiresAt > Date.now()).map(({address: _address,...summary}) => summary); }
  add(address: string, nickname: string, minutes: number, reason: string, global: boolean): Promise<BanRecord> {
    if (!validAddress(address) || !Number.isInteger(minutes) || minutes < 1 || minutes > 43200 || !nickname || Buffer.byteLength(nickname)>48 || Buffer.byteLength(reason)>256 || /[\p{Cc}\p{Cf}]/u.test(nickname+reason) || (this.file && !global)) return Promise.reject(new Error('Invalid ban'));
    return this.change(records => {
      if (records.length >= 256 && !records.some(b=>b.address===address)) throw new Error('Ban capacity reached; unban an entry first');
      const record: BanRecord = {id:randomUUID(),address,nickname,reason,expiresAt:Date.now()+minutes*60000,global};
      return {records:[...records.filter(b=>b.address!==address),record],result:record};
    });
  }
  remove(id: string): Promise<boolean> { return this.change(records => ({records:records.filter(b=>b.id!==id),result:records.some(b=>b.id===id)})); }
  private change<T>(update:(records:BanRecord[])=>{records:BanRecord[];result:T}):Promise<T> {
    const next=this.pending.then(async()=>{
      const changed=update(this.records.filter(b=>b.expiresAt>Date.now()));
      if(this.file) {
        const temporary=`${this.file}.${randomUUID()}.tmp`;
        try { const handle=await open(temporary,'wx',0o600); try { await handle.writeFile(JSON.stringify(changed.records)); await handle.sync(); } finally { await handle.close(); } await rename(temporary,this.file); const directory=await open(dirname(this.file),'r'); try { await directory.sync(); } finally { await directory.close(); } }
        catch(error) { await unlink(temporary).catch(()=>{}); throw error; }
      }
      this.records=changed.records;
      return changed.result;
    });
    this.pending=next.catch(()=>{}); return next;
  }
  async flush():Promise<void> { await this.pending; }
}
