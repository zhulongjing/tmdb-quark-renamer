// ==================== DOM 文件检测 ====================

// 状态管理
let isRenameInProgress = false;
let currentRenameId = null;

// iframe 缓存加速
let cachedIframeEl = null;
let iframeReady = false;

function getCachedIframe() {
  if (cachedIframeEl && cachedIframeEl.contentWindow) return cachedIframeEl;
  return null;
}

function startIframeMonitor() {
  if (window.self !== window.top) return;
  const check = () => {
    if (cachedIframeEl && cachedIframeEl.contentWindow) return;
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes){
      if (iframe.src && iframe.src.includes('b.quark.cn')) {
        cachedIframeEl = iframe;
        break;
      }
    }
  };
  check();
  const observer = new MutationObserver(() => check());
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => observer.observe(document.body, { childList: true, subtree: true }));
  }
}

window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'QUARK_IFRAME_READY') {
    iframeReady = true;
  }
});

startIframeMonitor();

// 清理状态
function resetContentState() {
  isRenameInProgress = false;
  currentRenameId = null;
  console.log('[夸克-CS] 内容脚本状态已重置');
}

function getCurrentDirName() {
  const hash = window.location.hash;
  const m = hash.match(/\/([^/]+)$/);
  if (m) {
    const seg = decodeURIComponent(m[1]);
    return seg.replace(/^[a-f0-9]+-/, '').trim();
  }
  return '';
}

function getCheckedFilesFromDOM() {
  const results = [];
  const seen = new Set();

  const checkedBoxes = document.querySelectorAll('input[type="checkbox"]:checked');
  console.log(`[夸克-CS] DOM检测: 找到 ${checkedBoxes.length} 个勾选的checkbox`);
  for (const cb of checkedBoxes) {
    const row = cb.closest('tr, [class*="row"], [class*="file"], [class*="item"], li, div[class*="list"] > div');
    if (!row) continue;
    const info = extractFileInfo(row);
    if (info.fid && info.name && !seen.has(info.fid)) {
      seen.add(info.fid);
      results.push({ id: info.fid, name: info.name, isFolder: info.isFolder });
    }
  }

  console.log(`[夸克-CS] DOM检测完成: ${results.length} 个文件`);
  return results;
}

async function getAllFilesInCurrentFolder() {
  const folderId = getFolderId();
  console.log(`[夸克-CS] 当前目录ID: ${folderId}`);

  // 直接API获取（不依赖iframe，所有夸克页面都能跨域请求）
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const url = `https://drive-pc.quark.cn/1/clouddrive/file/sort?pr=ucpro&fr=pc&uc_param_str=&pdir_fid=${folderId}&_page=1&_size=500&_fetch_total=1&_fetch_sub_dirs=0&_sort=file_type:asc,updated_at:desc`;
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data && data.data && data.data.list) {
        const files = data.data.list.map(f => ({
          id: f.fid,
          name: f.file_name,
          isFolder: !!(f.is_folder === 1 || f.type === 'folder' || f.object_type === 'folder' || f.dir === true)
        }));
        console.log(`[夸克-CS] 直接API获取: ${files.length} 个文件`);
        return files;
      }
    } catch (e) {
      console.error(`[夸克-CS] API获取失败 (尝试 ${attempt}/3):`, e);
      if (attempt < 3) await new Promise(r => setTimeout(r, 300));
    }
  }

  // API获取失败，回退到iframe postMessage
  return new Promise((resolve) => {
    const id = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const handler = (event) => {
      if (event.data && event.data.type === 'QUARK_LIST_RESULT' && event.data.id === id) {
        window.removeEventListener('message', handler);
        const files = (event.data.files || []).map(f => ({
          id: f.id,
          name: f.name,
          isFolder: f.isFolder
        }));
        console.log(`[夸克-CS] iframe获取: ${files.length} 个文件`);
        resolve(files);
      }
    };
    window.addEventListener('message', handler);

    const tryPostMessage = (attempt = 1) => {
      if (attempt > 40) {
        console.log('[夸克-CS] iframe 等待超时');
        window.removeEventListener('message', handler);
        resolve([]);
        return;
      }
      let targetIframe = getCachedIframe();
      if (!targetIframe) {
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
          if (iframe.src && iframe.src.includes('b.quark.cn')) {
            targetIframe = iframe;
            break;
          }
        }
      }
      if (targetIframe && targetIframe.contentWindow) {
        try {
          targetIframe.contentWindow.postMessage({ type: 'QUARK_LIST_FILES', folderId, id }, '*');
          console.log(`[夸克-CS] 已发送列表请求到 iframe (尝试 ${attempt})`);
        } catch (e) {
          console.error('[夸克-CS] postMessage 失败:', e);
          window.removeEventListener('message', handler);
          resolve([]);
        }
      } else {
        console.log(`[夸克-CS] iframe 未就绪，等待... (尝试 ${attempt}/${40})`);
        setTimeout(() => tryPostMessage(attempt + 1), 100);
      }
    };

    tryPostMessage();

    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve([]);
    }, 12000);
  });
}

