import { GAME_MODES } from "../../protocol/src/index.ts";

/** Drive only visible production-shell controls; no fake catalog or player hooks. */
export async function enterShell(page, nickname = 'Capture') {
  await page.waitForSelector('.stage:not(.boot)', { timeout: 60_000 });
  const name = page.getByRole('textbox', { name: 'Player name', exact: true });
  if (await name.count()) { await name.fill(nickname); await page.getByRole('button', { name: 'Continue [Enter]', exact: true }).click(); }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Gameplay background', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Back [Esc]', exact: true }).click();
}
export async function openPractice(page) {
  await page.getByRole('button', { name: 'Practice vs bots', exact: true }).click();
}
export async function chooseGameMode(page, label) {
  const row = page.getByRole("button", { name: /^Game type / });
  for (let attempt = 0; attempt < GAME_MODES.length; attempt++) {
    const current = await row.locator("strong").innerText();
    if (current === label) return;
    await row.click();
    await row.locator("strong").filter({ hasNotText: current }).waitFor();
  }
  throw new Error(`Game mode is unavailable: ${label}`);
}
export async function choosePracticeMap(page, map) {
  await page.getByRole('button', { name: /^Map / }).click();
  await page.getByRole('option', { name: new RegExp(`^\\d+ ${map.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).click();
}
export async function openPauseMenu(page) {
  // Chat/team overlays consume Escape before the shell pause menu.
  // Let focus and React's screen update settle before issuing another key.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await page.locator('.stage.pause').isVisible()) return;
    await page.keyboard.press('Escape');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  }
  await page.waitForSelector('.stage.pause');
}
export async function leaveGame(page) {
  await openPauseMenu(page);
  await page.getByRole('button', { name: 'Leave game', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.play-shell canvas'));
}
