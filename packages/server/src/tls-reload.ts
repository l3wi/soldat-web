import { readFile } from "node:fs/promises";
import type { Server } from "node:https";

/** setSecureContext validates before swapping; failed reads/validation keep the old context. */
export function installTlsReload(server: Server, keyPath: string, certPath: string, report: (error: Error) => void = console.error): () => void {
  let loading = false, again = false, stopped = false;
  const reload = () => {
    if (stopped) return;
    if (loading) { again = true; return; }
    loading = true;
    void Promise.all([readFile(keyPath), readFile(certPath)]).then(([key, cert]) => {
      if (!stopped) server.setSecureContext({ key, cert });
    }).catch(error => report(new Error("TLS certificate reload failed; previous context retained", { cause: error }))).finally(() => {
      loading = false;
      if (again) { again = false; reload(); }
    });
  };
  process.on("SIGHUP", reload);
  return () => { stopped = true; process.off("SIGHUP", reload); };
}
