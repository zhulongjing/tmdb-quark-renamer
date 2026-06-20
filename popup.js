const apiKeyInput = document.getElementById('apiKey');
const saveKeyBtn = document.getElementById('saveKey');
const fileListDiv = document.getElementById('fileList');
const batchRenameBtn = document.getElementById('batchRename');
const statusDiv = document.getElementById('status');
const nameFormatSelect = document.getElementById('nameFormat');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingProgress = document.getElementById('loadingProgress');

// ==================== 日志透传 ====================
function logToPage(...args) {
  console.log(...args);
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (tabs && tabs.length > 0) {
        const msg = args.map(function(a) { return typeof a === 'string' ? a : JSON.stringify(a); }).join(' ');
        chrome.tabs.sendMessage(tabs[0].id, { action: 'logFromPopup', message: '[popup] ' + msg }, function() {});
      }
    });
  } catch(e) {}
}

// 带重试的消息发送
function sendMessageWithRetry(msg, maxRetries, delayMs) {
  return new Promise(function(resolve, reject) {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (!tabs || tabs.length === 0) {
        reject(new Error('找不到页面'));
        return;
      }
      const tabId = tabs[0].id;
      function attempt(n) {
        chrome.tabs.sendMessage(tabId, msg, function(response) {
          if (chrome.runtime.lastError) {
            console.log('[TMDB] sendMessage尝试', n + 1, '失败:', chrome.runtime.lastError.message);
            if (n < maxRetries - 1) {
              setTimeout(function() { attempt(n + 1); }, delayMs);
            } else {
              reject(new Error(chrome.runtime.lastError.message));
            }
            return;
          }
          resolve(response);
        });
      }
      attempt(0);
    });
  });
}

let selectedFiles = [];
let matchedResults = {};
let currentDirName = '';

let isAutoSearching = false;
let isRenaming = false;
let autoSearchTimeout = null;
let currentOperationId = null;

// ==================== 文件名格式判断 ====================

function isAlreadyCorrectFormat(filename, isFolder, folderName = '') {
  if (isFolder) {
    const normalFolderPattern = /^[\u4e00-\u9fff\u3400-\u4dbfa-zA-Z0-9\s]+[（(]\d{4}[）)]$/;
    const seasonFolderPattern = /^[\u4e00-\u9fff\u3400-\u4dbfa-zA-Z0-9\s]*[（(]\d{4}[）)]?\s*Season\s*\d+$/i;
    const simpleSeasonPattern = /^(第\s*\d+\s*季|Season\s*\d+)$/i;
    return normalFolderPattern.test(filename) || seasonFolderPattern.test(filename) || simpleSeasonPattern.test(filename);
  } else {
    const basePart = filename.replace(/\.[^.]+$/, '');
    const hasYearInName = /[（(]\d{4}[）)]/.test(basePart);
    const hasSeasonEpisode = /S\d{2}E\d{2}/.test(basePart);
    return hasYearInName && hasSeasonEpisode;
  }
}

// ==================== 季号提取 ====================

function getSeasonNumber(name) {
  if (!name) return null;
  const m1 = name.match(/[Ss]\s*(\d{1,2})\s*$/);
  if (m1) return parseInt(m1[1]);
  // 中文数字转阿拉伯数字
  const zhMap = {
    '零':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,
    '十一':11,'十二':12,'十三':13,'十四':14,'十五':15,'十六':16,'十七':17,'十八':18,'十九':19,
    '二十':20,'二十一':21,'二十二':22,'二十三':23,'二十四':24,'二十五':25
  };
  const m2 = name.match(/第\s*([一二三四五六七八九十]+)\s*季/);
  if (m2) {
    const n = zhMap[m2[1]];
    if (n !== undefined) return n;
  }
  const m2a = name.match(/第\s*(\d+)\s*季/);
  if (m2a) return parseInt(m2a[1]);
  const m3 = name.match(/[Ss]eason\s*(\d{1,2})/i);
  if (m3) return parseInt(m3[1]);
  const m4 = name.match(/[Ss](\d{1,2})\s*$/);
  if (m4) return parseInt(m4[1]);
  const m5 = name.match(/[Ss](\d{2})/);
  if (m5) return parseInt(m5[1]);
  const m6 = name.match(/[Ss]eason[_\s]*(\d{1,2})/i);
  if (m6) return parseInt(m6[1]);
  const m7 = name.match(/Season\s*(\d{1,2})/i);
  if (m7) return parseInt(m7[1]);
  return null;
}

// ==================== 文件名生成 ====================

function generateFileName({ title, year, type, season, episode, resolution, language, isFolder, folderName, seasonNum, originalName, extraInfo, noYear, seasonName }) {
  // 检测是否是默认/无意义的季名（如 Season 1、第1季、第一季、Specials）
  const isDefaultSeasonName = (name, sn) => {
    if (!name) return true;
    // 去除空格进行比较，TMDB可能返回"第 1 季"而不是"第1季"
    const normalized = name.replace(/\s+/g, '');
    const zhDigits = ['零','一','二','三','四','五','六','七','八','九','十',
      '十一','十二','十三','十四','十五','十六','十七','十八','十九','二十',
      '二十一','二十二','二十三','二十四','二十五'];
    const zhNum = zhDigits[sn] || String(sn);
    const defaults = [
      `Season${sn}`, `Season${String(sn).padStart(2, '0')}`,
      `第${sn}季`, `第${zhNum}季`,
      'Specials', '特别篇'
    ];
    return defaults.some(d => d === normalized);
  };

  if (isFolder) {
    if (type === 'tv' && folderName && (seasonNum || (folderName && getSeasonNumber(folderName) !== null))) {
      const sn = seasonNum || getSeasonNumber(folderName) || 1;
      const seasonYearPart = year && year !== 'N/A' ? `（${year}）` : '';
      const folderTitle = title || extraInfo?.originalTitle;
      // 优先使用TMDB返回的季名（如"觉醒篇"），否则用 Season XX
      if (seasonName && !isDefaultSeasonName(seasonName, sn)) {
        return `${folderTitle}${seasonYearPart} ${seasonName}`;
      }
      return `${folderTitle}${seasonYearPart} Season ${String(sn).padStart(2, '0')}`;
    }
    const nameToUse = title || extraInfo?.originalTitle;
    const yearStr = year && year !== 'N/A' && !noYear ? `（${year}）` : '';
    return nameToUse + yearStr;
  }

  const extMatch = extraInfo?.name ? extraInfo.name.match(/\.([a-zA-Z0-9]{2,5})$/) : null;
  const ext = episode?.originalExt || (extMatch ? extMatch[0] : '');
  const cleanExt = ext ? ext.replace(/^\./, '') : '';
  const yearPart = year && year !== 'N/A' ? ` (${year})` : '';
  const resPart = resolution ? ` ${resolution}` : '';
  const langPart = language ? ` ${language}` : '';

  if (type === 'tv') {
    const s = String(season || 1).padStart(2, '0');
    const e = String(episode !== null ? episode : (extraInfo?.episodeNumber || 1)).padStart(2, '0');
    const sn = season || seasonNum || 1;
    let finalTitle = title || extraInfo?.originalTitle;
    // 如果有季名且不是默认的 Season XX 或 第X季，把季名加入文件标题
    if (seasonName && !isDefaultSeasonName(seasonName, sn)) {
      finalTitle = `${title || extraInfo?.originalTitle} ${seasonName}`;
    }
    return `${finalTitle}${yearPart}${resPart}${langPart} S${s}E${e}${cleanExt ? `.${cleanExt}` : ''}`;
  }

  return `${title}${yearPart}${resPart}${langPart}${cleanExt ? `.${cleanExt}` : ''}`;
}

// ==================== API Key 处理 ====================

chrome.storage.sync.get(['tmdbApiKey'], (result) => {
  if (result.tmdbApiKey) {
    apiKeyInput.value = result.tmdbApiKey;
  }
  setTimeout(() => loadSelectedFiles(), 100);
});

saveKeyBtn.addEventListener('click', () => {
  const apiKey = apiKeyInput.value.trim();
  if (apiKey) {
    chrome.storage.sync.set({ tmdbApiKey: apiKey }, () => {
      showStatus('✅ TMDB API Key 已保存', 'success');
    });
  } else {
    showStatus('❌ 请输入有效的 TMDB API Key', 'error');
  }
});