function getFolderId() {
  const hash = window.location.hash;
  const match = hash.match(/\/([a-f0-9]{32})[^/]*$/);
  if (match) return match[1];
  const pathname = window.location.pathname;
  const pathMatch = pathname.match(/\/([a-f0-9]{32})/);
  if (pathMatch) return pathMatch[1];
  return '0';
}

function isActionText(text) {
  const keywords = '上传,下载,分享,删除,移动,复制,预览,播放,全选,更多,操作,菜单,rename,delete,download,share,move,copy,preview,play'.split(',');
  return keywords.some(k => text.includes(k));
}

function isFolderElement(el) {
  const n = (el.textContent || '').trim();
  if (/^S\d{2}$/.test(n)) return true;
  const cls = el.className || '';
  if (/\bfolder\b/i.test(cls) || /\bdir\b/i.test(cls) || /\bdirectory\b/i.test(cls)) return true;
  if (el.matches && el.matches('[class*="folder"], [class*="dir-"], [data-type="folder"], [data-object-type="folder"]')) return true;
  const icon = el.querySelector('.icon-folder, [class*="folder"], [class*="dir-"], [class*="directory"], [class*="file-folder"]');
  if (icon) return true;
  const row = el.closest('tr, [class*="row"], [class*="item"]');
  if (row) {
    const rc = row.className || '';
    if (/\bfolder\b/i.test(rc) || /\bdir\b/i.test(rc)) return true;
    if (row.querySelector('[class*="folder-icon"], [class*="dir-icon"], [class*="file-folder"]')) return true;
    if (row.querySelector('a[href*="/folder/"]')) return true;
    if (row.querySelector('svg[class*="folder"], svg[class*="dir"]')) return true;
  }
  return false;
}

function extractFileInfo(row) {
  let fid = row.getAttribute('data-fid') || row.getAttribute('data-id') || row.getAttribute('data-row-key') || row.getAttribute('data-file-id') || '';
  if (!fid) {
    const el = row.querySelector('[data-fid], [data-id], [data-row-key], [data-file-id]');
    if (el) fid = el.getAttribute('data-fid') || el.getAttribute('data-id') || el.getAttribute('data-row-key') || el.getAttribute('data-file-id') || '';
  }
  if (!fid) {
    const link = row.querySelector('a[href*="fid="], a[href*="/file/"], a[href*="/folder/"]');
    if (link) {
      const m = link.href.match(/fid=([^&]+)/) || link.href.match(/\/file\/([^/?]+)/) || link.href.match(/\/folder\/([^/?]+)/);
      if (m) fid = m[1];
    }
  }

  let name = '';
  const icon = row.querySelector('[class*="icon-file"], [class*="icon-video"], [class*="icon-folder"], svg');
  if (icon) {
    const ns = icon.nextElementSibling;
    if (ns) {
      const t = (ns.textContent || ns.getAttribute('title') || '').trim();
      if (t && t.length > 0 && t.length < 300 && !isActionText(t)) name = t;
    }
  }
  if (!name) {
    for (const sel of ['[class*="file-name"]', '[class*="filename"]', '[class*="name"]', 'td:nth-child(2)', '[class*="title"]', 'a[title]', '[title]', '.ant-table-cell']) {
      const el = row.querySelector(sel);
      if (el) {
        const t = (el.getAttribute('title') || el.textContent || '').trim();
        if (t && t.length > 0 && t.length < 300 && !isActionText(t)) {
          if (/\.[a-zA-Z0-9]{2,5}$/.test(t)) { name = t; break; }
          if (!isActionText(t)) { name = t; break; }
        }
      }
    }
  }
  if (!name) {
    const clone = row.cloneNode(true);
    clone.querySelectorAll('input, button, .ant-checkbox, [class*="btn"], [class*="action"]').forEach(e => e.remove());
    const lines = (clone.textContent || '').split(/\n/).map(s => s.trim()).filter(s => s.length > 0 && s.length < 300 && !isActionText(s));
    if (lines.length > 0) name = lines[0];
  }

  if (name) {
    name = name.replace(/^上传到当前目录/, '');
    name = name.replace(/^.*[\\/]/, '');
    name = name.trim();
  }

  return { fid, name, isFolder: isFolderElement(row) || (row && !!row.querySelector('a[href*="/folder/"]')) };
}

