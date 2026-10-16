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
export async function choosePracticeMap(page, map) {
  await page.getByRole('button', { name: /^Map / }).click();
  await page.getByRole('option', { name: new RegExp(`^\\d+ ${map.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).click();
}
export async function leaveGame(page) {
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Leave game', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.play-shell canvas'));
}