function levenshteinDistance(a, b) {
  if (!a || !b) return Math.max(a ? a.length : 0, b ? b.length : 0);
  const alen = a.length, blen = b.length;
  const matrix = [];
  for (let i = 0; i <= alen; i++) matrix[i] = [i];
  for (let j = 0; j <= blen; j++) matrix[0][j] = j;
  for (let i = 1; i <= alen; i++) {
    for (let j = 1; j <= blen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[alen][blen];
}

// ==================== 文件名解析 ====================

const MEDIA_EXTS = /\.(mp4|mkv|avi|mov|wmv|flv|f4v|m4v|ts|m2ts|vob|mpg|mpeg|rm|rmvb|3gp|3g2|asf|divx|xvid)$/i;

function parseFilename(filename, isFile = false) {
  logToPage(`[TMDB parse] 开始解析文件名: "${filename}", isFile=${isFile}`);
  let name = filename.trim();
  let folderPart = '';
  const result = { chineseTitle: '', englishTitle: '', year: null, season: null, episode: null, resolution: '', language: '', isTV: false, searchQueries: [] };

  const slashIndex = name.lastIndexOf(' / ');
  if (slashIndex > 0) {
    folderPart = name.substring(0, slashIndex);
    name = name.substring(slashIndex + 3);
    logToPage(`[TMDB parse] 分离文件夹后: folderPart="${folderPart}", name="${name}"`);
  }

  if (isFile) {
    // ========== 文件：提取画质和集数 ==========
    name = name.replace(MEDIA_EXTS, '');
    name = name.replace(/\.(ass|srt|ssa|sup|idx|sub|nfo|txt|jpg|png)$/gi, '');

    // 提取画质/分辨率/来源信息（在extraClean之前，避免被清洗掉）
    const qualityRegex = /(\d{3,4}\s*[xX×]\s*\d{3,4}|[0-9]{3,4}p|4K\s*60FPS|4K60FPS|4K\s*120FPS|4K120FPS|4K\s*HDR|4KHDR|4K\s*UHD|4KUHD|\d+p\s*HD|8K|UHD|4K|2160p|1080p|720p|480p|360p|1440p|4320p|1080i|720i|576p|480i|240p|2K|60FPS|120FPS|50FPS|30FPS|25FPS|48FPS|24FPS|HDR10\+|HDR10Plus|HDR10|HDR|HLG|PQ|SDR|Dolby\s*Vision|DolbyVision|Dolby\s*Atmos|DolbyAtmos|DV|REMUX|PROPER|REPACK|EXTENDED|FINAL|COMPLETE|INTERNAL|LIMITED|RERIP|DC|DIRECTORSCUT|UNCUT|UNRATED|THEATRICAL|CONVERT|SAMPLE|FESTIVAL|READNFO|SUBBED|DUBBED|MULTI|3D|HSBS|HOU|SBS|ANAGLYPH|10BIT|8BIT|12BIT|HI10P|HI444PP|WS|FS|DOCU|DOCUMENTARY|PAL|NTSC|R5|R6|RC|LINE|TELESYNC|TC|CAM|CAMRIP|SCR|SCREENER|DVDSCREENER|DVDSCR|WP|WORKPRINT|PDVD|VCD|SVCD|DUAL|FIX|FIXED|SYNC|SYNCED|OPENING|ENDING|HDTVRip|HDTV|WEB-DL|WEBRip|WEB\s*DL|WEB|BluRay|Blu-ray|Blu\s*Ray|BDRip|HDRip|DVDRip|SATRip|DVBRip|IPTVRip|IPTV|DTV|VODRip|VOD|AMZNWEB|AMZN\s*WEB|AMZN|NF|NETFLIX|HMAXWEB|HMAX|HBOMAX|MAX|HBO|ATVP|APPLE\s*TV|APPLETV|DSNP|DSNY|DISNEYPLUS|HULU|ITUNES|iT|PCOK|PEACOCK|PPLUS|PARAMOUNTPLUS|CRAVE|BBC|iPLAYER|CH4|ITV|STARZ|SHOWTIME|SHO|CRITERION|MGM|LIONSGATE|EPIX|VUDU|AMC|FUNI|x26[45]|h26[45]|HEVC\.\w{2}|HEVC|AVC\.\w{2}|AVC|AV1|VP9|VP8|DIVX|XVID|MPEG2|MPEG4|MVC|PRORES|AAC|AC3|EAC3|DDP5\.1|DDP|DTS-HDMA|DTS-HDHR|DTS-HD|DTSHDMA|DTSHDHR|DTSHD|DTSX|DTS-X|DTS|TrueHD\s*ATMOS|TrueHD|ATMOS|DD5\.1|DD5|DDPLUS|DOLBYATMOS|5\.1\s*CH|7\.1\s*CH|2CH|2\.0CH|6CH|8CH|4CH|FLAC|LPCM|PCM|OPUS|VORBIS|MP3|WMA|APE|高码率|高码|杜比|超清|原盘|蓝光|无损|HQ|HD|SD)/gi;
    const qualityMatch = name.match(qualityRegex);
    
    // 纯数字分辨率（如 1080、720）
    const pureResMatch = name.match(/\b(2160|1440|1080|720|480|360|240)\b/);
    
    const allQualities = [...(qualityMatch || [])];
    if (pureResMatch && !allQualities.some(q => q.toLowerCase() === pureResMatch[1].toLowerCase() + 'p')) {
      allQualities.push(pureResMatch[1] + 'P');
    }
    
    if (allQualities.length > 0) {
      result.resolution = allQualities.map(s => s.trim().toUpperCase()).join(' ');
      for (const q of [...(qualityMatch || []), ...(pureResMatch ? [pureResMatch[1]] : [])]) {
        name = name.replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '').trim();
      }
    }

    // 提取语言
    const langRegex = /国粤双语|中粤双语|中英双语|中日双语|中韩双语|国语|英语中字|英语|粤语中字|粤语|韩语中字|韩语|日语中字|日语/i;
    const langMatch = name.match(langRegex);
    if (langMatch) {
      result.language = langMatch[0];
      name = name.replace(langMatch[0], '').trim();
    }

    // 清洗非画质杂质
    const extraClean = name.replace(/[-–—]\s*(YYeTs|人人影视|SUB|SUBTEAM|CH[PST]|JP\w{2}|ENG|简繁英|双语|字幕组)?\s*/gi, '');
    name = extraClean || name;

    name = name.replace(/[\uFEFF]/g, '').trim();
    name = name.replace(/\s*-\s*$/, '').trim();

    // 先从folderPart提取季信息（用于后续集数识别）
    if (folderPart && result.season === null) {
      const folderSeasonMatch = folderPart.match(/[Ss]eason\s*(\d{1,2})|第\s*(\d+)\s*季/i);
      if (folderSeasonMatch) {
        result.season = parseInt(folderSeasonMatch[1] || folderSeasonMatch[2]);
        result.isTV = true;
      }
    }

    // 提取SxxExx格式（支持2-3位集数）——先匹配，避免被后续规则破坏
    const seMatch = name.match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
    if (seMatch) {
      result.season = parseInt(seMatch[1]);
      result.episode = parseInt(seMatch[2]);
      result.isTV = true;
      name = name.replace(/[Ss]\d{1,2}[Ee]\d{1,3}/, '').trim();
    }

    // 提取集信息（仅匹配独立episode标记，不破坏SxxExx）
    const epMatch = name.match(/[Ee]pisode\s*(\d+)|第\s*(\d+)\s*[集话話]|EP?\s*(\d+)/i);
    if (epMatch) {
      const epNum = epMatch[1] || epMatch[2] || epMatch[3];
      if (epNum && result.episode === null) {
        result.episode = parseInt(epNum);
      }
      name = name.replace(/[Ee]pisode\s*\d+|第\s*\d+\s*[集话話]|EP?\s*\d+/gi, '').trim();
    }

    // 提取末尾数字作为集数
    if (result.episode === null) {
      const endNumMatch = name.match(/\b(\d{1,3})\s*$/);
      if (endNumMatch) {
        const num = parseInt(endNumMatch[1]);
        // 排除4位年份（如2009不会被认为是集数）
        if (num >= 1 && num <= 999 && num < 1900) {
          result.episode = num;
          if (result.season === null) result.season = 1;
          result.isTV = true;
        }
      }
    }

    // 纯数字文件名（如 1.mp4、01.mp4）作为集数
    if (result.episode === null) {
      const pureNumMatch = name.match(/^0*(\d{1,3})$/);
      if (pureNumMatch) {
        const num = parseInt(pureNumMatch[1]);
        if (num >= 1 && num <= 999) {
          result.episode = num;
          if (result.season === null) result.season = 1;
          result.isTV = true;
        }
      }
    }

    // 提取年份
    const yearMatch = name.match(/[（(](\d{4})[）)]/);
    if (yearMatch) {
      result.year = yearMatch[1];
      name = name.replace(/[（(]\d{4}[）)]/, '').trim();
    }

    // 提取中文标题（支持连字符、间隔号、空格等作为标题内分隔符，避免截断如"灵魂摆渡-黄泉"）
    const chineseMatch = name.match(/[\u4e00-\u9fff\u3400-\u4dbf]+(?:[-·・—–_\s]+[\u4e00-\u9fff\u3400-\u4dbf]+)*/);
    if (chineseMatch) {
      result.chineseTitle = chineseMatch[0];
      result.searchQueries.push({ query: result.chineseTitle, weight: 90 });
    }

    // 提取英文标题
    const engName = name.replace(/[\u4e00-\u9fff\u3400-\u4dbf]+(?:[-·・—–_\s]+[\u4e00-\u9fff\u3400-\u4dbf]+)*/g, '').trim();
    if (engName && engName.length > 2 && !/^\d+$/.test(engName)) {
      result.englishTitle = engName;
      result.searchQueries.push({ query: engName, weight: 80 });
    }

    // 从folderPart提取标题（支持连字符、间隔号、空格等作为标题内分隔符）
    if (folderPart) {
      const folderChineseMatch = folderPart.match(/[\u4e00-\u9fff\u3400-\u4dbf]+(?:[-·・—–_\s]+[\u4e00-\u9fff\u3400-\u4dbf]+)*/);
      if (folderChineseMatch && !result.chineseTitle) {
        result.chineseTitle = folderChineseMatch[0];
        result.searchQueries.push({ query: result.chineseTitle, weight: 85 });
      }
      const folderEngMatch = folderPart.replace(/[\u4e00-\u9fff\u3400-\u4dbf]+(?:[-·・—–_\s]+[\u4e00-\u9fff\u3400-\u4dbf]+)*/g, '').replace(/[\/\\]/g, ' ').trim();
      if (folderEngMatch && folderEngMatch.length > 2 && !/^\d+$/.test(folderEngMatch) && !result.englishTitle) {
        result.englishTitle = folderEngMatch;
        result.searchQueries.push({ query: folderEngMatch, weight: 75 });
      }
    }

    if (!result.isTV && result.season !== null) result.isTV = true;
  } else {
    // ========== 文件夹：判断是季文件夹还是剧文件夹 ==========
    // 检查是否是季文件夹（包含 "Season X" 或 "第X季"）
    const isSeasonFolder = /[Ss]eason\s*\d+|第\s*[\d一二三四五六七八九十]+\s*季/i.test(name);

    if (isSeasonFolder) {
      // ========== 季文件夹：提取季数 + 语言 ==========
      // 提取语言（和文件分支保持一致）
      const langRegex = /国粤双语|中粤双语|中英双语|中日双语|中韩双语|国语|英语中字|英语|粤语中字|粤语|韩语中字|韩语|日语中字|日语/i;
      const langMatch = name.match(langRegex);
      if (langMatch) {
        result.language = langMatch[0];
        name = name.replace(langMatch[0], '').trim();
      }
      // 中文数字转阿拉伯数字
      const zhMap = {
        '零':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,
        '十一':11,'十二':12,'十三':13,'十四':14,'十五':15,'十六':16,'十七':17,'十八':18,'十九':19,
        '二十':20,'二十一':21,'二十二':22,'二十三':23,'二十四':24,'二十五':25
      };
      // 先尝试中文数字
      const seasonMatchZh = name.match(/第\s*([一二三四五六七八九十]+)\s*季/);
      if (seasonMatchZh) {
        const n = zhMap[seasonMatchZh[1]];
        if (n !== undefined) {
          result.season = n;
          result.isTV = true;
        }
      } else {
        // 再尝试阿拉伯数字
        const seasonMatch = name.match(/[Ss]eason\s*(\d+)|第\s*(\d+)\s*季/i);
        if (seasonMatch) {
          result.season = parseInt(seasonMatch[1] || seasonMatch[2]);
          result.isTV = true;
        }
      }
    } else {
      // ========== 剧文件夹：只提取剧名 ==========
      name = name.replace(MEDIA_EXTS, '');
      name = name.replace(/\.(ass|srt|ssa|sup|idx|sub|nfo|txt|jpg|png)$/gi, '');

      // 提取年份（但不清洗掉，用于后面的 search）
      const yearMatch = name.match(/[（(](\d{4})[）)]/);
      if (yearMatch) {
        result.year = yearMatch[1];
      }

      // 提取中文标题（支持连字符、间隔号、空格等作为标题内分隔符，避免截断如"灵魂摆渡-黄泉"）
      const chineseMatch = name.match(/[\u4e00-\u9fff\u3400-\u4dbf]+(?:[-·・—–_\s]+[\u4e00-\u9fff\u3400-\u4dbf]+)*/);
      if (chineseMatch) {
        result.chineseTitle = chineseMatch[0];
        result.searchQueries.push({ query: result.chineseTitle, weight: 90 });
      }

      // 提取英文标题
      const engName = name.replace(/[\u4e00-\u9fff\u3400-\u4dbf]+(?:[-·・—–_\s]+[\u4e00-\u9fff\u3400-\u4dbf]+)*/g, '').replace(/[（(]\d{4}[）)]/g, '').trim();
      if (engName && engName.length > 2 && !/^\d+$/.test(engName)) {
        result.englishTitle = engName;
        result.searchQueries.push({ query: engName, weight: 80 });
      }

      // 从folderPart提取标题（支持连字符、间隔号、空格等作为标题内分隔符）
      if (folderPart) {
        const folderChineseMatch = folderPart.match(/[\u4e00-\u9fff\u3400-\u4dbf]+(?:[-·・—–_\s]+[\u4e00-\u9fff\u3400-\u4dbf]+)*/);
        if (folderChineseMatch && !result.chineseTitle) {
          result.chineseTitle = folderChineseMatch[0];
          result.searchQueries.push({ query: result.chineseTitle, weight: 85 });
        }
        const folderEngMatch = folderPart.replace(/[\u4e00-\u9fff\u3400-\u4dbf]+(?:[-·・—–_\s]+[\u4e00-\u9fff\u3400-\u4dbf]+)*/g, '').replace(/[\/\\]/g, ' ').trim();
        if (folderEngMatch && folderEngMatch.length > 2 && !/^\d+$/.test(folderEngMatch) && !result.englishTitle) {
          result.englishTitle = folderEngMatch;
          result.searchQueries.push({ query: folderEngMatch, weight: 75 });
        }
      }
    }
  }

  // 如果从文件名本身提取到了中文或英文标题，优先使用
  if (!result.chineseTitle && !result.englishTitle) {
    logToPage(`[TMDB parse] 文件夹路径解析后: chineseTitle="${result.chineseTitle}", englishTitle="${result.englishTitle}"`);
  }

  if (result.searchQueries.length === 0 && result.chineseTitle) {
    result.searchQueries.push({ query: result.chineseTitle, weight: 90 });
  }

  logToPage(`[TMDB parse] 解析结果: chineseTitle="${result.chineseTitle}", englishTitle="${result.englishTitle}", year=${result.year}, season=${result.season}, episode=${result.episode}`);
  return result;
}

// ==================== 文件夹结构分析 ====================

function analyzeFolderStructure(files) {
  const normalFolders = [];
  const seasonFolders = [];
  const episodeFiles = [];

  for (const f of files) {
    const hasExt = f.name && MEDIA_EXTS.test(f.name);
    const isVideoFile = f.name && MEDIA_EXTS.test(f.name);
    const isFolder = f.isFolder || (f.name && !f.name.match(/\.[a-zA-Z0-9]{2,5}$/) && !isVideoFile);

    if (isVideoFile) {
      episodeFiles.push(f);
    } else if (isFolder) {
      const sn = f.seasonNum || getSeasonNumber(f.name);
      if (sn !== null) {
        seasonFolders.push({ ...f, seasonNum: sn });
      } else {
        normalFolders.push(f);
      }
    }
  }

  // AI推断主标题
  let mainInfo = null;
  if (normalFolders.length > 0) {
    const best = normalFolders.reduce((a, b) => {
      const pa = parseFilename(a.name);
      const pb = parseFilename(b.name);
      const ca = (pa.chineseTitle ? pa.chineseTitle.length : 0) + (pa.searchQueries.length * 10);
      const cb = (pb.chineseTitle ? pb.chineseTitle.length : 0) + (pb.searchQueries.length * 10);
      return ca >= cb ? a : b;
    });
    const parsed = parseFilename(best.name);
    if (parsed.chineseTitle || parsed.englishTitle) {
      mainInfo = {
        title: parsed.chineseTitle || parsed.englishTitle,
        year: parsed.year,
        source: 'folder',
        confidence: Math.min(100, parsed.searchQueries.length * 25)
      };
    }
  }

  // 如果normalFolders为空，从seasonFolders的父文件夹推断
  if (!mainInfo && seasonFolders.length > 0) {
    const seasonParent = seasonFolders[0].folderName;
    if (seasonParent) {
      const parsed = parseFilename(seasonParent);
      if (parsed.chineseTitle || parsed.englishTitle) {
        mainInfo = {
          title: parsed.chineseTitle || parsed.englishTitle,
          year: parsed.year,
          source: 'season_parent',
          confidence: 70
        };
      }
    }
  }

  return { mainInfo, normalFolders, seasonFolders, episodeFiles };
}

// ==================== TMDB API 辅助 ====================

let tmdbCache = {};
let tmdbCacheKeys = [];
const MAX_CACHE = 500;

function getCached(key) {
  const entry = tmdbCache[key];
  if (entry && Date.now() - entry.time < 3600000) return entry.data;
  return null;
}

function setCache(key, data) {
  tmdbCache[key] = { data, time: Date.now() };
  tmdbCacheKeys.push(key);
  if (tmdbCacheKeys.length > MAX_CACHE) {
    const oldKey = tmdbCacheKeys.shift();
    delete tmdbCache[oldKey];
  }
}

async function searchTMDB(apiKey, query, type = 'multi') {
  const cacheKey = `search_${type}_${query}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  const url = `https://api.themoviedb.org/3/search/${type}?api_key=${apiKey}&query=${encodeURIComponent(query)}&language=zh-CN&page=1&include_adult=false`;
  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!resp.ok) throw new Error(`TMDB搜索失败: ${resp.status}`);
    const data = await resp.json();
    setCache(cacheKey, data);
    return data;
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

async function getTMDBSeasonInfo(apiKey, tmdbId, seasonNumber) {
  const cacheKey = `season_${tmdbId}_${seasonNumber}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  const url = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNumber}?api_key=${apiKey}&language=zh-CN`;
  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!resp.ok) throw new Error(`TMDB获取季失败: ${resp.status}`);
    const data = await resp.json();
    setCache(cacheKey, data);
    return data;
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

async function getTMDBMovieInfo(apiKey, tmdbId) {
  const cacheKey = `movie_${tmdbId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const url = `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${apiKey}&language=zh-CN`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`TMDB获取影片失败: ${resp.status}`);
  const data = await resp.json();
  setCache(cacheKey, data);
  return data;
}

// ==================== 匹配评分 ====================

function scoreTMDBResult(tmdbItem, parsed, query) {
  let score = 0;
  const name = (tmdbItem.title || tmdbItem.name || '').toLowerCase();
  const originalName = (tmdbItem.original_title || tmdbItem.original_name || '').toLowerCase();
  // 分隔符标准化：将 - · ・ — – 空格 _ 等分隔符统一，避免 "灵魂摆渡-黄泉" 与 "灵魂摆渡·黄泉" 不匹配
  const normalizeSeparators = (s) => s.replace(/[-·・—–_\s]+/g, '').toLowerCase();

  // 中文标题匹配
  if (parsed.chineseTitle) {
    const ct = parsed.chineseTitle.toLowerCase();
    const ctNorm = normalizeSeparators(ct);
    const ctLen = ct.length;
    const nameLen = name.length;

    // 精确匹配（分隔符标准化后比较）——最高加分
    if (name === ct || normalizeSeparators(name) === ctNorm) score += 70;
    // 部分匹配：标准化后的包含比较
    else if (normalizeSeparators(name).includes(ctNorm) && ctLen >= 2) {
      const matchRatio = ctLen / nameLen;
      if (matchRatio > 0.7) score += 40;
      else if (matchRatio > 0.5) score += 25;
      else if (matchRatio > 0.3) score += 15;
    }
    // 原始分隔符直接包含（TMDB可能用不同分隔符）
    else if (name.includes(ct) && ctLen >= 2) {
      const matchRatio = ctLen / nameLen;
      if (matchRatio > 0.5) score += 30;
      else if (matchRatio > 0.3) score += 15;
    }

    if (originalName.includes(ct) || normalizeSeparators(originalName).includes(ctNorm)) score += 20;
    // 拼音检查（只有标题较长时才考虑）
    if (ctLen >= 3) {
      const ctFirstLetters = ct.split('').filter(c => /[\u4e00-\u9fff]/.test(c)).map(c => c.charAt(0)).join('');
      if (name.includes(ctFirstLetters)) score += 5;
    }
  }

  // 英文标题匹配
  if (parsed.englishTitle) {
    const et = parsed.englishTitle.toLowerCase();
    const etWords = et.split(/[\s_-]+/).filter(w => w.length > 1).map(w => w.toLowerCase());
    const nameWords = name.split(/[\s_-]+/).map(w => w.toLowerCase());
    const origWords = originalName.split(/[\s_-]+/).map(w => w.toLowerCase());
    const matchCount = etWords.filter(w => nameWords.includes(w) || origWords.includes(w)).length;
    if (matchCount > 0) score += Math.min(40, matchCount * 15);
  }

  // 查询词匹配
  if (query) {
    const qw = query.toLowerCase();
    if (name.includes(qw)) score += 25;
    if (originalName.includes(qw)) score += 20;
  }

  // 年份匹配
  if (parsed.year) {
    const releaseDate = tmdbItem.release_date || tmdbItem.first_air_date || '';
    const releaseYear = parseInt(releaseDate.substring(0 ,4));
    if (releaseYear === parseInt(parsed.year)) score += 20;
  }

  // 媒体类型加分
  if (parsed.isTV && tmdbItem.media_type === 'tv') score += 10;
  else if (parsed.isTV && tmdbItem.known_for_department === 'Acting') score -= 5;

  // popularity 加权（降低权重，避免新片碾压正确结果）
  if (tmdbItem.popularity) {
    const popBonus = Math.min(5, Math.log10(tmdbItem.popularity + 1) * 2);
    score += popBonus;
  }

  return Math.min(100, score);
}

// ==================== TMDB 智能搜索 ====================

async function smartSearchTMDB(parsed, fileIndex) {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) { showStatus('❌ 请先设置 TMDB API Key', 'error'); return null; }

  const allQueries = [...parsed.searchQueries];
  if (parsed.season) {
    allQueries.push({ query: `S${String(parsed.season).padStart(2, '0')}`, weight: 50 });
  }

  // 排序搜索词
  allQueries.sort((a, b) => b.weight - a.weight);
  const uniqueQueries = [];
  const seen = new Set();
  for (const q of allQueries) {
    const ql = q.query.toLowerCase().trim();
    if (!seen.has(ql) && ql.length > 0) {
      seen.add(ql);
      uniqueQueries.push(q);
    }
  }

  let bestResult = null;
  const candidates = [];

  for (const sq of uniqueQueries) {
    if (bestResult && bestResult.score && bestResult.score >= 80) break;
    try {
      const data = await searchTMDB(apiKey, sq.query, 'multi');
      if (data.results && data.results.length > 0) {
        for (const item of data.results) {
          const score = scoreTMDBResult(item, parsed, sq.query);
          candidates.push({ item, score, searchQuery: sq.query });
          if (score >= 80) {
            bestResult = { item, score, searchQuery: sq.query };
            break;
          }
        }
      }
    } catch (e) {
      logToPage('[TMDB] 搜索失败:', sq.query, e);
    }
    if (bestResult) break;
  }

  if (!bestResult && candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    bestResult = candidates[0];
  }

  if (bestResult && bestResult.score >= 65) {
    // 高分自动匹配
    const item = bestResult.item;
    const title = item.title || item.name || '';
    const originalTitle = item.original_title || item.original_name || '';
    const releaseDate = item.release_date || item.first_air_date || '';
    const year = releaseDate ? parseInt(releaseDate.substring(0, 4)) : null;
    const mediaType = item.media_type || (item.first_air_date ? 'tv' : 'movie');

    let seasonInfo = {};
    let seasonYear = year;
    let seasonName = null;
    if (mediaType === 'tv' && parsed.season) {
      try {
        const seasonData = await getTMDBSeasonInfo(apiKey, item.id, parsed.season);
        if (seasonData && seasonData.episodes) {
          const epInfo = seasonData.episodes.find(e => e.episode_number === parsed.episode);
          seasonInfo = { episodes: seasonData.episodes, seasonName: seasonData.name };
          seasonName = seasonData.name;
          if (seasonData.air_date) {
            seasonYear = parseInt(seasonData.air_date.substring(0, 4));
          }
        }
      } catch (e) {
        logToPage('[TMDB] 获取季信息失败:', e);
      }
    }

    return { mediaType, title, originalTitle, year: seasonYear, genre: 'tv', tmdbId: item.id, bestResult: item, seasonInfo, parsedSeason: parsed.season, parsedEpisode: parsed.episode, seasonName };
  }

  // 低分时返回候选列表供手动选择
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    const topCandidates = candidates.slice(0, 8);
    return { candidates: topCandidates, parsed };
  }

  return null;
}

// ==================== 文件夹同步 ====================

function syncFolderFiles(folderName, title, year, type, seasonNum, force = false, seasonName = null) {
  logToPage('[TMDB popup] syncFolderFiles called with:', { folderName, title, year, type, force });

  if (!folderName) {
    logToPage('[TMDB popup] syncFolderFiles: folderName is undefined, returning');
    return;
  }

  const parsedSeason = seasonNum || getSeasonNumber(folderName) || null;
  logToPage(`[TMDB popup] 自动同步文件夹 "${folderName}" 内的文件，使用: ${title} (${year})${force ? ' (强制覆盖)' : ''}`);

  for (let i = 0; i < selectedFiles.length; i++) {
    const otherFile = selectedFiles[i];
    const otherFileName = otherFile.folderName || '';
    const isSameFolder = otherFileName === folderName;
    if (isSameFolder && otherFile.id !== undefined) {
      if (!matchedResults[otherFile.id] || force) {
        logToPage(`[TMDB popup] 同步匹配文件: ${otherFile.name}${force ? ' (强制)' : ''}`);
        
        // 判断是否是文件夹
        const hasExt = otherFile.name && otherFile.name.match(/\.[a-zA-Z0-9]{2,5}$/);
        const isVideoFile = otherFile.name && MEDIA_EXTS.test(otherFile.name);
        const isFolder = otherFile.isFolder || (otherFile.name && !hasExt && !isVideoFile);
        
        // 解析文件名提取分辨率等信息（根据类型决定是否解析集数）
        const fullName = otherFile.folderName ? `${otherFile.folderName} / ${otherFile.name}` : otherFile.name;
        const parsed = parseFilename(fullName, !isFolder);
        
        const newName = generateFileName({
          title,
          year,
          type: type || 'tv',
          season: parsedSeason || otherFile.seasonNum || 1,
          episode: otherFile.episodeNum || parsed.episode || null,
          resolution: parsed.resolution || '',
          language: parsed.language,
          isFolder,
          folderName: otherFile.folderName,
          seasonNum: otherFile.seasonNum,
          seasonName: seasonName,
          extraInfo: { name: otherFile.name }
        });
        matchedResults[otherFile.id] = { newName, title, year, mediaType: type || 'tv' };
      }
    }
  }
}

// ==================== 捕获请求 ====================

function startCapture() {
  logToPage('[TMDB] 捕获请求中...');
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0) return;
    chrome.tabs.sendMessage(tabs[0].id, { action: 'startCapture' }, (resp) => {
      showStatus('📡 请求捕获已启动', 'info');
    });
  });
}

function getCaptured() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0) return;
    chrome.tabs.sendMessage(tabs[0].id, { action: 'getCaptured' }, (resp) => {
      logToPage('[TMDB] 捕获状态:', resp);
      if (resp && resp.requests && resp.requests.length > 0) {
        for (let i = 0; i < Math.min(3, resp.requests.length); i++) {
          logToPage(`[${i}] ${resp.requests[i].method} ${resp.requests[i].url}`);
        }
      } else {
        logToPage('[TMDB] 暂无捕获的请求');
      }
    });
  });
}

// ==================== 文件列表加载 ====================

let isLoadingFiles = false;

function loadSelectedFiles() {
  if (isLoadingFiles) {
    logToPage('[TMDB popup] 正在加载中，忽略重复调用');
    return;
  }
  isLoadingFiles = true;
  showStatus('🔍 正在获取文件列表...', 'info');
  logToPage('[TMDB popup] 开始获取文件列表...');

  sendMessageWithRetry({ action: 'getSelectedFiles' }, 2, 500)
    .then(response => {
      logToPage('[TMDB popup] 收到响应:', response);

      if (response && response.files && response.files.length > 0) {
        selectedFiles = response.files;
        currentDirName = response.dirName || '';
        logToPage(`[TMDB popup] 当前目录: ${currentDirName}, 文件数: ${selectedFiles.length}`);
        const apiKey = apiKeyInput.value.trim();

        const folderItems = selectedFiles.filter(f => {
          const hasExt = f.name && f.name.match(/\.[a-zA-Z0-9]{2,5}$/);
          const isVideoFile = f.name && f.name.match(MEDIA_EXTS);
          return f.isFolder || (!hasExt && !isVideoFile);
        });
        const hasFolders = folderItems.length > 0;

        if (hasFolders) {
          const folderCount = folderItems.length;
          const fileCount = selectedFiles.length - folderCount;
          logToPage(`[TMDB popup] 目录包含 ${folderCount} 个文件夹和 ${fileCount} 个文件`);
          showStatus(`📂 展开 ${folderCount} 个文件夹...`, 'info');

          sendMessageWithRetry({ action: 'expandFolders', items: folderItems }, 3, 800)
            .then(expResponse => {
              logToPage(`[TMDB popup] expandFolders 返回 ${expResponse.files.length} 个文件`);
              const nonFolders = selectedFiles.filter(f => {
                const hasExt = f.name && f.name.match(/\.[a-zA-Z0-9]{2,5}$/);
                const isVideoFile = f.name && f.name.match(MEDIA_EXTS);
                const isFolder = f.isFolder || (!hasExt && !isVideoFile);
                return !isFolder;
              });
              selectedFiles = nonFolders.concat(expResponse.files).concat(folderItems);
              logToPage(`[TMDB popup] 最终 ${selectedFiles.length} 项`);
              finishLoad(apiKey);
              isLoadingFiles = false;
            })
            .catch(err => {
              logToPage('[TMDB popup] expandFolders 失败:', err.message);
              showStatus(`⚠️ 无法展开文件夹，使用当前文件列表`, 'error');
              finishLoad(apiKey);
              isLoadingFiles = false;
            });
        } else {
          finishLoad(apiKey);
          isLoadingFiles = false;
        }
      } else if (response && response.error) {
        showStatus(`❌ 获取文件失败: ${response.error}`, 'error');
        fileListDiv.innerHTML = `<p class="placeholder">❌ API错误: ${escapeHtml(response.error)}</p>`;
        batchRenameBtn.disabled = true;
        isLoadingFiles = false;
      } else {
        showStatus(`⚠️ 当前目录没有文件`, 'info');
        fileListDiv.innerHTML = '<p class="placeholder">⚠️ 当前夸克目录中没有文件</p>';
        batchRenameBtn.disabled = true;
        isLoadingFiles = false;
      }
    })
    .catch(err => {
      logToPage('[TMDB popup] 获取文件列表失败:', err.message);
      showStatus(`❌ 无法连接夸克页面: ${err.message}`, 'error');
      fileListDiv.innerHTML = '<p class="placeholder">❌ 连接失败，请在夸克网盘页面刷新后重试</p>';
      batchRenameBtn.disabled = true;
      isLoadingFiles = false;
    });
}

// ==================== 重置状态 ====================

function resetState() {
  if (autoSearchTimeout) {
    clearTimeout(autoSearchTimeout);
    autoSearchTimeout = null;
  }
  isAutoSearching = false;
  isRenaming = false;
  currentOperationId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  logToPage(`[TMDB popup] 状态重置，新操作ID: ${currentOperationId}`);
}

// ==================== 加载完成 ====================

function finishLoad(apiKey) {
  logToPage(`[TMDB popup] 最终 ${selectedFiles.length} 个文件`);
  resetState();
  if (apiKey) {
    logToPage('[TMDB popup] 检测到API Key，开始自动搜索...');
    showLoading(true, 0, selectedFiles.length);
    autoSearchTimeout = setTimeout(() => autoSearchAllFiles(), 300);
  } else {
    renderFileList();
    showStatus('⚠️ 请先设置 TMDB API Key', 'info');
  }
}

// ==================== 自动搜索 ====================

async function autoSearchAllFiles() {
  if (isAutoSearching) {
    logToPage('[TMDB popup] 自动搜索正在进行中，忽略重复调用');
    return;
  }
  const operationId = currentOperationId;
  isAutoSearching = true;
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) { showStatus('❌ 请先设置 TMDB API Key', 'error'); return; }

  logToPage(`[TMDB popup] ===== 开始自动搜索 =====`);
  logToPage(`[TMDB popup] 文件数: ${selectedFiles.length}`);
  logToPage(`[TMDB popup] 当前操作ID: ${operationId}`);

  let autoMatched = 0, needManual = 0, folderMatched = 0;

  const { mainInfo, normalFolders, seasonFolders, episodeFiles } = analyzeFolderStructure(selectedFiles);

  logToPage(`[TMDB popup] 分析结果: 主标题=${mainInfo?.title}, 普通文件夹=${normalFolders.length}, 季文件夹=${seasonFolders.length}, 视频文件=${episodeFiles.length}`);

  const folderInfoMap = new Map();
  for (const folder of normalFolders) {
    const parsed = parseFilename(folder.name);
    if (parsed.searchQueries.length > 0 || parsed.chineseTitle) {
      folderInfoMap.set(folder.name, parsed);
    }
  }

  for (let i = 0; i < selectedFiles.length; i++) {
    if (currentOperationId !== operationId) {
      logToPage('[TMDB popup] 操作已过时，停止执行');
      isAutoSearching = false;
      return;
    }

    const file = selectedFiles[i];
    const hasExt = file.name && file.name.match(/\.[a-zA-Z0-9]{2,5}$/);
    const isVideoFile = file.name && file.name.match(MEDIA_EXTS);
    const isFolder = file.isFolder || (!hasExt && !isVideoFile);

    const isCorrect = isAlreadyCorrectFormat(file.name, isFolder);
    logToPage(`[TMDB auto] ${file.name}: isFolder=${isFolder}, isCorrect=${isCorrect}`);

    if (isCorrect) {
      logToPage(`[TMDB popup] 跳过已正确格式文件: ${file.name}`);
      continue;
    }
    if (matchedResults[file.id]) {
      logToPage(`[TMDB popup] 跳过已有匹配结果的文件: ${file.name}`);
      continue;
    }

    // 跳过季文件夹（在第二个循环处理）
    if (isFolder && !hasExt && file.renameType === 'season') {
      folderMatched++;
      continue;
    }

    const fullName = file.folderName ? `${file.folderName} / ${file.name}` : file.name;
    const parsed = parseFilename(fullName, !isFolder);

    // 尝试从父文件夹信息构建搜索查询
    if (!parsed.chineseTitle && !parsed.englishTitle) {
      let folderName = null;

      // 尝试从 folderName 匹配 normalFolders
      if (file.folderName) {
        const parentFolder = normalFolders.find(f => file.folderName.includes(f.name));
        if (parentFolder && folderInfoMap.has(parentFolder.name)) {
          folderName = parentFolder.name;
          logToPage(`[TMDB popup] 通过 folderName 找到: ${file.folderName}`);
        }
      }

      if (folderName && folderInfoMap.has(folderName)) {
        const folderInfo = folderInfoMap.get(folderName);
        parsed.chineseTitle = folderInfo.chineseTitle;
        parsed.englishTitle = folderInfo.englishTitle;
        parsed.searchQueries = [...folderInfo.searchQueries];
        parsed.year = folderInfo.year;
        logToPage(`[TMDB popup] 使用父文件夹标题进行搜索: ${folderInfo.searchQueries.map(q => q.query).join(', ')}`);
      } else if (mainInfo && mainInfo.title) {
        parsed.chineseTitle = mainInfo.title;
        parsed.year = mainInfo.year;
        parsed.searchQueries.unshift({ query: mainInfo.title, weight: 90 });
        if (mainInfo.year) parsed.searchQueries.push({ query: `${mainInfo.title} ${mainInfo.year}`, weight: 85 });
        logToPage(`[TMDB popup] 使用主标题 "${mainInfo.title}" 进行搜索`);
      }
    }

    // 设置季号
    if (file.seasonNum && !parsed.season) {
      parsed.season = file.seasonNum;
    }
    if (file.episodeNum && !parsed.episode) {
      parsed.episode = file.episodeNum;
    }

    if (!parsed.chineseTitle && !parsed.englishTitle) {
      logToPage(`[TMDB popup] 无法解析标题，跳过文件: ${file.name}`);
      needManual++;
      continue;
    }

    logToPage(`[TMDB popup] 调用 smartSearchTMDB, 文件: ${file.name}`);
    const result = await smartSearchTMDB(parsed, i);
    logToPage(`[TMDB popup] smartSearchTMDB 返回:`, result ? '成功' : '失败');

    if (result && result.title) {
      matchedResults[file.id] = {
        newName: generateFileName({
          title: result.title,
          year: result.year,
          type: result.mediaType || 'tv',
          season: result.parsedSeason || parsed.season || 1,
          episode: result.parsedEpisode || parsed.episode || null,
          resolution: parsed.resolution,
          language: parsed.language,
          isFolder,
          noYear: isFolder && seasonFolders.some(sf => sf.folderName === file.name || sf.parentFolderName === file.name),
          folderName: file.folderName,
          seasonNum: file.seasonNum,
          seasonName: result.seasonName,
          extraInfo: { name: file.name, originalTitle: result.originalTitle }
        }),
        title: result.title,
        year: result.year,
        mediaType: result.mediaType || 'tv'
      };
      autoMatched++;

      if (file.folderName && matchedResults[file.id]) {
        syncFolderFiles(file.folderName, result.title, result.year, result.mediaType, file.seasonNum, false, result.seasonName);
      }

      updateLoadingProgress(autoMatched + needManual + folderMatched, selectedFiles.length);
    } else {
      needManual++;
      updateLoadingProgress(autoMatched + needManual + folderMatched, selectedFiles.length);
    }
  }

  // 第二个循环：处理季文件夹
  logToPage(`[TMDB popup] 处理 ${seasonFolders.length} 个季文件夹...`);
  for (const folder of seasonFolders) {
    if (currentOperationId !== operationId) break;
    if (matchedResults[folder.id]) continue;

    const sn = folder.seasonNum || getSeasonNumber(folder.name) || 1;
    const pIdx = selectedFiles.findIndex(f => f.id === folder.id);
    if (pIdx >= 0) {
      const file = selectedFiles[pIdx];
      let folderTitle = '';
      let folderYear = null;
      let folderSeasonName = null;

      if (file.folderName) {
        const folderParsed = parseFilename(file.folderName);
        if (folderParsed.searchQueries.length > 0) {
          for (const sq of folderParsed.searchQueries.slice(0, 2)) {
            try {
              const data = await searchTMDB(apiKey, sq.query, 'multi');
              if (data.results && data.results.length > 0) {
                const bestItem = data.results[0];
                folderTitle = bestItem.title || bestItem.name || '';
                
                // 获取该季的实际播出年份（而不是电视剧的首次播出年份）
                if (bestItem.media_type === 'tv' || bestItem.known_for_department === 'Acting') {
                  const tmdbId = bestItem.id;
                  try {
                    const seasonInfo = await getTMDBSeasonInfo(apiKey, tmdbId, sn);
                    if (seasonInfo) {
                      folderSeasonName = seasonInfo.name;
                      if (seasonInfo.air_date) {
                        folderYear = parseInt(seasonInfo.air_date.substring(0, 4));
                      } else {
                        const rd = bestItem.release_date || bestItem.first_air_date || '';
                        folderYear = rd ? parseInt(rd.substring(0, 4)) : null;
                      }
                    } else {
                      const rd = bestItem.release_date || bestItem.first_air_date || '';
                      folderYear = rd ? parseInt(rd.substring(0, 4)) : null;
                    }
                  } catch (e) {
                    // 如果获取季信息失败，使用电视剧的首次播出年份作为后备
                    const rd = bestItem.release_date || bestItem.first_air_date || '';
                    folderYear = rd ? parseInt(rd.substring(0, 4)) : null;
                  }
                } else {
                  const rd = bestItem.release_date || bestItem.first_air_date || '';
                  folderYear = rd ? parseInt(rd.substring(0, 4)) : null;
                }
                break;
              }
            } catch (e) {
              logToPage('[TMDB popup] 季文件夹搜索失败:', e);
            }
          }
        }
      }

      if (folderTitle) {
        // 优先使用 TMDB 季名（如"觉醒篇"），否则用 Season XX
        const seasonYearPart = folderYear ? `（${folderYear}）` : '';
        let seasonName;
        if (folderSeasonName && folderSeasonName !== `Season ${sn}` && folderSeasonName !== `第${sn}季`) {
          seasonName = `${folderTitle}${seasonYearPart} ${folderSeasonName}`;
        } else {
          seasonName = `${folderTitle}${seasonYearPart} Season ${String(sn).padStart(2, '0')}`;
        }
        matchedResults[folder.id] = {
          newName: seasonName,
          title: folderTitle,
          year: folderYear,
          mediaType: 'tv'
        };
        // 同步该季文件夹内的文件（强制覆盖）
        const seasonFolderPath = folder.folderName ? `${folder.folderName} / ${folder.name}` : folder.name;
        syncFolderFiles(seasonFolderPath, folderTitle, folderYear, 'tv', sn, true, folderSeasonName);
        logToPage(`[TMDB popup] 季文件夹 "${folder.name}" 匹配成功: ${seasonName}`);
        folderMatched++;
        updateLoadingProgress(autoMatched + needManual + folderMatched, selectedFiles.length);
      }
    }
  }

  // 修正剧文件夹的匹配结果（根据下面的季文件夹反推）
  logToPage(`[TMDB popup] 修正剧文件夹匹配...`);
  for (const folder of seasonFolders) {
    if (folder.folderName && matchedResults[folder.id]) {
      // 找到这个季文件夹的父文件夹（剧文件夹）
      const parentFolder = selectedFiles.find(f => f.name === folder.folderName.split(' / ').pop());
      if (parentFolder) {
        const seasonMatch = matchedResults[folder.id];
        // 生成剧文件夹的正确名称（不加年份，因为下面有季文件夹）
        const showFolderName = seasonMatch.title;
        matchedResults[parentFolder.id] = {
          newName: showFolderName,
          title: seasonMatch.title,
          year: seasonMatch.year,
          mediaType: 'tv'
        };
        logToPage(`[TMDB popup] 修正剧文件夹 "${parentFolder.name}" → "${showFolderName}"`);
      }
    }
  }

  isAutoSearching = false;
  showLoading(false);
  renderFileList();
  logToPage(`[TMDB popup] 自动搜索完成: ${autoMatched} 自动匹配, ${needManual} 需要手动, ${folderMatched} 季文件夹`);
}

// ==================== 渲染文件列表 ====================

function renderFileList() {
  logToPage(`[TMDB popup] renderFileList: selectedFiles.length=${selectedFiles.length}`);
  try {
    const itemsToShow = [];
    const itemsToHide = [];

    for (const f of selectedFiles) {
      const hasExt = f.name && f.name.match(/\.[a-zA-Z0-9]{2,5}$/);
      const isVideoFile = f.name && f.name.match(MEDIA_EXTS);
      const isFolder = f.isFolder || (!hasExt && !isVideoFile);
      const isCorrect = isAlreadyCorrectFormat(f.name, isFolder, f.folderName);
      const match = matchedResults[f.id];

      // 如果有匹配结果，比较新旧名称
      const needsRename = match && match.newName !== f.name;

      // 只有格式正确且不需要重命名时才隐藏
      if (isCorrect && !needsRename) {
        // 季文件夹命名正确且不需要重命名则隐藏
        if (isFolder && !hasExt && f.renameType === 'season') {
          itemsToHide.push(f);
          continue;
        }
        // 文件命名正确且不需要重命名则隐藏（但保留季信息不完整的文件）
        if (!isFolder) {
          const basePart = f.name.replace(/\.[^.]+$/, '');
          const hasSeasonEpisode = /S\d{2}E\d{2}/.test(basePart);
          if (hasSeasonEpisode) {
            itemsToHide.push(f);
            continue;
          }
        }
      }

      itemsToShow.push(f);
    }

    logToPage(`[TMDB popup] 显示 ${itemsToShow.length} 个, 隐藏 ${itemsToHide.length} 个`);

    if (itemsToShow.length === 0) {
      fileListDiv.innerHTML = '<p class="placeholder">✅ 全部文件已命名正确！</p>';
      batchRenameBtn.disabled = true;
      return;
    }

    let html = '';
    for (const f of itemsToShow) {
      const match = matchedResults[f.id];
      const hasExt = f.name && f.name.match(/\.[a-zA-Z0-9]{2,5}$/);
      const isVideoFile = f.name && f.name.match(MEDIA_EXTS);
      const isFolder = f.isFolder || (!hasExt && !isVideoFile);
      const displayPath = f.folderName ? `${f.folderName} / ${f.name}` : f.name;

      const matchInfo = match ? `<div class="match-info">✅ ${escapeHtml(match.newName)}</div>` : '';
      const statusClass = match ? 'status-matched' : 'status-pending';
      const extraClass = isFolder ? ' item-folder' : '';

      html += `<div class="item ${statusClass}${extraClass}">
        <label>
          <input type="checkbox" data-id="${f.id}" ${match ? 'checked' : ''}>
          <span class="file-path">${escapeHtml(displayPath)}</span>
        </label>
        ${matchInfo}
        <div class="item-actions">
          <button class="btn-search" data-id="${f.id}" data-name="${escapeHtml(f.name)}" data-folder="${escapeHtml(f.folderName || '')}" ${isFolder ? `data-isfolder="true" data-renametype="${f.renameType || ''}"` : ''}>🔍 搜索</button>
        </div>
      </div>`;
    }

    fileListDiv.innerHTML = html;
    batchRenameBtn.disabled = false;
  } catch (e) {
    logToPage('[TMDB popup] renderFileList 出错:', e);
  }
}

// ==================== 搜索按钮事件 ====================

fileListDiv.addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn-search');
  if (!btn) return;

  const fileId = btn.dataset.id;
  const fileName = btn.dataset.name;
  const fileFolder = btn.dataset.folder;
  const isFolder = btn.dataset.isfolder === 'true';
  const renameType = btn.dataset.renametype || '';

  const file = selectedFiles.find(f => f.id === fileId);
  if (!file) return;

  const fullName = fileFolder ? `${fileFolder} / ${fileName}` : fileName;
  const parsed = parseFilename(fullName, !isFolder);

  if (!parsed.chineseTitle && !parsed.englishTitle) {
    if (fileFolder) {
      const folderParsed = parseFilename(fileFolder);
      parsed.chineseTitle = folderParsed.chineseTitle;
      parsed.englishTitle = folderParsed.englishTitle;
      parsed.searchQueries = [...folderParsed.searchQueries];
      parsed.year = folderParsed.year;
    }
  }

  if (file.seasonNum && !parsed.season) {
    parsed.season = file.seasonNum;
  }

  showStatus('🔍 正在搜索TMDB...', 'info');
  const result = await smartSearchTMDB(parsed, -1);
  const folderHasSeason = selectedFiles.some(f => 
    f.renameType === 'season' && (f.folderName === fileFolder || f.folderName === fileName)
  );

  if (result && result.title) {
    const newName = generateFileName({
      title: result.title,
      year: result.year,
      type: result.mediaType || 'tv',
      season: result.parsedSeason || parsed.season || 1,
      episode: result.parsedEpisode || parsed.episode || null,
      resolution: parsed.resolution,
      language: parsed.language,
      isFolder,
      noYear: isFolder && folderHasSeason,
      folderName: fileFolder,
      seasonNum: file.seasonNum,
      seasonName: result.seasonName,
      extraInfo: { name: fileName, originalTitle: result.originalTitle }
    });

    // 同步同文件夹文件
    if (fileFolder) {
      syncFolderFiles(fileFolder, result.title, result.year, result.mediaType, file.seasonNum, false, result.seasonName);
    }

    matchedResults[fileId] = { newName, title: result.title, year: result.year, mediaType: result.mediaType || 'tv' };

    showStatus(`✅ 已匹配: ${escapeHtml(newName)}`, 'success');
    renderFileList();
  } else if (result && result.candidates) {
    showManualSelect(result.candidates, file, parsed);
  } else {
    showStatus('❌ 未找到匹配结果', 'error');
  }
});

// ==================== 手动选择 ====================

function showManualSelect(candidates, file, parsed) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center;';
  const box = document.createElement('div');
  box.style.cssText = 'background:#1a1a2e;border-radius:12px;padding:20px;max-height:80%;overflow-y:auto;width:90%;max-width:500px;';

  let html = '<h3 style="margin:0 0 12px;">🔍 选择匹配结果</h3>';
  for (const c of candidates) {
    const item = c.item;
    const title = item.title || item.name || '';
    const releaseDate = item.release_date || item.first_air_date || '';
    const rd = releaseDate ? parseInt(releaseDate.substring(0, 4)) : 'N/A';
    const type = item.media_type === 'tv' ? '📺' : '🎬';
    html += `<div class="candidate-item" data-score="${c.score}" style="padding:8px 12px;margin:4px 0;background:#16213e;border-radius:6px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;">
      <span>${type} ${escapeHtml(title)} (${rd})</span>
      <span style="font-size:11px;color:#${c.score >= 60 ? '0f0' : 'fa0'};">${c.score}分</span>
    </div>`;
  }

  html += '<button id="cancelSelect" style="width:100%;margin-top:12px;padding:8px;background:#555;color:white;border:none;border-radius:6px;cursor:pointer;">取消</button>';
  box.innerHTML = html;
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  box.querySelectorAll('.candidate-item').forEach((el, index) => {
    el.addEventListener('click', async () => {
      const score = parseInt(el.dataset.score);
      const item = candidates[index].item;

      const title = item.title || item.name || '';
      const originalTitle = item.original_title || item.original_name || '';
      const releaseDate = item.release_date || item.first_air_date || '';
      const year = releaseDate ? parseInt(releaseDate.substring(0, 4)) : null;
      const mediaType = item.media_type || 'tv';

      let seasonInfo = {};
      let seasonYear = year;
      let seasonName = null;
      if (mediaType === 'tv' && parsed.season) {
        try {
          const seasonData = await getTMDBSeasonInfo(apiKeyInput.value.trim(), item.id, parsed.season);
          if (seasonData) {
            seasonInfo = { episodes: seasonData.episodes };
            seasonName = seasonData.name;
            if (seasonData.air_date) {
              seasonYear = parseInt(seasonData.air_date.substring(0, 4));
            }
          }
        } catch (e) {}
      }

      const newName = generateFileName({
        title,
        year: seasonYear,
        type: mediaType,
        season: parsed.season || 1,
        episode: parsed.episode || null,
        resolution: parsed.resolution,
        language: parsed.language,
        isFolder: false,
        folderName: file?.folderName,
        seasonNum: file?.seasonNum,
        seasonName: seasonName,
        extraInfo: { name: file?.name, originalTitle }
      });

      const fileId = file.id;
      matchedResults[fileId] = { newName, title, year, mediaType };

      if (file?.folderName) {
        syncFolderFiles(file.folderName, title, year, mediaType, file?.seasonNum, false, seasonName);
      }

      document.body.removeChild(overlay);
      showStatus(`✅ 已匹配: ${escapeHtml(newName)}`, 'success');
      renderFileList();
    });
  });

  document.getElementById('cancelSelect').addEventListener('click', () => {
    document.body.removeChild(overlay);
  });
}

// ==================== 批量重命名 ====================

async function doBatchRename() {
  if (isRenaming) {
    logToPage('[TMDB popup] 正在重命名中，忽略重复点击');
    return;
  }
  const operationId = currentOperationId;
  isRenaming = true;

  const checkboxes = fileListDiv.querySelectorAll('input[type="checkbox"]:checked');
  logToPage(`[TMDB popup] 勾选框数量: ${checkboxes.length}`);
  const checked = [];
  checkboxes.forEach(cb => {
    const id = cb.dataset.id;
    if (id && matchedResults[id]) checked.push({ id, ...selectedFiles.find(f => f.id === id) });
  });
  logToPage(`[TMDB popup] 有效勾选文件: ${checked.length}`);

  if (checked.length === 0) {
    showStatus('⚠️ 请先勾选要重命名的文件', 'error');
    isRenaming = false;
    return;
  }

  const renameList = [];
  for (const file of checked) {
    const matched = matchedResults[file.id];
    if (matched && matched.newName) {
      const extMatch = file.name ? file.name.match(/\.([a-zA-Z0-9]{2,5})$/) : null;
      const originalExt = extMatch ? extMatch[0] : '';
      let newName = matched.newName;
      if (originalExt && !newName.endsWith(originalExt)) {
        newName += originalExt;
      }
      renameList.push({ id: file.id, oldName: file.name, newName, parentId: file.parentId || '' });
    }
  }

  if (renameList.length === 0) {
    showStatus('⚠️ 没有可重命名的文件（请先搜索匹配）', 'error');
    isRenaming = false;
    return;
  }

  showStatus(`🚀 正在重命名 ${renameList.length} 个文件...`, 'info');
  batchRenameBtn.disabled = true;
  loadingOverlay.style.display = 'flex';
  loadingProgress.textContent = '修改中...';

  try {
    const response = await sendMessageWithRetry({ action: 'batchRename', files: renameList }, 2, 1000);
    if (currentOperationId !== operationId) {
      logToPage('[TMDB popup] 重命名操作已过时');
      loadingOverlay.style.display = 'none';
      isRenaming = false;
      return;
    }

    if (response && response.success !== false) {
      const successCount = response.successCount || renameList.length;
      const failCount = response.failCount || 0;
      let msg = failCount === 0 ? `🎉 ${successCount} 个文件重命名成功！` : `⚠️ 成功 ${successCount} 个，失败 ${failCount} 个。`;
      showStatus(msg, failCount === 0 ? 'success' : 'info');

      if (successCount > 0) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs && tabs.length > 0) {
            chrome.tabs.sendMessage(tabs[0].id, { action: 'refreshPage' });
          }
        });
        setTimeout(() => {
          if (currentOperationId === operationId) loadSelectedFiles();
        }, 2000);
      }
    } else {
      showStatus(`⛔ 重命名失败: ${response?.error || '未知错误'}`, 'error');
      batchRenameBtn.disabled = false;
    }
  } catch (err) {
    showStatus(`⛔ 重命名失败: ${err.message}`, 'error');
    batchRenameBtn.disabled = false;
  }
  isRenaming = false;
  loadingOverlay.style.display = 'none';
}

batchRenameBtn.addEventListener('click', doBatchRename);

// ==================== 工具函数 ====================

function showStatus(msg, type) {
  statusDiv.textContent = msg;
  statusDiv.className = `status ${type}`;
  setTimeout(() => { statusDiv.textContent = ''; statusDiv.className = 'status'; }, 10000);
}

function showLoading(show, current = 0, total = 0) {
  if (show) {
    loadingOverlay.style.display = 'flex';
    loadingProgress.textContent = `${current} / ${total}`;
  } else {
    loadingOverlay.style.display = 'none';
  }
}

function updateLoadingProgress(current, total) {
  loadingProgress.textContent = `${current} / ${total}`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

document.getElementById('captureBtn').addEventListener('click', startCapture);
document.getElementById('viewCaptureBtn').addEventListener('click', getCaptured);