// ==================== 文件夹扩展 ====================

async function getFilesInFolder(folderId) {
  if (window.location.hostname === 'b.quark.cn') {
    try {
      const url = `https://drive-pc.quark.cn/1/clouddrive/file/sort?pr=ucpro&fr=pc&uc_param_str=&pdir_fid=${folderId}&_page=1&_size=500&_fetch_total=1&_fetch_sub_dirs=0&_sort=file_type:asc,updated_at:desc`;
      const res = await fetch(url, { credentials: 'include' });
      const data = await res.json();
      if (data && data.data && data.data.list) {
        const files = data.data.list.map(f => ({
          id: f.fid, name: f.file_name,
          isFolder: !!(f.is_folder === 1 || f.type === 'folder' || f.object_type === 'folder' || f.dir === true),
          parentId: folderId
        }));
        console.log(`[夸克-CS] b.quark.cn 直接获取文件夹 ${folderId} 文件: ${files.length} 个`);
        return files;
      }
    } catch (e) { console.error('[夸克-CS] b.quark.cn 文件夹获取失败:', e); }
    return [];
  }

  return new Promise((resolve) => {
      const id = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      const handler = (event) => {
        if (event.data && event.data.type === 'QUARK_LIST_RESULT' && event.data.id === id) {
          window.removeEventListener('message', handler);
          const files = (event.data.files || []).map(f => ({ ...f, parentId: folderId }));
          console.log(`[夸克-CS] iframe获取文件夹 ${folderId} 文件: ${files.length} 个`);
          resolve(files);
        }
      };
      window.addEventListener('message', handler);

      const tryPostMessage = (attempt = 1) => {
        if (attempt > 40) {
          console.log('[夸克-CS] iframe 等待超时');
          window.removeEventListener('message', handler);
          resolve([]);
          return;
        }
        let targetIframe = getCachedIframe();
        if (!targetIframe) {
          const iframes = document.querySelectorAll('iframe');
          for (const iframe of iframes) {
            if (iframe.src && iframe.src.includes('b.quark.cn')) {
              targetIframe = iframe;
              break;
            }
          }
        }
        if (targetIframe && targetIframe.contentWindow) {
          try {
            targetIframe.contentWindow.postMessage({ type: 'QUARK_LIST_FILES', folderId, id }, '*');
            console.log(`[夸克-CS] 已发送文件夹列表请求到 iframe: ${folderId} (尝试 ${attempt})`);
          } catch (e) {
            console.error('[夸克-CS] postMessage 失败:', e);
            window.removeEventListener('message', handler);
            resolve([]);
          }
        } else {
          console.log(`[夸克-CS] iframe 未就绪，等待... (尝试 ${attempt}/${40})`);
          setTimeout(() => tryPostMessage(attempt + 1), 100);
        }
      };

      tryPostMessage();

      setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve([]);
      }, 12000);
    });
}

