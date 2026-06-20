chrome.runtime.onInstalled.addListener(() => {
  console.log('TMDB 夸克网盘影视重命名插件已安装');
});

let expandFoldersCallbacks = {};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'expandFoldersBg') {
    const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    console.log(`[BG] 收到 expandFoldersBg 请求: ${requestId}`);
    
    // 获取当前活跃标签页
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) {
        console.error('[BG] 无法获取当前标签页');
        sendResponse({ success: false, error: '无法获取当前标签页' });
        return;
      }
      
      const tabId = tabs[0].id;
      chrome.tabs.sendMessage(tabId, { action: 'expandFolders', items: request.items }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[BG] expandFolders 错误:', chrome.runtime.lastError.message);
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        console.log(`[BG] expandFolders 完成: ${response?.files?.length || 0} 个文件`);
        sendResponse({ success: true, files: response?.files || [] });
      });
    });
    
    return true;
  }
  
  if (request.action === 'captureRename') {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({}); return; }
    // 注入请求拦截器，捕获页面发出的一切 drive-pc.quark.cn 请求（fetch + XHR）
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, world: 'MAIN',
      func: () => {
        const captured = [];
        window.__capturedRequests = captured;

        const logReq = (method, url, headers, body) => {
          if (!url.includes('drive-pc.quark.cn')) return;
          const entry = { method, url, headers: Object.fromEntries(headers || []), body: (body || '').slice(0, 500), time: Date.now(), origin: window.location.href };
          captured.push(entry);
          if (captured.length <= 10) console.log('[CAPTURE]', method, url.split('?')[0], '| body:', body?.slice(0, 200));
        };

        const origFetch = window.fetch;
        window.fetch = function(input, init) {
          const url = typeof input === 'string' ? input : (input.url || '');
          logReq(init?.method || 'GET', url, init?.headers ? Object.entries(init.headers) : [], init?.body);
          return origFetch.apply(this, arguments);
        };

        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url) { this._method = method; this._url = url; return origOpen.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function(body) {
          logReq(this._method, this._url, this.getAllResponseHeaders ? [] : [], body);
          return origSend.apply(this, arguments);
        };

        console.log('[CAPTURE] ✅ 拦截器已注入（fetch + XHR），请在页面上重命名一个文件');
        return 'capturing';
      }
    }).then(() => { sendResponse({ status: 'capturing' }); }).catch(e => { sendResponse({ error: e.message }); });
    return true;
  }

  if (request.action === 'getCaptured') {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({}); return; }
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, world: 'MAIN',
      func: () => window.__capturedRequests || []
    }).then(r => {
      const allReqs = (r || []).flatMap(x => x.result || []);
      console.log('[CAPTURE] 已捕获请求总数:', allReqs.length, '(来自', r?.length || 0, '个frame)');
      sendResponse({ requests: allReqs });
    }).catch(e => { sendResponse({ error: e.message }); });
    return true;
  }

  if (request.action === 'executeRename') {
    chrome.cookies.getAll({ domain: 'quark.cn' }).then(cookies => {
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      const cookieCount = cookies.length;
      return doRename(request.files, cookieStr, cookieCount);
    }).then(res => {
      sendResponse(res);
    }).catch(err => {
      console.error('[BG] 重命名错误:', err);
      sendResponse({ success: false, error: err.message, successCount: 0, failCount: request.files.length, results: request.files.map(f => ({ id: f.id, success: false, oldName: f.oldName, newName: f.newName, error: err.message })) });
    });
    return true;
  }
});

async function doRename(files, cookieStr, cookieCount) {
  console.log(`[BG] cookie: ${cookieCount} 个`);

  const configs = [
    { label: 'std', origin: 'https://drive-pc.quark.cn', referer: 'https://drive-pc.quark.cn/' },
    { label: 'via-pan', origin: 'https://pan.quark.cn', referer: 'https://pan.quark.cn/' },
    { label: 'via-b', origin: 'https://b.quark.cn', referer: 'https://b.quark.cn/' },
  ];

  const results = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let best = null;
    // 添加重试机制，最多重试2次
    for (let retry = 0; retry < 3 && !best; retry++) {
      for (const cfg of configs) {
        if (best) break;
        try {
          const res = await fetch(`https://drive-pc.quark.cn/1/clouddrive/file/rename?pr=ucpro&fr=pc&uc_param_str=&pdir_fid=${f.parentId || f.id}`, {
            method: 'POST',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/json', 'Cookie': cookieStr, 'Origin': cfg.origin, 'Referer': cfg.referer },
            body: JSON.stringify({ fid: f.id, file_name: f.newName })
          });
          const data = await res.json();
          const ok = data.code === 0 || data.status === 0;
          console.log(`[BG][${cfg.label}] rename ${f.id} → ${f.newName} | code=${data.code} ${ok ? '✅' : '❌'}`);
          if (ok) best = { id: f.id, success: true, oldName: f.oldName || f.name, newName: f.newName };
        } catch (e) {
          console.log(`[BG][${cfg.label}] rename ${f.id} 异常:`, e.message);
        }
      }
      if (!best && retry < 2) {
        console.log(`[BG] rename ${f.id} 失败，第 ${retry+1} 次重试...`);
        await new Promise(r => setTimeout(r, 300));
      }
    }
    if (best) { results.push(best); }
    else { results.push({ id: f.id, success: false, oldName: f.oldName || f.name, newName: f.newName, error: '3种origin均失败' }); }
    
    // 动态延迟策略：文件越多，延迟越短
    if (i < files.length - 1) {
      const delay = Math.max(200, 500 - files.length * 2);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  const successCount = results.filter(x => x.success).length;
  console.log(`[BG] 完成: 成功${successCount} 失败${results.length - successCount}`);
  return { success: successCount > 0, successCount, failCount: results.length - successCount, results };
}