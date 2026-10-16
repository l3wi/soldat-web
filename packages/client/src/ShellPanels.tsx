import { useEffect, useMemo, useRef, useState } from 'react';
import { mountGame, type GameMountOptions } from './game';
import type { Settings } from './settings';
import {
  HISTORIC_MAP_CREDITS, contentUrl, loadContentManifest, loadContentNotices, sourceUrl,
  type ContentIndex, type ContentManifest, type ContentNotice,
} from './content';
import { DEFAULT_SANDBOX, type SandboxOptions } from './sandbox-options';
export function GameSurface({ map, settings, sandbox = DEFAULT_SANDBOX, onStatus, capture = false, serverUrl, mountOptions, still = false }: {
  map: string; settings: Settings; sandbox?: SandboxOptions; onStatus?: (status: string) => void; capture?: boolean;
  serverUrl?: string; mountOptions?: GameMountOptions; still?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    let active = true;
    let destroy: (() => void) | undefined;
    try {
      destroy = mountGame(container.current, map, settings, status => { if (active) onStatus?.(status); }, sandbox, { ...mountOptions, serverUrl, paused: still });
    } catch (error) {
      onStatus?.(`Could not start ${map}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return () => { active = false; destroy?.(); };
  }, [map, settings, sandbox, onStatus, serverUrl, mountOptions, still]);
  return <div ref={container} className={capture ? 'game-surface capture-surface' : 'game-surface'} aria-label={`${map} game canvas`} />;
}


export function CreditsPanel({ manifest: index }: { manifest: ContentIndex | null }) {
  const [manifest, setManifest] = useState<ContentManifest | null>(null);
  const [manifestError, setManifestError] = useState('');
  const [notices, setNotices] = useState<ContentNotice[] | null>(null);
  const [noticeError, setNoticeError] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    loadContentManifest(abort.signal).then(value => { if (!abort.signal.aborted) setManifest(value); })
      .catch(error => { if (!abort.signal.aborted) setManifestError(error instanceof Error ? error.message : String(error)); });
    loadContentNotices(abort.signal).then(setNotices).catch(error => { if (!abort.signal.aborted) setNoticeError(error instanceof Error ? error.message : String(error)); });
    return () => abort.abort();
  }, []);
  const provenance = useMemo(() => manifest ? Object.entries(manifest.objects).flatMap(([object, entry]) =>
    entry.provenance.map((source, index) => ({ object, hash: entry.sha256, source, key: `${object}:${index}` }))) : [], [manifest]);
  const matching = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return provenance.filter(({ object, source }) => !needle || `${object} ${source.sourcePath} ${source.credit} ${source.licenseId}`.toLowerCase().includes(needle));
  }, [provenance, query]);
  const transformations = useMemo(() => [...new Set(provenance.flatMap(({ source }) => source.transformations))].sort(), [provenance]);
  const pageSize = 24;
  return <div className="credits">
    <p className="section-intro">Unofficial browser game using open-licensed Soldat/OpenSoldat content. Not affiliated with or endorsed by Michał Marcinkowski, Transhuman Design, or the OpenSoldat contributors.</p>
    <section>
      <h3>Creators & contributions</h3>
      <p>Michał Marcinkowski / Transhuman Design; OpenSoldat contributors. Historic graphics contributions include Monster and L[one]R.</p>
      <p>AEfremov contributed kit artwork; pewpew (BranDougherty) contributed interface icons. The complete shipped upstream credits text is below; upstream describes its list as incomplete.</p>
      <p>Play font: © 2011 Jonas Hecksher / Playtype / e-types AS, licensed under SIL OFL 1.1. The font is distributed unmodified.</p>
      <p>Toolchain recipe attribution: <a target="_blank" rel="noopener noreferrer" href="https://github.com/humanova/soldat-web">humanova/soldat-web</a> (MIT).</p>
      <p>Base assets: <a target="_blank" rel="noopener noreferrer" href="https://creativecommons.org/licenses/by/4.0/">Creative Commons Attribution 4.0</a>. OpenSoldat source: MIT, except individually identified components. <a target="_blank" rel="noopener noreferrer" href="https://github.com/opensoldat/opensoldat/blob/bf43a43bdd7a069e02c906768807f66e621b2888/shared/Vector.pas">Vector.pas source and retained notice</a>: MPL 1.1, JEDI/Direct3DX-derived code. <a target="_blank" rel="noopener noreferrer" href="https://www.mozilla.org/MPL/1.1/">Read MPL 1.1</a>.</p>
      {index && <dl className="pins">
        <dt>Base content pin</dt><dd><a target="_blank" rel="noopener noreferrer" href={sourceUrl(index.pins.base.repo, index.pins.base.commit)}><code>{index.pins.base.commit}</code></a></dd>
        <dt>OpenSoldat source pin</dt><dd><a target="_blank" rel="noopener noreferrer" href={sourceUrl(index.pins.opensoldat.repo, index.pins.opensoldat.commit)}><code>{index.pins.opensoldat.commit}</code></a></dd>
      </dl>}
    </section>
    <details>
      <summary>Known historic map authors</summary>
      <p>Preserved from the official 1.7.1.1 manual; historic titles may differ from the imported catalog. No classic installer assets are shipped. <a target="_blank" rel="noopener noreferrer" href="https://opensoldat.github.io/manual/manual.html#license">Manual credits</a></p>
      <dl className="map-credits">{HISTORIC_MAP_CREDITS.map(([author, maps]) => <div key={`${author}:${maps}`}><dt>{author}</dt><dd>{maps}</dd></div>)}</dl>
    </details>
    <section>
      <h3>Served notices & licenses</h3>
      {!notices && !noticeError && <p role="status">Loading notice texts…</p>}
      {noticeError && <p role="alert">Could not load notices: {noticeError}</p>}
      {notices?.map(notice => <details key={notice.path}>
        <summary>{notice.title}</summary>
        <p><a target="_blank" rel="noopener noreferrer" href={contentUrl(notice.path)}>Open original notice text</a></p>
        {notice.error ? <p role="alert">Notice unavailable: {notice.error}</p> : <pre className="notice-text">{notice.text}</pre>}
      </details>)}
    </section>
    <section>
      <h3>Browser transformations</h3>
      <p>Source images are decoded to straight-alpha PNG frames with exact color-key handling where recorded. GPU upload premultiplies alpha once. PCM sound is preserved; MS-ADPCM is converted to PCM16. Source tables and overrides become structured data. Per-file changes and source hashes are listed below.</p>
      <details><summary>Transformation identifiers from this bundle</summary><ul>{transformations.map(item => <li key={item}><code>{item}</code></li>)}</ul></details>
    </section>
    <section>
      <h3>Per-file provenance</h3>
      {manifestError && <p role="alert">Could not load provenance: {manifestError}</p>}
      {!manifest ? <p role="status">{manifestError ? 'Provenance unavailable.' : 'Loading full provenance…'}</p> : <>
        <p><a target="_blank" rel="noopener noreferrer" href={contentUrl('manifest.json')}>Open full content manifest</a>. Every contribution retains its credit, license, source pin, source hash and ordered transformations.</p>
        <label>Find a source path, creator or license<input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
        <p className="muted" role="status">{matching.length} provenance records{matching.length > 0 ? `; showing ${page * pageSize + 1}–${Math.min((page + 1) * pageSize, matching.length)}` : ''}.</p>
        <div className="provenance-list">{matching.slice(page * pageSize, (page + 1) * pageSize).map(({ key, object, hash, source }) => <details key={key}>
          <summary>{source.sourcePath} <span className="license-tag">{source.licenseId}</span></summary>
          <dl>
            <dt>Credit</dt><dd>{source.credit}</dd>
            <dt>Source</dt><dd><a target="_blank" rel="noopener noreferrer" href={sourceUrl(source.sourceRepo, source.sourceCommit, source.sourcePath)}>{source.sourceRepo} / {source.sourcePath}</a></dd>
            <dt>Pinned commit</dt><dd><code>{source.sourceCommit}</code></dd>
            <dt>Source SHA-256</dt><dd><code>{source.sourceSha256}</code></dd>
            <dt>Output</dt><dd><code>{object}</code></dd>
            <dt>Output SHA-256</dt><dd><code>{hash}</code></dd>
            <dt>Transformations</dt><dd>{source.transformations.length ? <ol>{source.transformations.map((item, index) => <li key={index}><code>{item}</code></li>)}</ol> : 'None; original bytes preserved.'}</dd>
          </dl>
        </details>)}</div>
        <div className="form-actions">
          <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous records</button>
          <button type="button" disabled={(page + 1) * pageSize >= matching.length} onClick={() => setPage(page + 1)}>Next records</button>
        </div>
      </>}
    </section>
  </div>;
}