function getSeasonNumber(folderName) {
  const n = folderName.trim();
  const m1 = n.match(/^[Ss](\d{2})$/);
  if (m1) return parseInt(m1[1]);
  const m2 = n.match(/^(第一季|第二季|第三季|第四季|第五季|第六季|第七季|第八季|第九季|第十季|第\s*(\d+)\s*季)$/);
  if (m2) { const cnMap = { '一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10 }; if (cnMap[m2[1][0]]) return cnMap[m2[1][0]]; if (m2[2]) return parseInt(m2[2]); }
  const m3 = n.match(/^(\d{1,2})$/);
  if (m3) return parseInt(m3[1]);
  const m4 = n.match(/[\u4e00-\u9fff\u3400-\u4dbfa-zA-Z]+?\s*(第\s*(\d+)\s*季|第一季|第二季|第三季|第四季|第五季|第六季|第七季|第八季|第九季|第十季)/);
  if (m4) { const cnMap = { '一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10 }; if (m4[2]) return parseInt(m4[2]); const mm = m4[0].match(/\d+/); if (mm) return parseInt(mm[0]); }
  const m5 = n.match(/[\u4e00-\u9fff\u3400-\u4dbfa-zA-Z]+?\s*(\d{1,2})$/);
  if (m5) return parseInt(m5[1]);
  
  const m6 = n.match(/([\u4e00-\u9fff\u3400-\u4dbfa-zA-Z]+)(\d{1,2})$/);
  if (m6 && m6[1] && m6[2]) {
    const seasonNum = parseInt(m6[2]);
    if (seasonNum >= 1 && seasonNum <= 20) {
      return seasonNum;
    }
  }
  
  // 匹配路径中的 Sxx 格式（如 "搏忆 / S01"）
  const m7 = n.match(/[Ss](\d{2})\s*$/);
  if (m7) return parseInt(m7[1]);
  
  return null;
}

async function expandFolders(items) {
  const all = [];
  const folders = [];
  for (const f of items) {
    const hasExt = f.name.match(/\.[a-zA-Z0-9]{2,5}$/);
    const isVideoFile = f.name.match(/\.(mp4|mkv|avi|mov|wmv|flv|f4v|m4v|ts|m2ts|vob|mpg|mpeg|rm|rmvb|3gp|3g2|asf|divx|xvid)$/i);
    const isFolder = f.isFolder || (!hasExt && !isVideoFile);
    if (!isFolder) all.push(f);
    else folders.push(f);
  }
  console.log(`[夸克-CS] expandFolders: ${folders.length} 个文件夹待展开`);
  for (const folder of folders) {
    console.log(`[夸克-CS] 展开文件夹: ${folder.name} (id: ${folder.id})`);
    let sub = await getFilesInFolder(folder.id);
    if (sub.length === 0) { console.log(`[夸克-CS] 第一次展开为空，等待3秒后重试...`); await new Promise(r => setTimeout(r, 3000)); sub = await getFilesInFolder(folder.id); }
    if (sub.length === 0) { console.log(`[夸克-CS] 第二次展开为空，最后尝试...`); await new Promise(r => setTimeout(r, 3000)); sub = await getFilesInFolder(folder.id); }
    console.log(`[夸克-CS] 文件夹 ${folder.name} 最终包含 ${sub.length} 个文件`);
    if (sub.length > 0) {
      const seasonSubFolders = [];
      const nonFolderItems = [];
      for (const f of sub) {
        const hasExt = f.name.match(/\.[a-zA-Z0-9]{2,5}$/);
        const isVideoFile = f.name.match(/\.(mp4|mkv|avi|mov|wmv|flv|f4v|m4v|ts|m2ts|vob|mpg|mpeg|rm|rmvb|3gp|3g2|asf|divx|xvid)$/i);
        const isSubFolder = f.isFolder || (!hasExt && !isVideoFile);
        const sn = getSeasonNumber(f.name);
        if (isSubFolder && sn !== null) {
          seasonSubFolders.push({ ...f, seasonNum: sn, parentFolderName: folder.name });
        } else if (!isSubFolder) {
          f.folderName = folder.name;
          nonFolderItems.push(f);
        } else {
          f.folderName = folder.name;
          nonFolderItems.push(f);
        }
      }
      for (const sf of seasonSubFolders) {
        console.log(`[夸克-CS] 展开季文件夹: ${sf.name} (季号: ${sf.seasonNum})`);
        let seasonSub = await getFilesInFolder(sf.id);
        if (seasonSub.length === 0) { await new Promise(r => setTimeout(r, 3000)); seasonSub = await getFilesInFolder(sf.id); }
        console.log(`[夸克-CS] 季文件夹 ${sf.name} 包含 ${seasonSub.length} 个文件`);
        
        const fullSeasonPath = `${sf.parentFolderName} / ${sf.name}`;
        all.push({ id: sf.id, name: sf.name, isFolder: true, folderName: sf.parentFolderName, fullFolderPath: fullSeasonPath, seasonNum: sf.seasonNum, renameType: 'season' });
        
        for (const vf of seasonSub) {
          const hasExt = vf.name.match(/\.[a-zA-Z0-9]{2,5}$/);
          const isVideoFile = vf.name.match(/\.(mp4|mkv|avi|mov|wmv|flv|f4v|m4v|ts|m2ts|vob|mpg|mpeg|rm|rmvb|3gp|3g2|asf|divx|xvid)$/i);
          const isSubFolder2 = vf.isFolder || (!hasExt && !isVideoFile);
          if (!isSubFolder2) { 
            vf.folderName = fullSeasonPath; 
            vf.seasonNum = sf.seasonNum; 
            all.push(vf); 
          }
        }
      }
      all.push(...nonFolderItems);
    }
  }
  return all;
}

// ==================== 重命名 ====================

async function tryRenameViaIframe(files) {
  return new Promise((resolve) => {
    const iframe = document.querySelector('iframe[src*="b.quark.cn"], iframe');
    if (!iframe || !iframe.contentWindow) {
      resolve({ success: false, reason: 'no-iframe' });
      return;
    }
    const id = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const handler = (event) => {
      if (event.data && event.data.type === 'QUARK_RENAME_RESULT' && event.data.id === id) {
        window.removeEventListener('message', handler);
        console.log(`[夸克-CS] iframe 返回结果: ${event.data.result.successCount} 成功, ${event.data.result.failCount} 失败`);
        resolve({ success: true, ...event.data.result });
      }
    };
    window.addEventListener('message', handler);
    try {
      iframe.contentWindow.postMessage({ type: 'QUARK_RENAME', files, id }, '*');
    } catch (e) {
      window.removeEventListener('message', handler);
      resolve({ success: false, reason: 'postMessage-failed' });
      return;
    }
    const timeout = Math.max(15000, files.length * 1000 + 8000);
    console.log(`[夸克-CS] 设置重命名超时: ${timeout}ms`);
    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve({ success: false, reason: 'timeout' });
    }, timeout);
  });
}

async function batchRename(files) {
  console.log(`[夸克-CS] 尝试通过 iframe 重命名 ${files.length} 个文件`);
  const iframeResult = await tryRenameViaIframe(files);
  if (iframeResult.success) {
    console.log(`[夸克-CS] ✅ iframe 重命名成功: ${iframeResult.successCount}/${files.length}`);
    return { successCount: iframeResult.successCount, failCount: iframeResult.failCount, results: iframeResult.results };
  }
  console.log(`[夸克-CS] iframe 不可用 (${iframeResult.reason}), 回退 background`);
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'executeRename', files }, (response) => {
      if (response && response.results) {
        const successCount = response.results.filter(x => x.success).length;
        const failCount = response.results.filter(x => !x.success).length;
        console.log(`[夸克-CS] 重命名: 成功${successCount} 失败${failCount}`);
        resolve({ successCount, failCount, results: response.results });
      } else {
        console.error('[夸克-CS] 重命名失败:', response?.error);
        resolve({ successCount: 0, failCount: files.length, results: files.map(f => ({ id: f.id, success: false, oldName: f.oldName, newName: f.newName, error: response?.error || '未知错误' })) });
      }
    });
  });
}

