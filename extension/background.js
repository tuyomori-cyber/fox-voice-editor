const EDITOR_URL = browser.runtime.getURL("editor.html");

browser.action.onClicked.addListener(async () => {
  const existing = await browser.tabs.query({ url: EDITOR_URL });
  if (existing.length > 0) {
    const tab = existing[0];
    await browser.tabs.update(tab.id, { active: true });
    await browser.windows.update(tab.windowId, { focused: true });
    return;
  }
  await browser.tabs.create({ url: EDITOR_URL });
});
