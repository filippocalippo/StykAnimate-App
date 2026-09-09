import {chromium} from 'playwright';
import {writeFile} from 'node:fs/promises';
const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  const page = await browser.newPage(); await page.goto('http://127.0.0.1:47831/');
  await page.waitForFunction(() => styk?.ready);
  const write = await page.evaluate(() => new Promise(resolve => {
    const req = indexedDB.open('styk-recovery-storage-test', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('records');
    req.onsuccess = () => {
      const db = req.result, tx = db.transaction('records', 'readwrite');
      tx.objectStore('records').put({text: 'source document', blob: new Blob(['source document'], {type: 'application/json'})}, 'latest');
      tx.oncomplete = () => { db.close(); localStorage.setItem('styk-storage-test', 'saved'); resolve({event: 'complete'}); };
      tx.onerror = () => { resolve({error: tx.error?.message}); db.close(); };
      tx.onabort = () => { resolve({abort: tx.error?.message}); db.close(); };
    }; req.onerror = () => resolve({openError: req.error?.message});
  }));
  await page.reload(); await page.waitForFunction(() => styk?.ready);
  const read = await page.evaluate(() => new Promise(resolve => {
    const req = indexedDB.open('styk-recovery-storage-test', 1);
    req.onsuccess = () => {
      const db = req.result, tx = db.transaction('records'), get = tx.objectStore('records').get('latest');
      get.onsuccess = () => resolve({text: get.result?.text, blobSize: get.result?.blob?.size, local: localStorage.getItem('styk-storage-test')});
      get.onerror = () => resolve({error: get.error?.message}); tx.oncomplete = () => db.close();
    }; req.onerror = () => resolve({openError: req.error?.message});
  }));
  const result = {write, read}; console.log(JSON.stringify(result, null, 2));
  await writeFile('artifacts/recovery-storage.json', JSON.stringify(result, null, 2));
} finally { await browser.close(); }
