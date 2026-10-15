export interface ContentPin {
  repo: string;
  commit: string;
}

export interface Provenance {
  sourceRepo: string;
  sourceCommit: string;
  sourcePath: string;
  sourceSha256: string;
  licenseId: string;
  credit: string;
  transformations: string[];
}

export interface MapManifest {
  path: string;
  mapSha256: string;
  simContentSha256: string;
  botCapable: boolean;
  missing: { kind: string; requested: string; active: boolean; fallback: string | null }[];
}

/** Metadata only: loading this index never requests images, audio or map bodies. */
export interface ContentManifest {
  schemaVersion: number;
  pins: { base: ContentPin; opensoldat: ContentPin };
  simContentSha256: string;
  alphaMode: string;
  maps: Record<string, MapManifest>;
  objects: Record<string, { sha256: string; bytes: number; provenance: Provenance[] }>;
}

export function contentUrl(path: string): string {
  return `/content/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export async function loadContentManifest(signal?: AbortSignal): Promise<ContentManifest> {
  const response = await fetch(contentUrl('manifest.json'), { signal });
  if (!response.ok) throw new Error(`Content index could not load (HTTP ${response.status}).`);
  return response.json() as Promise<ContentManifest>;
}

export const CONTENT_NOTICES = [
  { path: 'notices/base-credits.txt', title: 'Base content contributor credits' },
  { path: 'notices/base-license.txt', title: 'Base content — Creative Commons Attribution 4.0' },
  { path: 'notices/opensoldat-mit.txt', title: 'OpenSoldat — MIT license' },
  { path: 'notices/play-OFL.txt', title: 'Play font — SIL Open Font License 1.1' },
] as const;

export interface ContentNotice {
  path: string;
  title: string;
  text: string | null;
  error: string | null;
}

export async function loadContentNotices(signal: AbortSignal): Promise<ContentNotice[]> {
  return Promise.all(CONTENT_NOTICES.map(async notice => {
    try {
      const response = await fetch(contentUrl(notice.path), { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { ...notice, text: await response.text(), error: null };
    } catch (error) {
      if (signal.aborted) throw error;
      return { ...notice, text: null, error: error instanceof Error ? error.message : String(error) };
    }
  }));
}

export function sourceUrl(repo: string, commit: string, path = ''): string {
  return `${repo.replace(/\.git$/, '')}/tree/${encodeURIComponent(commit)}${path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : ''}`;
}

// Historical map credits from the official 1.7.1.1 manual. These are attribution,
// not a claim that the classic installer is a source of shipped content.
export const HISTORIC_MAP_CREDITS = [
  ['Evil Ville; remake by X-Tender', 'Airpirates-XT'],
  ['chakapoko maker', 'Bigfalls, Daybreak, inf_Moonshine, Blox, ctf_Snakebite, ctf_Ash, Island2k5'],
  ['Avarax', 'Tropiccave'],
  ['viggoloniggolo', 'Factory'],
  ['Doggfather', 'ctf_Chernobyl, ctf_Equinox'],
  ['Deo', 'ctf_Crashed'],
  ['Boxo (and Vigg)', 'ctf_Dropdown, ctf_Dropdown2, ctf_Division'],
  ['Enjoyincubus', 'inf_Normandy; improvements to inf_Outpost, MrSnowman, Bridge, Bunker, ctf_Viet'],
  ['Sticky', 'htf_Arch'],
  ['grand_diablo', 'ctf_Maya, htf_Boxed, htf_Futura, htf_Nuclear, DesertWind, htf_Rubik, ctf_Maya2, ctf_Lanubya, inf_Messner; remakes of Arena2, ctf_Death2'],
  ['DeMonIc', 'htf_Desert'],
  ['Troskal', 'ctf_Nuubia'],
  ['Michal', 'htf_Dusk'],
  ['The Geologist; waypoints by Keron Cyst', 'htf_Muygen'],
  ['Demonic', 'ctf_Conquest, ctf_Cobra'],
  ['Keron Cyst', 'htf_Zajacz; most waypoints and map fixes'],
  ['NuZZ', 'ctf_Death remake'],
  ['Stalky', 'HH remake'],
] as const;