function refreshPage() { window.location.reload(); }

// ==================== iframe 消息处理器（在 b.quark.cn 内部运行） ====================

const IS_B_QUARK = window.location.hostname === 'b.quark.cn';
if (IS_B_QUARK) {
  console.log('[夸克-IFRAME] ✅ 已载入 b.quark.cn iframe 上下文');
  window.parent.postMessage({ type: 'QUARK_IFRAME_READY' }, '*');
  window.addEventListener('message', async (event) => {
    if (event.data && event.data.type === 'QUARK_RENAME') {
      // 防止重复重命名
      if (isRenameInProgress) {
        console.log('[夸克-IFRAME] 重命名正在进行中，忽略重复请求');
        return;
      }
      
      const renameId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
      isRenameInProgress = true;
      currentRenameId = renameId;
      
      console.log(`[夸克-IFRAME] 收到重命名请求: ${event.data.files.length} 个文件, ID: ${renameId}`);
      const files = event.data.files;
      const results = [];
      
      for (let i = 0; i < files.length; i++) {
        // 检查操作是否仍然有效
        if (currentRenameId !== renameId) {
          console.log('[夸克-IFRAME] 重命名操作已过时，停止');
          break;
        }
        
        const f = files[i];
        let success = false;
        let error = null;
        const pdirFid = f.parentId || f.id;
        const renameUrl = `https://drive-pc.quark.cn/1/clouddrive/file/rename?pr=ucpro&fr=pc&uc_param_str=&pdir_fid=${pdirFid}`;
        for (let retry = 0; retry < 3 && !success; retry++) {
          try {
            const res = await fetch(renameUrl, {
              method: 'POST', credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ fid: f.id, file_name: f.newName })
            });
            const data = await res.json();
            const ok = data.code === 0 || data.status === 0;
            if (ok) {
              success = true;
              console.log(`[夸克-IFRAME] [${i+1}/${files.length}] ${f.newName} | code=${data.code} ${ok ? '✅' : '❌'}`);
              results.push({ id: f.id, success: true, oldName: f.oldName || f.name, newName: f.newName, error: null });
            } else {
              error = data.message || `code=${data.code}`;
              if (retry < 2) {
                console.log(`[夸克-IFRAME] [${i+1}/${files.length}] 失败，第 ${retry+1} 次重试...`);
                await new Promise(r => setTimeout(r, 300));
              }
            }
          } catch (e) {
            error = e.message;
            if (retry < 2) {
              console.log(`[夸克-IFRAME] [${i+1}/${files.length}] 异常，第 ${retry+1} 次重试...`);
              await new Promise(r => setTimeout(r, 300));
            }
          }
        }
        if (!success) {
          results.push({ id: f.id, success: false, oldName: f.oldName || f.name, newName: f.newName, error: error });
        }
        
        // 动态延迟策略：文件越多，延迟越短
        if (i < files.length - 1) {
          const delay = Math.max(200, 500 - files.length * 2);
          await new Promise(r => setTimeout(r, delay));
        }
      }
      
      // 只有在操作仍然有效时才发送结果
      if (currentRenameId === renameId) {
        const successCount = results.filter(x => x.success).length;
        event.source.postMessage({
          type: 'QUARK_RENAME_RESULT', id: event.data.id,
          result: { successCount, failCount: results.length - successCount, results }
        }, '*');
        console.log(`[夸克-IFRAME] 重命名完成`);
      }
      
      isRenameInProgress = false;
    }

    if (event.data && event.data.type === 'QUARK_LIST_FILES') {
      const { folderId, id } = event.data;
      console.log(`[夸克-IFRAME] 收到列表请求: folderId=${folderId}`);
      try {
        const url = `https://drive-pc.quark.cn/1/clouddrive/file/sort?pr=ucpro&fr=pc&uc_param_str=&pdir_fid=${folderId}&_page=1&_size=500&_fetch_total=1&_fetch_sub_dirs=0&_sort=file_type:asc,updated_at:desc`;
        const res = await fetch(url, { credentials: 'include' });
        const data = await res.json();
        let files = [];
        if (data && data.data && data.data.list) {
          files = data.data.list.map(f => ({
            id: f.fid, name: f.file_name,
            isFolder: !!(f.is_folder === 1 || f.type === 'folder' || f.object_type === 'folder' || f.dir === true),
            parentId: folderId
          }));
        }
        console.log(`[夸克-IFRAME] 列表返回 ${files.length} 个文件`);
        event.source.postMessage({ type: 'QUARK_LIST_RESULT', id, files }, '*');
      } catch (e) {
        console.error(`[夸克-IFRAME] 列表请求异常:`, e.message);
        event.source.postMessage({ type: 'QUARK_LIST_RESULT', id, files: [], error: e.message }, '*');
      }
    }
  });
}

// ==================== Auth 探索 ====================

function discoverAuth() {
  chrome.runtime.sendMessage({ action: 'exploreAuth' }, (resp) => {
    if (resp) {
      console.log('[夸克-CS] 🔑 认证信息探索:', JSON.stringify(resp, null, 2));
      if (resp.globalApiKeys && resp.globalApiKeys.length > 0) {
        console.log('[夸克-CS] 全局API相关变量:', resp.globalApiKeys);
      }
    }
  });
}

// ==================== 消息监听 ====================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (window.self !== window.top) {
    return false;
  }
  console.log('[夸克-CS] 收到消息:', request.action);

  if (request.action === 'getSelectedFiles') {
    discoverAuth();
    (async () => {
      try {
        let domFiles = [];
        for (let attempt = 1; attempt <= 3; attempt++) {
          console.log(`[夸克-CS] DOM 检测尝试 ${attempt}/3`);
          domFiles = getCheckedFilesFromDOM();
          if (domFiles && domFiles.length > 0) {
            console.log(`[夸克-CS] ✅ DOM 检测到 ${domFiles.length} 个勾选文件`);
            break;
          }
          if (attempt < 3) await new Promise(r => setTimeout(r, 500));
        }

        if (domFiles.length > 0) {
          console.log(`[夸克-CS] 返回 ${domFiles.length} 个DOM检测到的文件`);
          sendResponse({ files: domFiles, dirName: getCurrentDirName() });
          return;
        }

        const apiFiles = await getAllFilesInCurrentFolder();
        console.log(`[夸克-CS] API获取到 ${apiFiles.length} 个文件`);

        if (apiFiles.length > 0) {
          console.log(`[夸克-CS] 返回全部 ${apiFiles.length} 个文件（未检测到勾选）`);
          sendResponse({ files: apiFiles, dirName: getCurrentDirName() });
          return;
        }

        console.log('[夸克-CS] ❌ 无法获取文件');
        sendResponse({ files: [], error: '无法获取文件列表' });
      } catch (e) {
        console.error('[夸克-CS] 获取文件出错:', e);
        sendResponse({ files: [], error: e.message });
      }
    })();
    return true;
  }

  if (request.action === 'logFromPopup') {
    console.log(`[popup→page] ${request.message}`);
    sendResponse({});
    return false;
  }

  if (request.action === 'expandFolders') {
    expandFolders(request.items).then(files => {
      try { sendResponse({ files }); } catch(e) { console.warn('[夸克-CS] expandFolders sendResponse失败:', e); }
    }).catch(err => {
      try { sendResponse({ files: [], error: err.message }); } catch(e) { console.warn('[夸克-CS] expandFolders sendResponse err:', e); }
    });
    return true;
  }

  if (request.action === 'batchRename') {
    batchRename(request.files).then(res => {
      sendResponse({ success: true, ...res });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (request.action === 'startCapture') {
    chrome.runtime.sendMessage({ action: 'captureRename' }, (resp) => {
      sendResponse(resp || {});
    });
    return true;
  }

  if (request.action === 'getCaptured') {
    chrome.runtime.sendMessage({ action: 'getCaptured' }, (resp) => {
      sendResponse(resp || { requests: [] });
    });
    return true;
  }

  if (request.action === 'refreshPage') {
    refreshPage();
    sendResponse({ success: true });
  }
});