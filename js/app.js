(function(){
  var DOCS = [];           // 已打开的文档 [{path,name,md,html,headings,dirty}]
  var current = -1;
  var fs = 17;             // 字号基准
  var editing = false;     // 是否处于编辑模式
  var ROOT = '';

  var $ = function(id){ return document.getElementById(id); };
  var filelist = $('filelist'), tocnav = $('tocnav'), articles = $('articles'),
      empty = $('empty');

  /* ============ 主题（默认暗色） ============ */
  var root = document.documentElement;
  // 主题切换回调（mermaid 需按主题重新渲染）。用函数声明提升，
  // 保证下方 setTheme 初始化时就能拿到已定义的回调。
  var themeHooks = [];
  function onThemeChange(fn){ themeHooks.push(fn); }
  function setTheme(t){
    root.dataset.theme = t;
    try{ localStorage.setItem('md-reader-theme', t); }catch(e){}
    themeHooks.forEach(function(fn){ try{ fn(t); }catch(e){} });
  }
  $('theme-btn').onclick = function(){
    setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark');
  };
  // <html data-theme> 由 index.html 静态声明为 dark，这里按上次选择还原。
  // 错峰执行：服务端静态文件开了 no-cache，首屏 css 可能晚于脚本到达
  // （浏览器刷新时若碰上 304 时序，会先按无样式闪一帧白），提前补一次不依赖样式。
  function restoreTheme(){
    try{ setTheme(localStorage.getItem('md-reader-theme') || 'dark'); }  // 默认暗色
    catch(e){ setTheme('dark'); }
  }
  restoreTheme();
  setTimeout(restoreTheme, 0);
  window.addEventListener('load', restoreTheme);

  /* ============ 字号：小 15 / 中 17 / 大 20 ============ */
  var SIZES = [15, 17, 20];
  function applyFS(){ document.body.style.fontSize = fs + 'px'; }
  $('font-btn').onclick = function(){
    var idx = SIZES.indexOf(fs);
    fs = SIZES[(idx < 0 ? 1 : idx + 1) % SIZES.length];
    applyFS();
  };
  applyFS();

  /* ============ API 封装 ============ */
  function apiGet(path){
    return fetch(path).then(function(r){
      if(!r.ok) return r.text().then(function(t){ throw new Error(t); });
      return r.text();
    });
  }
  // PUT 原始文本（保存 md 用，不加 JSON 引号）
  function apiPutText(path, text){
    return fetch(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: text
    }).then(function(r){
      if(!r.ok) return r.text().then(function(t){ throw new Error(t); });
      return r.json();
    });
  }
  function apiJSON(path, method, body){
    var opt = { method: method, headers: {} };
    if(body !== undefined){
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    return fetch(path, opt).then(function(r){
      return r.text().then(function(t){
        var j = null;
        try{ j = JSON.parse(t); }catch(e){}
        if(!r.ok){
          var msg = (j && j.error) || t || ('HTTP ' + r.status);
          throw new Error(msg);
        }
        return j;
      });
    });
  }

  /* ============ 加载根目录配置与文件树 ============ */
  function loadConfig(){
    return apiGet('/api/config').then(function(t){
      var c = {};
      try{ c = JSON.parse(t); }catch(e){}
      ROOT = c.root || '';
      return c;
    });
  }

  function loadTree(){
    return apiGet('/api/tree').then(function(t){
      var d = JSON.parse(t);
      ROOT = d.root || ROOT;
      renderTree(d.nodes || []);
    }).catch(function(err){
      filelist.innerHTML = '<div style="padding:10px;font-size:12.5px;color:var(--ink2)">' +
        '未能加载文件树<br>' + escapeHtml(err.message) +
        '<br><button id="btnSetRoot2" style="margin-top:10px;padding:6px 10px;border:1px solid var(--line);background:var(--bg2);color:var(--ink2);border-radius:6px;cursor:pointer;font-family:inherit">设置根目录</button></div>';
      var b = $('btnSetRoot2');
      if(b) b.onclick = promptRoot;
    });
  }

  function countFiles(nodes){
    var n = 0;
    (nodes||[]).forEach(function(nd){
      if(nd.isDir){ n += countFiles(nd.children); }
      else { n++; }
    });
    return n;
  }

  /* ============ 文件树渲染 ============ */
  var expanded = {};       // 记录展开的文件夹（内部，默认全部收拢）
  var rootCollapsed = false; // doc 根目录是否折叠
  var extNodes = [];       // 外部文档节点（绝对路径）
  var extCollapsed = {};
  var extBoxCollapsed = false;  // 外部文档区默认展开（与内部 doc 根节点一致），其下目录收拢
  var extGroups = [];      // 逻辑目录 [{id,name,parent,members:[absPath]}]（只存在于星级文档）
  var STARRED = [];        // 关注列表（绝对路径，正斜杠）—— 星级文档的唯一来源
  var STAR_EXCLUDE = [];   // 已关注文件夹里被单独取消关注的文件
  var STAR_NAMES = {};     // 逻辑命名 {规范化路径: 名称}
  var starCollapsed = false; // 星级文档区是否折叠
  var filterText = '';     // 侧栏筛选关键词（只匹配文件名 / 路径，不搜内容）

  // 关键词对文件名或路径做不区分大小写的子串匹配
  function hitFilter(name, path){
    if(!filterText) return true;
    return (name || '').toLowerCase().indexOf(filterText) >= 0 ||
           (path || '').toLowerCase().indexOf(filterText) >= 0;
  }

  // 筛选模式：只保留命中的节点及其祖先目录（无命中的目录剪掉）
  function filterNodes(nodes){
    var out = [];
    (nodes || []).forEach(function(nd){
      if(nd.isDir){
        var kids = filterNodes(nd.children);
        if(kids.length) out.push({ isDir:true, name:nd.name, path:nd.path, children:kids });
      } else if(hitFilter(nd.name, nd.path)){
        out.push(nd);
      }
    });
    return out;
  }

  function baseName(p){
    var nm = (p || '').replace(/[\\/]+$/, '');
    var idx = Math.max(nm.lastIndexOf('\\'), nm.lastIndexOf('/'));
    return idx >= 0 ? nm.slice(idx+1) : nm;
  }

  function renderTree(nodes){
    if(filterText) nodes = filterNodes(nodes);
    filelist.innerHTML = '';
    var wrap = document.createElement('div');
    // 顶部根目录节点（展示文件夹名，可折叠、右键可操作）
    var rootName = rootBaseName();
    if(rootName){
      var rn = document.createElement('div');
      rn.className = 'tree-root';
      rn.title = ROOT;
      rn.innerHTML = '<span class="ticon">' + (rootCollapsed ? '📁' : '📂') + '</span>' +
                     '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(rootName) + '</span>' +
                     '<span class="tcaret">' + (rootCollapsed ? '▸' : '▾') + '</span>';
      rn.onclick = function(e){
        // 点击根节点：折叠/展开其下内容（与子目录一致）
        rootCollapsed = !rootCollapsed;
        renderTree(lastNodes);
      };
      rn.oncontextmenu = function(e){ e.preventDefault(); e.stopPropagation(); rootMenu(e); };
      wrap.appendChild(rn);
    }
    // 根目录折叠时不渲染子节点（筛选时强制展开）
    if(!rootCollapsed || filterText){
      if(!nodes.length && filterText){
        wrap.appendChild(Object.assign(document.createElement('div'), {innerHTML:'<div class="filter-empty">未找到匹配的文件</div>'}));
      } else if(!nodes.length){
        wrap.appendChild(Object.assign(document.createElement('div'), {innerHTML:'<div style="padding:4px 10px 4px 26px;font-size:12.5px;color:var(--ink2)">目录为空</div>'}));
      } else {
        wrap.appendChild(buildNodeList(nodes, 1));
      }
    }
    filelist.appendChild(wrap);
    // 固定占位：外部文档在前、星级文档在后，两块只往各自占位里填内容，
    // 不靠 appendChild 顺序，避免刷新 / 折叠时两块互换位置。
    var extSlot = document.createElement('div');
    extSlot.id = 'extSlot';
    filelist.appendChild(extSlot);
    var starSlot = document.createElement('div');
    starSlot.id = 'starSlot';
    filelist.appendChild(starSlot);
    renderExternal();
    renderStar();
  }

  function rootBaseName(){
    if(!ROOT) return '';
    var p = ROOT.replace(/[\\/]+$/, '');
    var idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return idx >= 0 ? p.slice(idx + 1) : p;
  }

  /* ============ 星级文档 ============ */
  // 每级缩进量（外部文档树、星级文档目录共用）
  var EXT_STEP = 8;
  // 路径比较统一口径：正斜杠 + 小写（与后端 normalizeKey 一致）
  function nkey(p){ return (p || '').replace(/\\/g, '/').toLowerCase(); }
  function isStarred(p){ for(var i=0;i<STARRED.length;i++){ if(nkey(STARRED[i]) === nkey(p)) return true; } return false; }
  function starName(p){ return STAR_NAMES[nkey(p)] || ''; }
  // 显示名：有关注时用逻辑命名，否则用磁盘文件名
  function dispName(p){ return starName(p) || baseName(p); }

  // 判断一个绝对路径是不是文件夹（在已加载的外部树里查）
  function isDirPath(p){
    function find(nodes){
      for(var i=0;i<(nodes||[]).length;i++){
        var nd = nodes[i];
        if(nkey(nd.path) === nkey(p)) return nd.isDir;
        if(nd.isDir){ var r = find(nd.children); if(r !== null) return r; }
      }
      return null;
    }
    return find(extNodes) === true;
  }

  // 按路径去重（同一文件可能既被直接关注、又在已关注的文件夹里）
  function dedupeByPath(list){
    var seen = {}, out = [];
    list.forEach(function(it){
      var k = nkey(it.abs);
      if(seen[k]) return;
      seen[k] = 1;
      out.push(it);
    });
    return out;
  }

  // 关注 / 取消关注（关注是星级文档的唯一来源）
  // single = true 时只取消这一篇（文件夹继续关注，仅排除它自己）
  function setStar(p, on, single){
    var url = '/api/star?path=' + encodeURIComponent(p) + (single ? '&single=1' : '');
    apiJSON(url, on ? 'POST' : 'DELETE')
      .then(loadExternal)
      .catch(function(err){ alert((on ? '关注' : '取消关注') + '失败: ' + err.message); });
  }

  // 找出某篇文档「因为谁被关注」（直接关注的它自己，或它所属的已关注文件夹）
  function starOwnerOf(p){
    if(isStarred(p)) return p;
    var k = nkey(p);
    var best = '';
    STARRED.forEach(function(s){
      var sk = nkey(s);
      if(k.indexOf(sk + '/') === 0 && sk.length > nkey(best).length) best = s;
    });
    return best;
  }

  // 在「星级文档」里给文档起逻辑名称（只改显示，不改磁盘文件名）
  function renameStar(p){
    var v = prompt('逻辑名称（清空则恢复原文件名）:\n' + dispName(p), starName(p));
    if(v === null) return;
    v = v.trim();
    if(v && v === starName(p)) return;
    var req = v ? apiJSON('/api/star/name?path=' + encodeURIComponent(p), 'POST', { name: v })
                : apiJSON('/api/star/name?path=' + encodeURIComponent(p), 'DELETE');
    req.then(function(){ return loadExternal(); })
      .catch(function(err){ alert('重命名失败: ' + err.message); });
  }

  // 逻辑目录里所有成员（子目录递归）
  function groupFiles(gid, out){
    out = out || [];
    extGroups.forEach(function(g){
      if(g.id !== gid) return;
      (g.members||[]).forEach(function(m){ out.push(m); });
    });
    extGroups.forEach(function(g){
      if(g.parent === gid) groupFiles(g.id, out);
    });
    return out;
  }

  // 某路径在星级文档里的落点：先看是否在某个逻辑目录内，再看是否已关注
  function locOf(p){
    var k = nkey(p);
    for(var i=0;i<extGroups.length;i++){
      var ms = extGroups[i].members || [];
      for(var j=0;j<ms.length;j++){ if(nkey(ms[j]) === k) return { group: extGroups[i] }; }
    }
    if(isStarred(p)) return { group: null };
    // 关注了一个文件夹：其中的文件也跟着出现（记在所属的顶层关注项下）
    for(var i2=0;i2<STARRED.length;i2++){
      var s = nkey(STARRED[i2]);
      if(k.indexOf(s + '/') === 0) return { parent: STARRED[i2] };
    }
    return null;
  }

  function starNodeVisible(p){
    var loc = locOf(p);
    if(!loc) return false;
    if(!filterText) return true;
    return hitFilter(starName(p), p) || hitFilter(baseName(p), p);
  }

  function renderStar(){
    var old = document.getElementById('starBox');
    if(old) old.remove();
    var host = slot('starSlot');
    var box = document.createElement('div');
    box.id = 'starBox';

    // 顶层（不属于任何逻辑目录）的星标项：关注的文件 + 已关注文件夹里出现的文件
    // 关注的文件夹本身不占一行，只展示它内部的文档
    var topFiles = [];
    STARRED.forEach(function(p){
      if(!locOf(p) || locOf(p).group) return;
      if(isDirPath(p)) return;
      topFiles.push({ path: p, abs: p });
    });
    (extNodes || []).forEach(function(nd){
      if(nd.isDir) collectStarFiles(nd, topFiles);
    });
    topFiles = dedupeByPath(topFiles.filter(function(it){ var l = locOf(it.abs); return !(l && l.group); }));

    var dirs = extGroups.slice();
    var hasContent = STARRED.length > 0 || dirs.length > 0;
    var hitTop = topFiles.some(function(it){ return starNodeVisible(it.abs); });
    if(filterText && !hitTop && !dirs.some(function(g){
      return groupFiles(g.id).some(function(m){ return starNodeVisible(m); }) || hitFilter(g.name, '');
    })){
      host.appendChild(box);
      return;
    }
    box.style.cssText = 'margin-top:10px;border-top:1px dashed var(--line);padding-top:8px';

    var head = document.createElement('div');
    head.className = 'sect';
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:4px 0';
    var open = !starCollapsed || !!filterText;
    head.innerHTML = '<span style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink2);cursor:pointer">' +
                       (open ? '▾ ' : '▸ ') + '星级文档</span>' +
                     '<span><button id="btnAddStarGroup" title="在星级文档里新建逻辑目录" style="border:1px solid var(--line);background:var(--bg2);color:var(--ink2);border-radius:5px;cursor:pointer;font-size:11px;padding:1px 7px;font-family:inherit">+ 创建目录</button></span>';
    box.appendChild(head);
    head.firstChild.onclick = function(){ starCollapsed = !starCollapsed; renderStar(); };

    if(!open){
      host.appendChild(box);
      var bg0 = document.getElementById('btnAddStarGroup');
      if(bg0) bg0.onclick = function(){ createGroup(''); };
      return;
    }

    if(!hasContent){
      var tip = document.createElement('div');
      tip.style.cssText = 'padding:2px 10px 6px;font-size:11.5px;color:var(--ink2);opacity:.75';
      tip.textContent = '在内部文档 / 外部文档里右键「关注」，文档就会出现在这里';
      box.appendChild(tip);
    }

    // 顶层星标文件（拖到目录里可归类，拖到空白处可移出目录）
    topFiles.forEach(function(it){
      box.appendChild(buildStarFile(it.abs, '', it.abs));
    });
    // 逻辑目录：只渲染顶层（parent 为空），子目录递归
    dirs.filter(function(g){ return !g.parent; }).forEach(function(g){
      box.appendChild(buildGroup(g));
    });

    if(hasContent){
      var hint = document.createElement('div');
      hint.className = 'star-dropzone';
      hint.textContent = '拖到这里移出目录';
      hint.addEventListener('dragover', function(e){ e.preventDefault(); hint.classList.add('on'); });
      hint.addEventListener('dragleave', function(){ hint.classList.remove('on'); });
      hint.addEventListener('drop', function(e){
        e.preventDefault();
        hint.classList.remove('on');
        e.stopPropagation();
        var gid = e.dataTransfer.getData('text/star-group');
        if(gid) return moveGroupToRoot(gid);
        var p = e.dataTransfer.getData('text/star-path');
        if(p) removeFromGroup('', p);
      });
      box.appendChild(hint);
    }

    host.appendChild(box);
    var bg = document.getElementById('btnAddStarGroup');
    if(bg) bg.onclick = function(){ createGroup(''); };
  }

  // 收集已关注文件夹里的文档（关注一个文件夹 = 关注它下面的所有文档）
  function isExcluded(p){
    for(var i=0;i<STAR_EXCLUDE.length;i++){
      if(nkey(STAR_EXCLUDE[i]) === nkey(p)) return true;
    }
    return false;
  }

  function collectStarFiles(nd, out){
    if(!isStarred(nd.path)) return;   // 只展开顶层已关注的登记项
    (function walk(n){
      if(!n.isDir){
        if(isExcluded(n.path)) return;   // 被单独取消关注的单篇不显示
        out.push({ path: n.path, abs: n.path });
        return;
      }
      (n.children || []).forEach(walk);
    })(nd);
  }

  // 渲染一个星标文件（缩进按所在目录层级）
  function buildStarFile(p, gid, dataPath, depth){
    var a = document.createElement('a');
    a.href = '#';
    a.className = 'tree-file ext-file star-file';
    a.setAttribute('data-path', dataPath || p);
    a.style.cssText = 'padding:6px 10px 6px ' + (8 + (depth||0)*EXT_STEP) + 'px;color:var(--ink2);text-decoration:none;font-size:12.4px;line-height:1.4';
    var nm = dispName(p);
    a.innerHTML = '<span class="ticon">' + fileIcon(baseName(p)) + '</span>' +
                  '<span class="tname">' + escapeHtml(nm) + '</span>';
    a.title = (starName(p) ? p + '\n逻辑名称：' + starName(p) : p);
    a.draggable = true;
    a.addEventListener('dragstart', function(e){
      e.dataTransfer.setData('text/star-path', p);
      e.stopPropagation();   // 不要触发整页的文件导入遮罩
    });
    a.onclick = function(e){ e.preventDefault(); openFile(dataPath || p, baseName(p)); };
    a.oncontextmenu = function(e){
      e.preventDefault(); e.stopPropagation();
      // 取消关注有两种粒度：
      //  - 文档本身被关注：取消它自己
      //  - 文档来自已关注的文件夹：取消该文件夹（或单独取消这一篇）
      var owner = starOwnerOf(p);          // 直接关注的路径，或所属已关注文件夹
      var items = [
        { label:'打开', action: function(){ openFile(dataPath || p, baseName(p)); } },
        { label:'重命名（逻辑名称）', action: function(){ renameStar(p); } },
        { label:'在资源管理器中显示', action: function(){ doReveal(p); } },
        copyNameItem(baseName(p)),
        copyPathItem(p),
        { sep: true }
      ];
      if(gid) items.push({ label:'移出此目录', action: function(){ removeFromGroup(gid, p); } });
      if(owner){
        if(nkey(owner) === nkey(p)){
          // 它自己就是被关注的对象
          items.push({ label:'取消关注', danger: true, action: function(){ setStar(p, false); } });
        } else {
          // 它来自一个被关注的文件夹
          items.push({ label:'取消关注此文档', danger: true, action: function(){ setStar(p, false, true); } });
          items.push({ label:'取消关注所属文件夹', danger: true, action: function(){ setStar(owner, false); } });
        }
      }
      showMenu(e.clientX, e.clientY, items);
    };
    return a;
  }

  /* ============ 外部文档 ============ */
  // 判断一个顶层外部路径归入了哪个逻辑目录（返回 group，未分组返回 null）
  function groupOf(path){
    for(var i=0;i<extGroups.length;i++){
      var ms = extGroups[i].members || [];
      for(var j=0;j<ms.length;j++){
        if(nkey(ms[j]) === nkey(path)) return extGroups[i];
      }
    }
    return null;
  }

  // 区块挂载点：优先填到 renderTree 建好的固定占位里（保证外部文档在星级文档之前）
  function slot(name){
    var el = document.getElementById(name);
    if(!el){
      el = document.createElement('div');
      el.id = name;
      filelist.appendChild(el);
    }
    return el;
  }

  function renderExternal(){
    var old = document.getElementById('extBox');
    if(old) old.remove();
    var host = slot('extSlot');
    var box = document.createElement('div');
    box.id = 'extBox';

    // 筛选模式：外部区只在确有命中项时显示，否则整块隐藏
    var extHit = filterNodes(extNodes).length > 0;
    if(filterText && !extHit){
      host.appendChild(box);
      return;
    }
    box.style.cssText = 'margin-top:10px;border-top:1px dashed var(--line);padding-top:8px';

    var head = document.createElement('div');
    head.className = 'sect';
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:4px 0';
    var extOpen = !extBoxCollapsed || !!filterText;   // 筛选时强制展开
    head.innerHTML = '<span style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink2);cursor:pointer">' +
                       (extOpen ? '▾ ' : '▸ ') + '外部文档</span>' +
                     '<span>' +
                     '<button id="btnAddExt" title="登记外部文件或文件夹" style="border:1px solid var(--line);background:var(--bg2);color:var(--ink2);border-radius:5px;cursor:pointer;font-size:11px;padding:1px 7px;font-family:inherit">+ 添加</button>' +
                     '</span>';
    box.appendChild(head);
    head.firstChild.onclick = function(){
      extBoxCollapsed = !extBoxCollapsed;
      renderExternal();
    };

    if(!extOpen){
      host.appendChild(box);
      var be0 = document.getElementById('btnAddExt');
      if(be0) be0.onclick = addExternal;
      return;
    }

    if(!extNodes.length){
      var tip = document.createElement('div');
      tip.style.cssText = 'padding:2px 10px 6px;font-size:11.5px;color:var(--ink2);opacity:.75';
      tip.textContent = '点「+ 添加」登记外部路径（只记路径，不复制文件）';
      box.appendChild(tip);
    } else {
      // 已归入星级文档目录的不再重复显示（那些目录只在星级文档里）
      var loose = (filterText ? filterNodes(extNodes) : extNodes).filter(function(nd){ return !groupOf(nd.path); });
      if(loose.length){
        box.appendChild(buildExtList(loose, 1));
      }
    }
    host.appendChild(box);
    var be = document.getElementById('btnAddExt');
    if(be) be.onclick = addExternal;
  }

  // 渲染一个星级文档的逻辑目录（含成员与子目录）
  function buildGroup(g){
    var box = document.createElement('div');
    var d = document.createElement('div');
    d.className = 'tree-dir group-dir';
    d.setAttribute('data-group', g.id);
    var open = (extCollapsed['g:' + g.id] === undefined ? false : !extCollapsed['g:' + g.id]) || !!filterText;
    d.innerHTML = '<span class="ticon">' + (open ? '📂' : '📁') + '</span>' +
                  '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(g.name) + '</span>' +
                  '<span style="font-size:10.5px;color:var(--ink2);opacity:.6">' + (g.members ? g.members.length : 0) + '</span>' +
                  '<span class="tcaret">' + (open ? '▾' : '▸') + '</span>';
    d.onclick = function(){
      extCollapsed['g:' + g.id] = !extCollapsed['g:' + g.id];
      renderStar();
    };
    d.oncontextmenu = function(e){ e.preventDefault(); e.stopPropagation(); groupMenu(e, g); };
    // 目录本身也可以拖动，拖到另一个目录里就变成它的子目录
    d.draggable = true;
    d.addEventListener('dragstart', function(e){
      e.dataTransfer.setData('text/star-group', g.id);
      e.stopPropagation();
    });
    // 拖拽目标：星标文档 / 子目录拖到这里（可继续嵌套）
    d.addEventListener('dragover', function(e){ e.preventDefault(); e.stopPropagation(); d.style.background = 'rgba(45,212,191,.24)'; });
    d.addEventListener('dragleave', function(){ d.style.background = ''; });
    d.addEventListener('drop', function(e){
      e.preventDefault(); e.stopPropagation();
      d.style.background = '';
      var gid = e.dataTransfer.getData('text/star-group');
      if(gid) return moveGroupInto(gid, g.id);
      var p = e.dataTransfer.getData('text/star-path');
      if(p) moveToGroup(p, g.id);
    });
    box.appendChild(d);

    if(open){
      var members = (g.members || []).filter(function(mp){
        return !filterText || hitFilter(dispName(mp), mp) || hitFilter(baseName(mp), mp);
      });
      // 子目录（只渲染直接子级）
      var subs = extGroups.filter(function(c){ return c.parent === g.id; });
      subs.forEach(function(c){ box.appendChild(buildGroup(c)); });
      if(!members.length && !subs.length && !filterText){
        var empty = document.createElement('div');
        empty.style.cssText = 'padding:2px 10px 6px 20px;font-size:11.5px;color:var(--ink2);opacity:.7';
        empty.textContent = '把星标文档拖到这里';
        box.appendChild(empty);
      }
      members.forEach(function(mp){
        box.appendChild(buildStarFile(mp, g.id, mp));
      });
    }
    return box;
  }

  // 外部文档树：同样每级轻微缩进，目录与文档同级对齐
  function buildExtList(nodes, depth){
    var box = document.createElement('div');
    if(filterText) nodes = filterNodes(nodes);
    nodes.forEach(function(nd){
      if(nd.isDir){
        var d = document.createElement('div');
        d.className = 'tree-dir ext-dir';
        d.setAttribute('data-path', nd.path);
        d.style.paddingLeft = (8 + depth*EXT_STEP) + 'px';
        var open = (extCollapsed[nd.path] === undefined ? false : !extCollapsed[nd.path]) || !!filterText;
        d.innerHTML = '<span class="ticon">' + (open ? '📂' : '📁') + '</span>' +
                      '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escapeHtml(nd.path) + '">' + escapeHtml(nd.name) + '</span>' +
                      '<span class="tcaret">' + (open ? '▾' : '▸') + '</span>';
        d.onclick = function(){
          var cur = extCollapsed[nd.path] === undefined ? true : extCollapsed[nd.path];
          extCollapsed[nd.path] = !cur;
          renderExternal();
        };
        d.oncontextmenu = function(e){ e.preventDefault(); e.stopPropagation(); extMenu(e, nd); };
        box.appendChild(d);
        if(open && nd.children && nd.children.length){
          box.appendChild(buildExtList(nd.children, depth + 1));
        }
      } else {
        var a = document.createElement('a');
        a.href = '#';
        a.className = 'tree-file ext-file';
        a.setAttribute('data-path', nd.path);
        a.style.cssText = 'padding:6px 10px 6px ' + (8+depth*EXT_STEP) + 'px;color:var(--ink2);text-decoration:none;font-size:12.4px;line-height:1.4';
        a.innerHTML = '<span class="ticon">' + fileIcon(nd.name) + '</span>' +
                      '<span class="tname">' + escapeHtml(nd.name) + '</span>';
        a.title = nd.path;
        a.draggable = true;
        a.addEventListener('dragstart', function(e){ e.dataTransfer.setData('text/ext-path', nd.path); e.dataTransfer.effectAllowed = 'copy'; });
        a.onclick = function(e){ e.preventDefault(); openFile(nd.path, nd.name); };
        a.oncontextmenu = function(e){ e.preventDefault(); e.stopPropagation(); extMenu(e, nd); };
        box.appendChild(a);
      }
    });
    return box;
  }

  // 拉取侧栏的三块数据：外部文档树 + 关注列表（星级文档唯一来源）+ 逻辑目录
  function loadExternal(){
    return apiGet('/api/external').then(function(t){
      var d = {};
      try{ d = JSON.parse(t); }catch(e){}
      extNodes = d.nodes || [];
      return apiGet('/api/star').then(function(t2){
        var s = {};
        try{ s = JSON.parse(t2); }catch(e){}
        STARRED = s.starred || [];
        STAR_NAMES = s.names || {};
        STAR_EXCLUDE = s.excluded || [];
        return apiGet('/api/extgroup').then(function(t3){
          var g = {};
          try{ g = JSON.parse(t3); }catch(e){}
          extGroups = g.groups || [];
          renderExternal();
          renderStar();
        });
      });
    }).catch(function(){ /* 静默：无外部文档时忽略 */ });
  }

  // 添加外部文件或文件夹（只记路径，不复制文件）；输入框 + 浏览按钮
  function addExternal(){
    openBrowseDialog(function(chosen){
      if(!chosen) return;
      registerExternal(chosen);
    });
  }

  // 登记一个路径为外部文档（文件或文件夹），成功后自动打开
  function registerExternal(p){
    apiJSON('/api/external?path=' + encodeURIComponent(p), 'POST')
      .then(function(res){
        return loadExternal().then(function(){ return res; });
      })
      .then(function(res){
        var first = firstMd(res.node);
        if(first) openFile(first.path, first.name);
      })
      .catch(function(err){ alert('添加失败: ' + err.message); });
  }

  /* ============ 路径选择对话框（输入框 + 浏览按钮） ============ */
  function openBrowseDialog(onDone){
    var mask = document.createElement('div');
    mask.className = 'dlg-mask';
    var curPath = '';

    var dlg = document.createElement('div');
    dlg.className = 'dlg';
    dlg.innerHTML =
      '<div class="dlg-title">选择外部文件或文件夹</div>' +
      '<div class="dlg-pick">' +
        '<input class="dlg-input" placeholder="粘贴文件或文件夹的完整路径，如 E:\\docs\\note.md">' +
        '<button class="dlg-browse-btn" title="浏览目录">浏览…</button>' +
      '</div>' +
      '<div class="dlg-browse" style="display:none">' +
        '<div class="dlg-path">当前：<span class="dlg-cur"></span></div>' +
        '<div class="dlg-list"></div>' +
      '</div>' +
      '<div class="dlg-foot">' +
        '<button class="dlg-cancel">取消</button>' +
        '<button class="dlg-ok">添加</button>' +
      '</div>';
    mask.appendChild(dlg);
    document.body.appendChild(mask);

    var listEl = dlg.querySelector('.dlg-list');
    var curEl = dlg.querySelector('.dlg-cur');
    var inputEl = dlg.querySelector('.dlg-input');
    var browseEl = dlg.querySelector('.dlg-browse');
    var browseBtn = dlg.querySelector('.dlg-browse-btn');
    var selectedPath = '';   // 目录浏览选中项（可为空=当前目录）

    function loadDir(path){
      curPath = path || '';
      selectedPath = '';
      curEl.textContent = curPath || '（请选择盘符）';
      var url = '/api/browse' + (curPath ? '?path=' + encodeURIComponent(curPath) : '');
      listEl.innerHTML = '<div class="dlg-loading">加载中…</div>';
      apiGet(url).then(function(t){
        var d = JSON.parse(t);
        renderDirs(d.dirs || []);
      }).catch(function(err){
        listEl.innerHTML = '<div class="dlg-loading">读取失败：' + escapeHtml(err.message) + '</div>';
      });
    }

    function renderDirs(dirs){
      listEl.innerHTML = '';
      if(!dirs.length){
        listEl.innerHTML = '<div class="dlg-loading">空文件夹</div>';
        return;
      }
      dirs.forEach(function(d){
        var row = document.createElement('div');
        row.className = 'dlg-row' + (d.name === '..' ? ' up' : '');
        var icon = d.name === '..' ? '⤴' : '📁';
        row.innerHTML = '<span class="dlg-row-icon">' + icon + '</span><span class="dlg-row-name">' + escapeHtml(d.name) + '</span>' +
                       '<span class="dlg-row-path">' + escapeHtml(d.path) + '</span>';
        row.onclick = function(){
          if(d.name === '..'){
            loadDir(d.path);
          } else {
            selectedPath = d.path;
            inputEl.value = d.path;   // 选中即回填输入框，可直接点「添加」
            // 高亮
            dlg.querySelectorAll('.dlg-row').forEach(function(r){ r.classList.remove('sel'); });
            row.classList.add('sel');
          }
        };
        row.ondblclick = function(){
          if(d.name === '..'){ loadDir(d.path); }
          else { loadDir(d.path); }
        };
        listEl.appendChild(row);
      });
    }

    // 浏览按钮：展开/收起目录树并高亮
    browseBtn.onclick = function(){
      var opening = browseEl.style.display === 'none';
      browseEl.style.display = opening ? '' : 'none';
      browseBtn.classList.toggle('active', opening);
      if(opening && !curPath) loadDir('');
    };

    // 确定
    dlg.querySelector('.dlg-ok').onclick = doOk;
    dlg.querySelector('.dlg-cancel').onclick = close;
    mask.onclick = function(e){ if(e.target === mask) close(); };

    function close(){
      document.body.removeChild(mask);
      document.removeEventListener('keydown', onKey);
    }

    function onKey(e){
      if(e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); close(); }
      if(e.key === 'Enter'){ e.preventDefault(); e.stopPropagation(); doOk(); }
    }
    document.addEventListener('keydown', onKey, true);

    // 确认：以输入框内容为准（浏览选中时已回填）
    function doOk(){
      var v = inputEl.value.trim().replace(/^"|"$/g, '');
      if(!v && selectedPath) v = selectedPath;
      if(!v){ alert('请输入或选择一个路径'); return; }
      close();
      onDone(v);
    }
  }

  function firstMd(node){
    if(!node) return null;
    if(!node.isDir) return node;
    var ch = node.children || [];
    for(var i=0;i<ch.length;i++){
      var f = firstMd(ch[i]);
      if(f) return f;
    }
    return null;
  }

  function extMenu(e, nd){
    // 关注的就是右键点中的那个节点本身：文件就关注文件，文件夹才关注文件夹
    showMenu(e.clientX, e.clientY, [
      { label: nd.isDir ? '打开其中第一个文档' : '打开', action: function(){
          if(nd.isDir){ var f = firstMd(nd); if(f) openFile(f.path, f.name); }
          else openFile(nd.path, nd.name);
        } },
      { label: '在资源管理器中' + (nd.isDir ? '打开' : '显示'), action: function(){ doReveal(nd.path); } },
      copyNameItem(nd.name),
      copyPathItem(nd.path),
      { sep: true },
      { label: '移除此登记', danger: true, action: function(){ removeExternal(nd); } },
      { sep: true },
      starItem(nd.path)
    ]);
  }

  // 移除登记（只取消登记，不删原文件）
  function removeExternal(nd){
    var top = nd.path;   // 这里传入的节点本身就是顶层登记项或其子项
    // 找到覆盖它的顶层登记路径
    for(var i=0;i<extNodes.length;i++){
      var r = extNodes[i];
      if(nd.path === r.path || nd.path.indexOf(r.path + '/') === 0){ top = r.path; break; }
    }
    if(!confirm('移除外部登记？\n' + top + '\n\n只取消登记，不会删除原文件。')) return;
    apiJSON('/api/external?path=' + encodeURIComponent(top), 'DELETE')
      .then(loadExternal)
      .catch(function(err){ alert('移除失败: ' + err.message); });
  }

  // 在星级文档里创建逻辑目录（parent 为空 = 顶层）
  function createGroup(parent){
    var name = prompt('目录名称:', '');
    if(!name || !name.trim()) return;
    apiJSON('/api/extgroup', 'POST', { name: name.trim(), parent: parent || '' })
      .then(loadExternal)
      .catch(function(err){ alert('创建失败: ' + err.message); });
  }

  // 把（已关注的）文档拖进逻辑目录（物理文件不动）；一次只能属于一个目录
  function moveToGroup(path, gid){
    var out = [];
    extGroups.forEach(function(g){
      (g.members || []).forEach(function(m){
        if(nkey(m) === nkey(path) && g.id !== gid){ out.push(g.id); }
      });
    });
    var chain = Promise.resolve();
    out.forEach(function(oldGid){
      chain = chain.then(function(){
        return apiJSON('/api/extgroup/member?group=' + encodeURIComponent(oldGid) + '&path=' + encodeURIComponent(path), 'DELETE');
      });
    });
    chain.then(function(){
      // group= 为空时后端只知道要摘掉；归类必须牲给一个真实目录
      if(!gid) return loadExternal();
      return apiJSON('/api/extgroup/member?group=' + encodeURIComponent(gid) + '&path=' + encodeURIComponent(path), 'POST')
        .then(loadExternal);
    }).catch(function(err){ alert('归类失败: ' + err.message); });
  }

  // 从逻辑目录移出（gid 为空 = 从它所在的任意目录里移出，回到星级文档根下）
  function removeFromGroup(gid, path){
    var ids = gid ? [gid] : extGroups.filter(function(g){
      return (g.members || []).some(function(m){ return nkey(m) === nkey(path); });
    }).map(function(g){ return g.id; });
    var chain = Promise.resolve();
    ids.forEach(function(id){
      chain = chain.then(function(){
        return apiJSON('/api/extgroup/member?group=' + encodeURIComponent(id) + '&path=' + encodeURIComponent(path), 'DELETE');
      });
    });
    chain.then(loadExternal)
      .catch(function(err){ alert('移出失败: ' + err.message); });
  }

  function deleteGroup(gid){
    if(!confirm('删除该目录？\n\n只删除目录本身（含子目录），不会删除真实文件。')) return;
    apiJSON('/api/extgroup?id=' + encodeURIComponent(gid), 'DELETE')
      .then(loadExternal)
      .catch(function(err){ alert('删除失败: ' + err.message); });
  }

  // 逻辑目录右键菜单
  function groupMenu(e, g){
    showMenu(e.clientX, e.clientY, [
      { label:'新建子目录', action: function(){ createGroup(g.id); } },
      { label:'重命名', action: function(){ renameGroup(g); } },
      { sep: true },
      { label:'移出目录（到星级文档根下）', action: function(){ moveGroupToRoot(g.id); } },
      { sep: true },
      { label:'删除目录（不删文件）', danger: true, action: function(){ deleteGroup(g.id); } }
    ]);
  }

  // 把目录整体挪到顶层（拖拽也走同一个接口）
  function moveGroupToRoot(gid){
    apiJSON('/api/extgroup', 'POST', { id: gid, parent: '' })
      .then(loadExternal)
      .catch(function(err){ alert('移动失败: ' + err.message); });
  }

  // 把目录拖进另一个目录（后端会拒绝把目录移进自己的子目录）
  function moveGroupInto(gid, parent){
    if(gid === parent) return;
    apiJSON('/api/extgroup', 'POST', { id: gid, parent: parent })
      .then(loadExternal)
      .catch(function(err){ alert('移动失败: ' + err.message); });
  }

  // 重命名逻辑目录（仅改名，不动文件）
  function renameGroup(g){
    var name = prompt('新目录名:', g.name);
    if(!name || !name.trim() || name.trim() === g.name) return;
    apiJSON('/api/extgroup', 'POST', { id: g.id, name: name.trim() })
      .then(loadExternal)
      .catch(function(err){ alert('重命名失败: ' + err.message); });
  }

  // 每级目录缩进量：只做轻微的层级暗示，把宽度留给文件名
  var STEP = 8;

  function buildNodeList(nodes, depth){
    var box = document.createElement('div');
    nodes.forEach(function(nd){
      if(nd.isDir){
        var d = document.createElement('div');
        d.className = 'tree-dir';
        d.style.paddingLeft = (8 + depth*STEP) + 'px';
        var open = !!expanded[nd.path] || !!filterText;   // 筛选时全部展开
        d.innerHTML = '<span class="ticon">' + (open ? '📂' : '📁') + '</span>' +
                      '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(nd.name) + '</span>' +
                      '<span class="tcaret">' + (open ? '▾' : '▸') + '</span>';
        d.onclick = function(){
          // 选中该目录，标出当前操作目标
          var all = filelist.querySelectorAll('.tree-dir, .tree-root');
          for(var i=0;i<all.length;i++) all[i].classList.remove('sel');
          d.classList.add('sel');
          expanded[nd.path] = !expanded[nd.path];
          renderTree(lastNodes);
        };
        d.oncontextmenu = function(e){ e.preventDefault(); e.stopPropagation();
          var all = filelist.querySelectorAll('.tree-dir, .tree-root');
          for(var i=0;i<all.length;i++) all[i].classList.remove('sel');
          d.classList.add('sel');
          dirMenu(e, nd);
        };
        box.appendChild(d);
        if(open && nd.children && nd.children.length){
          box.appendChild(buildNodeList(nd.children, depth + 1));
        }
      } else {
        var a = document.createElement('a');
        a.href = '#';
        a.className = 'tree-file';
        a.setAttribute('data-path', nd.path);
        a.style.paddingLeft = (8 + depth*STEP) + 'px';
        a.innerHTML = '<span class="ticon">' + fileIcon(nd.name) + '</span>' +
                      '<span class="tname">' + escapeHtml(nd.name) + '</span>';
        a.title = nd.name;
        a.onclick = function(e){ e.preventDefault(); openFile(nd.path, nd.name); };
        a.oncontextmenu = function(e){ e.preventDefault(); e.stopPropagation(); fileMenu(e, nd); };
        box.appendChild(a);
      }
    });
    return box;
  }

  // 按扩展名给文件选图标
  function fileIcon(name){
    var ext = (name.split('.').pop() || '').toLowerCase();
    if(ext === 'md' || ext === 'markdown') return '📝';
    if(ext === 'txt') return '📄';
    if(ext === 'pdf') return '📕';
    if(ext === 'json') return '🧾';
    if(ext === 'js' || ext === 'ts' || ext === 'go' || ext === 'py' || ext === 'css' || ext === 'html') return '📜';
    if(ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'svg') return '🖼️';
    return '📄';
  }

  var lastNodes = [];
  var _renderTree = renderTree;
  renderTree = function(nodes){ lastNodes = nodes; _renderTree(nodes); };

  function markActive(path){
    var links = filelist.querySelectorAll('a.tree-file');
    for(var i=0;i<links.length;i++){
      var on = links[i].getAttribute('data-path') === path;
      links[i].classList.toggle('active', on);
    }
  }

  /* ============ 打开 / 保存 / 新建 / 删除 / 重命名 ============ */
  function openFile(path, name){
    // 已有则直接显示
    for(var i=0;i<DOCS.length;i++){
      if(DOCS[i].path === path){ selectDoc(i); return; }
    }
    // PDF 是二进制，走 pdf.js 渲染分支
    if(isPdfPath(path || name)){ openPdf(path, name); return; }
    apiGet('/api/file?path=' + encodeURIComponent(path)).then(function(md){
      md = md.replace(/^\uFEFF/, '');
      DOCS.push({
        path: path, name: name, md: md,
        html: parseMarkdown(md),
        headings: collectHeadings(md),
        dirty: false
      });
      selectDoc(DOCS.length - 1);
    }).catch(function(err){ alert('打开失败: ' + err.message); });
  }

  function selectDoc(i){
    if(i < 0 || i >= DOCS.length) return;
    current = i;
    if(editing) exitEdit();
    syncDocControls();
    renderDoc(i);
    markActive(DOCS[i].path);
    renderTOC();
    empty.style.display = 'none';
    window.scrollTo(0, 0);
    document.title = DOCS[i].name + ' · MD 阅读器';
    // 记住最后打开的文档路径（localCache）
    try{ localStorage.setItem('md-reader-last', DOCS[i].path); }catch(e){}
  }

  function renderDoc(i){
    var arts = articles.children;
    for(var k=0;k<arts.length;k++) arts[k].classList.remove('show');
    if(arts.length <= i){
      for(var j=arts.length;j<=i;j++){
        var art = document.createElement('article');
        art.id = 'doc-'+j;
        articles.appendChild(art);
      }
    }
    var el = document.getElementById('doc-'+i);
    if(DOCS[i].kind === 'pdf'){
      el.classList.add('show');
      renderPdfDoc(el, DOCS[i]);
      return;
    }
    el.innerHTML = DOCS[i].html;
    el.classList.remove('pdf-doc');   // article 按索引复用，避免残留 PDF 宽度限制
    el.classList.add('show');
    attachAnchors();
    renderMath();
    renderMermaid(el);
  }

  /* ============ 编辑 / 预览（二选一） ============ */
  function enterEdit(){
    if(current < 0) return;
    if(DOCS[current].kind === 'pdf') return;   // PDF 不支持源码编辑
    var doc = DOCS[current];
    var el = document.getElementById('doc-'+current);
    if(!el) return;

    var ta = document.createElement('textarea');
    ta.className = 'edit-src edit-full';
    ta.id = 'editSrc';
    ta.value = doc.md;
    ta.spellcheck = false;

    el.innerHTML = '';
    el.appendChild(ta);
    el.classList.add('show');

    editing = true;
    updateEditBtn();

    // 标记初始未改动
    var _dirty = false;
    var saveBtn = showEditRail();

    // 3 秒自动保存（有改动才触发）
    ta.addEventListener('input', function(){
      _dirty = true;
      doc.md = ta.value;
      doc.dirty = true;
      saveBtn.textContent = '保存';
      clearTimeout(ta._auto);
      ta._auto = setTimeout(doSave, 3000);
    });

    ta.addEventListener('keydown', function(e){
      if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='s'){ e.preventDefault(); doSave(); }
      // Tab 插入两空格
      if(e.key === 'Tab'){ e.preventDefault();
        var s = ta.selectionStart, en = ta.selectionEnd;
        ta.value = ta.value.slice(0,s) + '  ' + ta.value.slice(en);
        ta.selectionStart = ta.selectionEnd = s + 2;
        ta.dispatchEvent(new Event('input'));
      }
    });

    function doSave(){
      clearTimeout(ta._auto);
      if(!_dirty){ return; }         // 页面无改动不触发保存
      apiPutText('/api/file?path=' + encodeURIComponent(doc.path), doc.md)
        .then(function(){
          _dirty = false;
          doc.dirty = false;
          doc.html = parseMarkdown(doc.md);
          doc.headings = collectHeadings(doc.md);
          saveBtn.textContent = '保存';
        })
        .catch(function(err){ alert('保存失败: ' + err.message); });
    }
    doc._saveFn = doSave;

    saveBtn.onclick = doSave;

    // 进入编辑：光标置于开头，并滚回顶部
    ta.setSelectionRange(0, 0);
    ta.scrollTop = 0;
    ta.focus();
  }

  // 正文顶部：编辑模式下显示「保存」按钮 + 自动保存提示（无方框、不改背景）
  function showEditRail(){
    var rail = $('editRail');
    if(rail){ rail.style.display = 'flex'; return rail.querySelector('.edit-save'); }
    rail = document.createElement('div');
    rail.id = 'editRail';
    rail.innerHTML =
      '<span class="edit-tip">3 秒自动保存</span>' +
      '<button class="edit-save" title="保存 (Ctrl+S)">保存</button>';
    var m = document.querySelector('main');
    if(m) m.insertBefore(rail, m.firstChild);
    return rail.querySelector('.edit-save');
  }
  function hideEditRail(){
    var rail = $('editRail');
    if(rail) rail.style.display = 'none';
  }

  function exitEdit(){
    if(!editing || current < 0) return;
    editing = false;
    var doc = DOCS[current];
    // 退出前保存残留改动（若之前没来得及自动保存）
    if(doc._saveFn) doc._saveFn();
    hideEditRail();
    doc.html = parseMarkdown(doc.md);
    doc.headings = collectHeadings(doc.md);
    renderDoc(current);
    renderTOC();
    updateEditBtn();
  }

  // 同步工具条「编辑/预览」按钮的图标/激活态
  function updateEditBtn(){
    var b = $('btnEdit');
    if(!b) return;
    if(editing){ b.textContent = '▶'; b.title = '切换到预览'; b.classList.add('active'); }
    else { b.textContent = '✎'; b.title = '切换到编辑'; b.classList.remove('active'); }
  }

  /* ============ 目录 TOC ============ */
  function renderTOC(){
    if(current < 0){ tocnav.innerHTML = ''; return; }
    if(DOCS[current].kind === 'pdf'){ renderPdfTOC(DOCS[current]); return; }
    var hs = DOCS[current].headings;
    tocnav.innerHTML = hs.map(function(h, i){
      var lv = ' lv' + (h.lv > 4 ? 4 : h.lv);
      return '<a href="#mdh-'+i+'" data-idx="'+i+'" class="'+lv+'">'+escapeHtml(h.text)+'</a>';
    }).join('');
  }
  tocnav.addEventListener('click', function(e){
    var a = e.target.closest ? e.target.closest('a') : null;
    if(!a) return;
    // PDF 目录项：data-page 直接定位到页容器
    if(a.hasAttribute('data-page')){
      e.preventDefault();
      var pg = articles.querySelector('article.show .pdf-page[data-page="' + a.getAttribute('data-page') + '"]');
      if(pg) pg.scrollIntoView({behavior:'smooth', block:'start'});
      return;
    }
    var idx = parseInt(a.getAttribute('data-idx'),10);
    var t = articles.querySelector('#mdh-'+idx);
    if(t){ e.preventDefault(); t.scrollIntoView({behavior:'smooth', block:'start'}); }
  });

  /* ============ PDF 阅读（pdf.js 逐页 canvas） ============ */
  var pdfjsReady = null;   // Promise，首次需要时加载 vendor/pdfjs/pdf.min.js

  function isPdfPath(p){ return /\.pdf$/i.test(p || ''); }

  function loadPdfJs(){
    if(pdfjsReady) return pdfjsReady;
    pdfjsReady = new Promise(function(resolve, reject){
      var s = document.createElement('script');
      s.src = 'vendor/pdfjs/pdf.min.js';
      s.onload = function(){
        try{
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
          resolve(window.pdfjsLib);
        }catch(e){ reject(e); }
      };
      s.onerror = function(){ reject(new Error('pdf.js 加载失败，请检查 vendor/pdfjs 是否完整')); };
      document.head.appendChild(s);
    });
    return pdfjsReady;
  }

  // PDF 文档下：隐藏编辑按钮、显示缩放按钮
  function syncDocControls(){
    var isPdf = current >= 0 && DOCS[current] && DOCS[current].kind === 'pdf';
    var b = $('btnEdit'), zo = $('pdf-zoom-out'), zi = $('pdf-zoom-in');
    if(b) b.style.display = isPdf ? 'none' : '';
    if(zo) zo.style.display = isPdf ? '' : 'none';
    if(zi) zi.style.display = isPdf ? '' : 'none';
  }
  $('pdf-zoom-out').onclick = function(){ setPdfZoom(1 / 1.25); };
  $('pdf-zoom-in').onclick = function(){ setPdfZoom(1.25); };

  function openPdf(path, name){
    loadPdfJs().then(function(pdfjs){
      return pdfjs.getDocument({ url: '/api/file?path=' + encodeURIComponent(path) }).promise;
    }).then(function(pdf){
      var doc = { path: path, name: name, kind: 'pdf', pdf: pdf, pages: pdf.numPages, zoom: 1, headings: null };
      DOCS.push(doc);
      selectDoc(DOCS.length - 1);
      loadPdfToc(doc);
    }).catch(function(err){ alert('打开失败: ' + ((err && err.message) || err)); });
  }

  // 读 PDF 大纲作为左侧目录（复用 headings 字段）；没有大纲时目录里只提示页数
  function loadPdfToc(doc){
    doc.pdf.getOutline().then(function(outline){
      if(!outline || !outline.length) return [];
      var items = [], chain = Promise.resolve();
      (function walk(list, lv){
        list.forEach(function(it){
          chain = chain.then(function(){
            return destToPage(doc.pdf, it.dest).then(function(page){
              if(page) items.push({ lv: lv, text: it.title || ('第 ' + page + ' 页'), page: page });
              if(it.items && it.items.length) walk(it.items, lv + 1);
            });
          });
        });
      })(outline, 1);
      return chain.then(function(){ return items; });
    }).then(function(items){
      doc.headings = items;
      if(current >= 0 && DOCS[current] === doc) renderTOC();
    }).catch(function(){});
  }

  // 把大纲 dest（页引用或命名目标）解析成页码（1 基），失败返回 0
  function destToPage(pdf, dest){
    var p = typeof dest === 'string' ? pdf.getDestination(dest) : Promise.resolve(dest);
    return p.then(function(arr){
      if(!arr || !arr.length) return 0;
      if(typeof arr[0] === 'number') return arr[0] + 1;
      return pdf.getPageIndex(arr[0]).then(function(i){ return i + 1; }).catch(function(){ return 0; });
    }).catch(function(){ return 0; });
  }

  function renderPdfTOC(doc){
    var hs = doc.headings;
    if(hs === null){ tocnav.innerHTML = ''; return; }   // 大纲尚在读取，避免先弹「无书签」
    if(!hs || !hs.length){
      tocnav.innerHTML = '<div class="toc-empty">共 ' + doc.pages + ' 页<br>该 PDF 没有书签目录</div>';
      return;
    }
    tocnav.innerHTML = hs.map(function(h){
      var lv = ' lv' + (h.lv > 4 ? 4 : h.lv);
      return '<a href="#pdfp-' + h.page + '" data-page="' + h.page + '" class="' + lv + '">' + escapeHtml(h.text) + '</a>';
    }).join('');
  }

  // 整篇按页建占位容器；进入视口（含 600px 预取）才真正绘制，几百页的 PDF 也不卡
  function renderPdfDoc(el, doc){
    if(doc.observer){ doc.observer.disconnect(); doc.observer = null; }
    el.innerHTML = '';
    el.classList.add('pdf-doc');
    var avail = Math.max(320, el.clientWidth || 820);
    var est = Math.floor(avail * 1.414);   // 未渲染前按 A4 比例占位，减少滚动条跳动
    for(var p = 1; p <= doc.pages; p++){
      var pg = document.createElement('div');
      pg.className = 'pdf-page';
      pg.id = 'pdfp-' + p;
      pg.setAttribute('data-page', p);
      pg.style.minHeight = est + 'px';
      pg.innerHTML = '<span class="pdf-ph">第 ' + p + ' 页</span>';
      el.appendChild(pg);
    }
    doc.observer = new IntersectionObserver(function(entries){
      for(var k = 0; k < entries.length; k++){
        if(entries[k].isIntersecting) renderPdfPage(doc, entries[k].target);
      }
    }, { rootMargin: '600px 0px' });
    var pages = el.querySelectorAll('.pdf-page');
    for(var i = 0; i < pages.length; i++) doc.observer.observe(pages[i]);
  }

  function renderPdfPage(doc, pg){
    if(pg.getAttribute('data-rendered') === '1') return;
    pg.setAttribute('data-rendered', '1');
    var no = parseInt(pg.getAttribute('data-page'), 10);
    doc.pdf.getPage(no).then(function(page){
      var base = page.getViewport({ scale: 1 });
      var avail = Math.max(320, pg.parentNode ? pg.parentNode.clientWidth : 820);
      var scale = Math.min(4, Math.max(0.2, avail / base.width * doc.zoom));
      var vp = page.getViewport({ scale: scale });
      var dpr = window.devicePixelRatio || 1;
      var cv = document.createElement('canvas');
      cv.width = Math.floor(vp.width * dpr);
      cv.height = Math.floor(vp.height * dpr);
      cv.style.width = Math.floor(vp.width) + 'px';
      cv.style.height = Math.floor(vp.height) + 'px';
      pg.style.minHeight = Math.floor(vp.height) + 'px';
      pg.innerHTML = '';
      pg.appendChild(cv);
      var ctx = cv.getContext('2d');
      ctx.scale(dpr, dpr);
      return page.render({ canvasContext: ctx, viewport: vp }).promise;
    }).catch(function(err){
      pg.innerHTML = '<span class="pdf-ph">第 ' + no + ' 页渲染失败：' + ((err && err.message) || err) + '</span>';
    });
  }

  // 缩放：按新比例重建（懒渲染只会重画视口附近的页）
  function setPdfZoom(delta){
    if(current < 0) return;
    var doc = DOCS[current];
    if(!doc || doc.kind !== 'pdf') return;
    doc.zoom = Math.min(3, Math.max(0.4, doc.zoom * delta));
    var el = document.getElementById('doc-' + current);
    if(el) renderPdfDoc(el, doc);
  }

  /* ============ 公式渲染 ============ */
  function renderMath(){ 
    var el = articles.querySelector('article.show');
    if(el) renderMathIn(el);
  }
  function renderMathIn(el){
    if(!window.renderMathInElement) return;
    window.renderMathInElement(el, {
      delimiters: [
        {left:'$$', right:'$$', display:true},
        {left:'$', right:'$', display:false}
      ],
      throwOnError: false,
      // 图表源码块（div.mermaid）里不做公式渲染，避免 a-->b 之类被误判
      ignoredTags: ['script','noscript','style','textarea','pre','code','div'],
      ignoredClasses: ['mermaid']
    });
  }

  /* ============ Mermaid 图表（流程图 / 时序图 / 思维导图 等） ============ */
  var mermaidReady = null;   // Promise，首次需要时加载 vendor/mermaid/mermaid.min.js
  function mermaidTheme(){ return root.dataset.theme === 'dark' ? 'dark' : 'default'; }
  function loadMermaid(){
    if(mermaidReady) return mermaidReady;
    mermaidReady = new Promise(function(resolve, reject){
      var s = document.createElement('script');
      s.src = 'vendor/mermaid/mermaid.min.js';
      s.onload = function(){
        try{
          window.mermaid.initialize({
            startOnLoad: false,
            theme: mermaidTheme(),
            securityLevel: 'loose',
            fontFamily: 'inherit'
          });
          resolve(window.mermaid);
        }catch(e){ reject(e); }
      };
      s.onerror = function(){ reject(new Error('mermaid 加载失败')); };
      document.head.appendChild(s);
    });
    return mermaidReady;
  }
  // 渲染容器内所有未处理的 div.mermaid（data-src 保存原始源码，重渲染用）
  function renderMermaid(el){
    if(!el) return;
    var nodes = el.querySelectorAll('div.mermaid:not([data-done])');
    if(!nodes.length) return;
    loadMermaid().then(function(mermaid){
      var list = Array.prototype.slice.call(nodes);
      list.forEach(function(nd){
        nd.setAttribute('data-done', '1');
        if(!nd.hasAttribute('data-src')) nd.setAttribute('data-src', nd.textContent);
      });
      runSequential(mermaid, list);
    }).catch(function(err){ failMermaid(nodes, err); });
  }
  // 串行渲染：mermaid 用时间戳生成 svg id，并发时会重名导致图形串位/重叠；
  // 且批量 run 只要有一个图解析失败，整批都会静默失败，所以逐节点 + 单独回落。
  function runSequential(mermaid, list){
    var p = Promise.resolve();
    list.forEach(function(nd){
      p = p.then(function(){
        return mermaid.run({ nodes: [nd], suppressErrors: true }).then(function(){
          // 解析失败时 mermaid 会塞一个 aria-roledescription="error" 的提示 svg，需甄别后回落
          var svg = nd.querySelector('svg');
          if(!svg || svg.getAttribute('aria-roledescription') === 'error') failMermaid([nd]);
          else fitMermaid(nd);
        }, function(err){ failMermaid([nd], err); });
      });
    });
    return p;
  }
  // mermaid 给 svg 写的是 width:100% + max-width，竖长的图会被拉满宽度、撑满整屏。
  // 按 viewBox 还原为原文尺寸（宽度不超过容器，不放大），超高/超宽交给容器滚动。
  function fitMermaid(nd){
    var svg = nd.querySelector('svg');
    if(!svg) return;
    var vb = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
    if(vb.length !== 4 || !vb[2] || !vb[3]) return;
    var avail = nd.parentNode ? nd.parentNode.clientWidth - 26 : 0;   // 减掉 wrap 内边距
    var w = vb[2], h = vb[3];
    if(avail > 0 && w > avail){ h = h * avail / w; w = avail; }
    svg.style.maxWidth = 'none';
    svg.style.width = w + 'px';
    svg.style.height = h + 'px';
  }
  // 加载 / 语法错误时回落为源码块，不影响阅读其余内容
  function failMermaid(nodes, err){
    for(var k=0;k<nodes.length;k++){
      var nd = nodes[k];
      // 节点可能已被 mermaid 移除（错误图），从 data-src 取源码；容器找不到就不处理
      var wrap = nd.parentNode;
      if(!wrap || !wrap.parentNode) continue;
      var box = document.createElement('div');
      box.className = 'code-block';
      box.innerHTML = '<div class="code-head"><span class="dot"></span><span class="dot"></span><span class="dot"></span>' +
        '<span class="lang">mermaid</span></div><pre><code>' +
        escapeHtml(nd.getAttribute('data-src') || '') + '</code></pre></div>';
      wrap.parentNode.replaceChild(box, wrap);
    }
    if(err) console.warn('mermaid 渲染失败:', err.message || err);
  }
  // 主题切换后重新渲染当前文档里的图（mermaid 主题在初始化时固定，需重建）
  onThemeChange(function(){
    if(!window.mermaid) return;
    window.mermaid.initialize({
      startOnLoad: false, theme: mermaidTheme(), securityLevel: 'loose', fontFamily: 'inherit'
    });
    var el = articles.querySelector('article.show');
    if(!el) return;
    // 必须先快照成数组：querySelectorAll 返回的是实时 NodeList，
    // replaceChild 后它的索引会重排，边遍历边替换会错位/漏项。
    var nodes = Array.prototype.slice.call(el.querySelectorAll('div.mermaid[data-src]'));
    if(!nodes.length) return;
    var fresh = [];
    for(var k=0;k<nodes.length;k++){
      var nd = nodes[k];
      var src = nd.getAttribute('data-src');   // 先取源码，replaceChild 后 nd 已脱离文档
      // mermaid 会在节点里塞入 <style>/id/data-processed 等痕迹，整体重建
      var box = document.createElement('div');
      box.className = 'mermaid';
      box.setAttribute('data-src', src);
      box.setAttribute('data-done', '1');
      box.textContent = src;
      nd.parentNode.replaceChild(box, nd);
      fresh.push(box);
    }
    runSequential(window.mermaid, fresh);
  });

  /* ============ 锚点 ============ */
  function attachAnchors(){
    var hs = articles.querySelectorAll('article.show h1, article.show h2, article.show h3, article.show h4');
    var idx = 0;
    hs.forEach(function(h){ h.id = 'mdh-' + idx; idx++; });
  }

  /* ============ 右键菜单 ============ */
  var menuEl = null;
  function closeMenu(){ if(menuEl){ menuEl.remove(); menuEl = null; } }
  function showMenu(x, y, items){
    closeMenu();
    menuEl = document.createElement('div');
    menuEl.className = 'ctx-menu';
    // 先按鼠标位置放，再按实际尺寸修正，避免菜单超出窗口导致底部/右侧项看不见
    menuEl.style.left = x + 'px';
    menuEl.style.top = y + 'px';
    menuEl.style.visibility = 'hidden';
    items.forEach(function(it){
      if(it.sep){ var s=document.createElement('div'); s.className='ctx-sep'; menuEl.appendChild(s); return; }
      var d = document.createElement('div');
      d.className = 'ctx-item' + (it.danger ? ' danger' : '');
      d.textContent = it.label;
      d.onclick = function(){ closeMenu(); it.action(); };
      menuEl.appendChild(d);
    });
    document.body.appendChild(menuEl);
    clampMenu(x, y);
    menuEl.style.visibility = '';
  }

  // 菜单自适应：右侧溢出就往左翻，底部溢出就往上翻；都放不下时限制高度并允许滚动
  function clampMenu(x, y){
    var gap = 8;
    var vw = window.innerWidth, vh = window.innerHeight;
    var r = menuEl.getBoundingClientRect();
    var w = r.width, h = r.height;
    if(x + w + gap > vw) x = Math.max(gap, x - w);
    if(y + h + gap > vh) y = Math.max(gap, y - h);
    // 菜单本身就比窗口高：贴顶部并滚动
    if(h + gap * 2 > vh){
      menuEl.style.maxHeight = (vh - gap * 2) + 'px';
      menuEl.style.overflowY = 'auto';
      y = gap;
    }
    menuEl.style.left = x + 'px';
    menuEl.style.top = y + 'px';
  }
  document.addEventListener('click', closeMenu);
  window.addEventListener('resize', closeMenu);

  // 侧边栏空白处右键（条目自身已 stopPropagation）
  document.getElementById('sidebar').addEventListener('contextmenu', function(e){
    e.preventDefault();
    blankMenu(e);
  });

  // 右键菜单项：复制该文件/文件夹的绝对路径
  function copyPathItem(path){
    return { label:'复制绝对路径', action: function(){
      var p = path;
      if(!p){ alert('尚未设置根目录'); return; }
      copyPath(p);
    } };
  }

  // 右键菜单项：复制该文件/文件夹的文件名（含扩展名，不含路径）
  function copyNameItem(name){
    return { label:'复制文件名', action: function(){
      var n = baseName(name);
      if(!n){ alert('没有可复制的文件名'); return; }
      copyName(n);
    } };
  }

  function copyName(n){
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(n).catch(function(){ legacyCopy(n); });
    } else { legacyCopy(n); }
  }

  function copyPath(p){
    var winPath = p.replace(/\//g, '\\');
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(winPath).catch(function(){ legacyCopy(winPath); });
    } else { legacyCopy(winPath); }
  }

  // 非安全上下文（如 http://局域网IP）没有 clipboard API 时的兜底
  function legacyCopy(text){
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try{ document.execCommand('copy'); }
    catch(e){ alert('复制失败，请手动复制：\n' + text); }
    document.body.removeChild(ta);
  }

  // 右键菜单项：关注 / 取消关注（内部、外部文档通用）。
  // abs 为绝对路径（内部文档用 ROOT 拼接）。
  function starItem(abs){
    if(isStarred(abs)) return { label:'取消关注', action: function(){ setStar(abs, false); } };
    return { label:'关注', action: function(){ setStar(abs, true); } };
  }

  function fileMenu(e, nd){
    var items = [
      { label:'打开', action: function(){ openFile(nd.path, nd.name); } }
    ];
    // PDF 没有源码可编辑，不提供编辑项
    if(!isPdfPath(nd.name)){
      items.push({ label:'编辑', action: function(){ openFile(nd.path, nd.name); setTimeout(enterEdit, 260); } });
    }
    items = items.concat([
      starItem(ROOT ? ROOT.replace(/[\\/]+$/, '') + '/' + nd.path : nd.path),
      { sep: true },
      copyNameItem(nd.name),
      copyPathItem(nd.path),
      { sep: true },
      { label:'创建副本', action: function(){ doDuplicate(nd); } },
      { label:'复制到文件夹…', action: function(){ doCopyTo(nd); } },
      { sep: true },
      { label:'重命名', action: function(){ doRename(nd); } },
      { sep: true },
      { label:'在资源管理器中显示', action: function(){ doReveal(nd.path); } },
      { label:'设置根目录…', action: promptRoot },
      { sep: true },
      { label:'删除', danger: true, action: function(){ doDelete(nd); } }
    ]);
    showMenu(e.clientX, e.clientY, items);
  }
  function dirMenu(e, nd){
    showMenu(e.clientX, e.clientY, [
      { label:'在此新建文件', action: function(){ doNewFile(nd.path); } },
      { label:'在此新建文件夹', action: function(){ doNewDir(nd.path); } },
      { label:'重命名', action: function(){ doRename(nd); } },
      { sep: true },
      copyNameItem(nd.name),
      copyPathItem(nd.path),
      { sep: true },
      { label:'在资源管理器中打开', action: function(){ doReveal(nd.path); } },
      { label:'设置根目录…', action: promptRoot },
      { sep: true },
      { label:'删除文件夹', danger: true, action: function(){ doDelete(nd); } }
    ]);
  }

  // 侧边栏空白处右键：根目录级操作
  function blankMenu(e){
    showMenu(e.clientX, e.clientY, [
      { label:'添加外部文档…', action: function(){ addExternal(); } },
      { sep: true },
      { label:'设置根目录…', action: promptRoot },
      { label:'刷新文件树', action: function(){
          loadTree().catch(function(err){ alert('刷新失败: ' + err.message); });
        } },
      { sep: true },
      { label:'在根目录新建文件', action: function(){ doNewFile(''); } },
      { label:'在根目录新建文件夹', action: function(){ doNewDir(''); } },
      { sep: true },
      { label:'在资源管理器中打开根目录', action: function(){
          if(!ROOT){ promptRoot(); return; }
          doReveal('');
        } }
    ]);
  }

  // 根目录节点右键菜单
  function rootMenu(e){
    showMenu(e.clientX, e.clientY, [
      { label:'在此新建文件', action: function(){ doNewFile(''); } },
      { label:'在此新建文件夹', action: function(){ doNewDir(''); } },
      { sep: true },
      { label:'刷新文件树', action: function(){
          loadTree().catch(function(err){ alert('刷新失败: ' + err.message); });
        } },
      copyPathItem(ROOT),
      { label:'在资源管理器中打开', action: function(){
          if(!ROOT){ promptRoot(); return; }
          doReveal('');
        } },
      { sep: true },
      { label:'设置根目录…', action: promptRoot }
    ]);
  }

  // 在系统文件管理器中显示（path 为空 = 根目录）
  function doReveal(path){
    apiJSON('/api/reveal?path=' + encodeURIComponent(path || ''), 'POST')
      .catch(function(err){ alert('打开失败: ' + err.message); });
  }

  function doNewFile(dir){
    var name = prompt('新建文件名（自动补 .md）:', '');
    if(!name) return;
    name = name.trim();
    if(!name) return;
    // 用户没写扩展名时自动补 .md（只支持 md/markdown/txt）
    if(!/\.(md|markdown|txt)$/i.test(name)){
      name = name + '.md';
    }
    var path = (dir ? dir + '/' : '') + name;
    apiJSON('/api/file?path=' + encodeURIComponent(path), 'POST', '# ' + name.replace(/\.(md|markdown|txt)$/i,'') + '\n\n')
      .then(function(){ return loadTree(); })
      .then(function(){ openFile(path, name); })
      .catch(function(err){ alert('新建失败: ' + err.message); });
  }
  function doNewDir(dir){
    var name = prompt('新建文件夹名:', '');
    if(!name) return;
    var path = (dir ? dir + '/' : '') + name;
    apiJSON('/api/dir?path=' + encodeURIComponent(path), 'POST')
      .then(loadTree)
      .catch(function(err){ alert('新建失败: ' + err.message); });
  }
  function doRename(nd){
    var name = prompt('新名称:', nd.name);
    if(!name || name === nd.name) return;
    var parts = nd.path.split('/');
    parts[parts.length-1] = name;
    var to = parts.join('/');
    apiJSON('/api/rename', 'POST', { from: nd.path, to: to })
      .then(function(){
        // 同步更新已打开文档
        DOCS.forEach(function(d){
          if(d.path === nd.path){ d.path = to; d.name = name; }
          else if(d.path.indexOf(nd.path + '/') === 0){ d.path = to + d.path.slice(nd.path.length); }
        });
        return loadTree();
      })
      .then(function(){ if(DOCS[current]) markActive(DOCS[current].path); })
      .catch(function(err){ alert('重命名失败: ' + err.message); });
  }
  // 收集文件树中所有目录（含根目录，path 为空表示根）
  function collectDirs(nodes, depth, out){
    out = out || [{ path:'', name:'根目录', depth:0 }];
    (nodes||[]).forEach(function(nd){
      if(nd.isDir){ out.push({ path: nd.path, name: nd.name, depth: depth }); collectDirs(nd.children, depth+1, out); }
    });
    return out;
  }

  // 创建副本：复制到同目录，后端自动改名「xxx 副本」
  function doDuplicate(nd){
    var dir = nd.path.indexOf('/') >= 0 ? nd.path.slice(0, nd.path.lastIndexOf('/')) : '';
    apiJSON('/api/copy?path=' + encodeURIComponent(nd.path) + '&to=' + encodeURIComponent(dir), 'POST')
      .then(function(){ return loadTree(); })
      .catch(function(err){ alert('创建副本失败: ' + err.message); });
  }

  // 复制到文件夹：弹目录选择，复制到所选目录
  function doCopyTo(nd){
    var dirs = collectDirs(lastNodes, 1);
    showDirPicker(dirs, function(target){
      apiJSON('/api/copy?path=' + encodeURIComponent(nd.path) + '&to=' + encodeURIComponent(target || ''), 'POST')
        .then(function(){ return loadTree(); })
        .catch(function(err){ alert('复制失败: ' + err.message); });
    });
  }

  // 简单的目录选择器（root 内的目录列表）
  var _dirPickerMask = null;
  function showDirPicker(dirs, onDone){
    closeMenu();
    if(_dirPickerMask) _dirPickerMask.remove();
    var mask = document.createElement('div');
    mask.className = 'dlg-mask';
    _dirPickerMask = mask;
    var dlg = document.createElement('div');
    dlg.className = 'dlg';
    var rows = dirs.map(function(d){
      var pad = 10 + (d.depth||0)*14;
      var icon = d.path === '' ? '🏠' : '📁';
      return '<div class="dlg-row" data-path="' + escapeHtml(d.path) + '" style="padding-left:' + pad + 'px">' +
             '<span class="dlg-row-icon">' + icon + '</span><span class="dlg-row-name">' + escapeHtml(d.name) + '</span></div>';
    }).join('');
    dlg.innerHTML =
      '<div class="dlg-title">复制到文件夹</div>' +
      '<div class="dlg-list" style="max-height:320px;overflow-y:auto;padding:8px">' + rows + '</div>' +
      '<div class="dlg-foot">' +
        '<button class="dlg-cancel">取消</button>' +
      '</div>';
    mask.appendChild(dlg);
    document.body.appendChild(mask);
    dlg.querySelectorAll('.dlg-row').forEach(function(r){
      r.onclick = function(){
        var p = r.getAttribute('data-path');
        close();
        onDone(p);
      };
    });
    dlg.querySelector('.dlg-cancel').onclick = close;
    mask.onclick = function(e){ if(e.target === mask) close(); };
    function close(){ if(_dirPickerMask) _dirPickerMask.remove(); _dirPickerMask = null; }
  }

  function doDelete(nd){
    var what = nd.isDir ? '文件夹（含内部所有内容）' : '文件';
    if(!confirm('确定真删除' + what + '？\n' + nd.path + '\n\n此操作不可恢复！')) return;
    apiJSON('/api/file?path=' + encodeURIComponent(nd.path), 'DELETE')
      .then(function(){
        // 从已打开列表移除
        DOCS.forEach(function(d, i){
          if(d.path === nd.path || d.path.indexOf(nd.path + '/') === 0){ d._removed = true; }
        });
        DOCS = DOCS.filter(function(d){ return !d._removed; });
        articles.innerHTML = '';
        current = -1;
        if(DOCS.length){ selectDoc(0); }
        else { empty.style.display = 'block'; tocnav.innerHTML=''; document.title='MD 阅读器'; }
        return loadTree();
      })
      .catch(function(err){ alert('删除失败: ' + err.message); });
  }

  /* ============ 设置根目录 ============ */
  function promptRoot(){
    var cur = ROOT;
    var v = prompt('设置数据根目录（绝对路径）:', cur);
    if(!v) return;
    apiJSON('/api/config', 'POST', { root: v })
      .then(function(c){ ROOT = c.root; return loadTree(); })
      .catch(function(err){ alert('设置失败: ' + err.message); });
  }

  /* ============ 工具条按钮 ============ */
  var btnEdit = $('btnEdit');
  if(btnEdit) btnEdit.onclick = function(){ if(editing) exitEdit(); else enterEdit(); };

  /* ============ 快捷键 ============ */
  document.addEventListener('keydown', function(e){
    if(e.target && /input|textarea/i.test(e.target.tagName)){
      if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='s'){ e.preventDefault(); }
      return;
    }
    if(e.key === 'ArrowRight' && DOCS.length > 1){ selectDoc(Math.min(current+1, DOCS.length-1)); }
    if(e.key === 'ArrowLeft'  && DOCS.length > 1){ selectDoc(Math.max(current-1, 0)); }
    if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='s'){ e.preventDefault(); }
  });

  /* ============ 进度条 ============ */
  var bar = $('progress');
  window.addEventListener('scroll', function(){
    var h = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = (h > 0 ? (window.scrollY / h) * 100 : 0) + '%';
  }, {passive:true});

  /* ============ 侧栏收拢 ============ */
  function syncToggleBtns(){
    var sb = $('sidebar'), tb = $('toc-sidebar');
    var sbC = sb.classList.contains('collapsed'), tbC = tb.classList.contains('collapsed');
    document.body.classList.toggle('sb-collapsed', sbC);
    document.body.classList.toggle('toc-collapsed', tbC);
    if(sbToggle) sbToggle.textContent = sbC ? '›' : '‹';
    if(tocToggle) tocToggle.textContent = tbC ? '‹' : '›';
  }
  function toggleSidebar(){
    $('sidebar').classList.toggle('collapsed');
    syncToggleBtns();
  }
  function toggleToc(){
    $('toc-sidebar').classList.toggle('collapsed');
    syncToggleBtns();
  }
  /* ============ 文件栏宽度拖动 ============ */
  var SB_W_KEY = 'md-reader-sb-w', SB_MIN = 200, SB_MAX = 720;
  function applySbWidth(w){
    w = Math.round(Math.min(SB_MAX, Math.max(SB_MIN, w)));
    document.documentElement.style.setProperty('--sb-w', w + 'px');
    return w;
  }
  try{
    var savedW = parseInt(localStorage.getItem(SB_W_KEY), 10);
    if(savedW) applySbWidth(savedW);
  }catch(e){}
  var sbResizer = $('sidebar-resizer');
  if(sbResizer){
    sbResizer.addEventListener('mousedown', function(ev){
      if(ev.button !== 0) return;
      ev.preventDefault();
      var startX = ev.clientX;
      var startW = $('sidebar').getBoundingClientRect().width;
      var w = startW;
      sbResizer.classList.add('dragging');
      document.body.classList.add('sb-resizing');
      function onMove(e){
        // 上限不超过窗口宽度的 60%，留出正文空间
        var max = Math.min(SB_MAX, Math.round(window.innerWidth * 0.6));
        w = Math.round(Math.min(max, Math.max(SB_MIN, startW + e.clientX - startX)));
        document.documentElement.style.setProperty('--sb-w', w + 'px');
      }
      function onUp(){
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        sbResizer.classList.remove('dragging');
        document.body.classList.remove('sb-resizing');
        try{ localStorage.setItem(SB_W_KEY, String(w)); }catch(e){}
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    // 双击拖动条：恢复默认宽度
    sbResizer.addEventListener('dblclick', function(){
      applySbWidth(308);
      try{ localStorage.setItem(SB_W_KEY, '308'); }catch(e){}
    });
  }

  var sbToggle = $('sidebar-toggle'), tocToggle = $('toc-toggle');
  if(sbToggle) sbToggle.onclick = toggleSidebar;
  if(tocToggle) tocToggle.onclick = toggleToc;
  // 启动时：左侧文件栏展开、右侧目录栏收拢
  $('sidebar').classList.remove('collapsed');
  $('toc-sidebar').classList.add('collapsed');
  syncToggleBtns();

  /* ============ 图片放大 ============ */
  window.openLightbox = function(src){
    var lb = $('lightbox');
    lb.querySelector('img').src = src;
    lb.classList.add('on');
  };
  $('lightbox').onclick = function(e){ e.currentTarget.classList.remove('on'); };
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape') $('lightbox').classList.remove('on');
  });

  /* ============ 启动 ============ */
  // 在节点树里按路径查找文件节点（返回 name，找不到返回 null）
  function findNameByPath(nodes, p){
    if(!nodes) return null;
    for(var i=0;i<nodes.length;i++){
      var nd = nodes[i];
      if(!nd.isDir && nd.path === p) return nd.name;
      if(nd.isDir && nd.children){
        var r = findNameByPath(nd.children, p);
        if(r) return r;
      }
    }
    return null;
  }

  // 恢复上次打开的文档（localCache）
  function restoreLast(){
    var last;
    try{ last = localStorage.getItem('md-reader-last'); }catch(e){}
    if(!last) return;
    // 在根目录文件树里找
    var name = findNameByPath(lastNodes, last);
    if(name){ openFile(last, name); return; }
    // 在外部文档树里找
    name = findNameByPath(extNodes, last);
    if(name){ openFile(last, name); return; }
  }

  /* ============ 侧栏筛选（只匹配文件名 / 路径） ============ */
  (function(){
    var inp = $('file-filter');
    if(!inp) return;
    inp.oninput = function(){
      filterText = inp.value.trim().toLowerCase();
      renderTree(lastNodes);
    };
    inp.onkeydown = function(e){
      if(e.key === 'Escape'){
        inp.value = '';
        filterText = '';
        renderTree(lastNodes);
        inp.blur();
      }
    };
  })();

  loadConfig().then(function(){
    if(!ROOT){
      loadExternal().then(function(){
        restoreLast();
        promptRoot();
      });
      return;
    }
    return loadTree().then(loadExternal).then(restoreLast);
  });
  // 用事件委托兜底 TOC 渲染顺序
  window.__mdReader = { openFile: openFile, loadTree: loadTree, enterEdit: enterEdit, exitEdit: exitEdit, loadExternal: loadExternal };

  /* ============ 拖拽导入外部文档 ============ */
  // 浏览器不提供文件绝对路径，拖入后弹窗补路径，再登记为外部文档（只记路径，不复制）
  (function(){
    var dragDepth = 0;
    var overlay = null;
    function ensureOverlay(){
      if(overlay) return overlay;
      overlay = document.createElement('div');
      overlay.id = 'dropOverlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9998;display:none;background:rgba(20,22,26,.72);backdrop-filter:blur(3px);align-items:center;justify-content:center;pointer-events:none';
      overlay.innerHTML = '<div style="border:2px dashed rgba(251,146,60,.9);border-radius:16px;padding:40px 56px;text-align:center;color:#e8e6e1;font-family:inherit">' +
        '<div style="font-size:20px;font-weight:600;margin-bottom:8px">松开以登记外部文档</div>' +
        '<div style="font-size:13px;opacity:.75">只记录路径，不复制文件</div></div>';
      document.body.appendChild(overlay);
      return overlay;
    }
    function showOverlay(on){ ensureOverlay().style.display = on ? 'flex' : 'none'; }
    function hasFiles(e){
      if(!e.dataTransfer) return false;
      // 侧栏内部拖拽（星标文档 / 逻辑目录）不是导入文件
      if(e.dataTransfer.types && e.dataTransfer.types.length === 0) return false;
      var t = e.dataTransfer.types;
      if(!t) return false;
      var onlyFiles = true;
      for(var i=0;i<t.length;i++){ if(t[i] !== 'Files') onlyFiles = false; }
      return onlyFiles;
    }
    document.addEventListener('dragenter', function(e){
      if(!hasFiles(e)) return;
      e.preventDefault(); dragDepth++; showOverlay(true);
    }, true);
    document.addEventListener('dragover', function(e){
      if(!hasFiles(e)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'link';
    }, true);
    document.addEventListener('dragleave', function(e){
      if(!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if(dragDepth === 0) showOverlay(false);
    }, true);
    document.addEventListener('drop', function(e){
      if(!hasFiles(e)) return;
      e.preventDefault(); e.stopPropagation();
      dragDepth = 0; showOverlay(false);
      var files = e.dataTransfer.files;
      if(!files || !files.length) return;
      var names = [];
      for(var i=0;i<files.length;i++) names.push(files[i].name);
      handleDrop(names);
    }, true);

    function handleDrop(names){
      var hint = '拖入 ' + names.length + ' 个文件：\n' +
        names.slice(0,8).map(function(n){ return '  · ' + n; }).join('\n') +
        (names.length > 8 ? '\n  …还有 ' + (names.length-8) + ' 个' : '') +
        '\n\n浏览器出于安全限制不提供文件完整路径。\n请粘贴这些文件所在的文件夹路径（脚本会自动定位文件名）：\n';
      var dir = prompt(hint, lastDir());
      if(!dir) return;
      dir = dir.trim().replace(/^"|"$/g, '').replace(/[\\/]+$/, '');
      if(!dir) return;
      rememberDir(dir);
      var queue = names.slice();
      var added = [];
      function apiPostExternal(abs){
        return fetch('/api/external?path=' + encodeURIComponent(abs), { method:'POST' })
          .then(function(r){
            return r.text().then(function(t){
              var j = null; try{ j = JSON.parse(t); }catch(e2){}
              if(!r.ok) throw new Error((j && j.error) || t || ('HTTP '+r.status));
              return j;
            });
          });
      }
      function next(){
        if(!queue.length){
          var first = added.find(function(a){ return !a.error; });
          loadExternal().then(function(){
            if(first) openFile(first.path, first.name);
          });
          var bad = added.filter(function(a){ return a.error; });
          if(bad.length){
            setTimeout(function(){
              alert('以下文件未能登记：\n' + bad.map(function(a){ return '  · '+a.name+' — '+a.error; }).join('\n'));
            }, 100);
          }
          return;
        }
        var name = queue.shift();
        var full = (dir + '\\' + name).replace(/\\/g, '/');
        apiPostExternal(full).then(function(){
          added.push({ path: full, name: name });
          next();
        }).catch(function(err){
          added.push({ name: name, error: err.message });
          next();
        });
      }
      next();
    }
    function lastDir(){ try{ return localStorage.getItem('md-reader-drop-dir') || ''; }catch(e){ return ''; } }
    function rememberDir(d){ try{ localStorage.setItem('md-reader-drop-dir', d); }catch(e){} }
  })();

  /* ============ Markdown 解析 ============ */
  function escapeHtml(s){
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  var PHR = [];   // 占位数组，存 {type:'code'|'math', body}
  function protect(s, re, type){
    return s.replace(re, function(m, body){
      var ph = '\u0001P' + (PHR.length) + '\u0001';
      PHR.push({ type: type, body: body });
      return ph;
    });
  }
  function restore(s){
    return s.replace(/\u0001P(\d+)\u0001/g, function(m, idx){
      var it = PHR[parseInt(idx,10)];
      if(it.type === 'code') return '<code class="inline">' + it.body + '</code>';
      if(it.type === 'math') return '<span class="math-inline">$' + it.body + '$</span>';
      return '';
    });
  }
  function inline(s){
    PHR = [];
    // 1. 先保护行内代码 `...`（内容里的 * _ < & 等一律不处理）
    s = protect(s, /`([^`\n]+)`/g, 'code');
    // 2. 保护行内公式 $...$
    s = protect(s, /\$([^$\n]+?)\$/g, 'math');
    // 3. 转义 HTML（占位符里没有 <>&，不受影响）
    s = escapeHtml(s);
    // 4. 图片 / 链接
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:8px;cursor:zoom-in" onclick="openLightbox(this.src)">');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // 5. 加粗 / 斜体 / 删除线
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_])_([^_\s][^_]*?)_(?!_)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    // 6. 还原占位
    return restore(s);
  }
  function highlight(code, lang){
    code = escapeHtml(code);
    if(!lang) return code;
    var L = lang.toLowerCase();
    if(/^(py|python|js|javascript|ts|typescript|java|c|cpp|c#|cs|go|rust|rs|sh|bash|json|html|css|sql|text)$/.test(L)){
      code = code.replace(/(#[^\n]*|\/\/[^\n]*)/g, '<span class="s-com">$1</span>');
      code = code.replace(/(&quot;[^&quot;\n]*&quot;|&#39;[^&#39;\n]*&#39;|&quot;.*?&quot;)/g, '<span class="s-str">$1</span>');
      var kw = /\b(def|class|return|if|else|elif|for|while|import|from|as|in|not|and|or|None|True|False|function|const|let|var|new|typeof|instanceof|public|private|static|void|int|float|double|string|bool|fn|mut|loop|match|struct|enum|impl|use|package|type|func|go|defer|chan|select|break|continue|switch|case|default|try|catch|finally|throw|await|async|yield|lambda)\b/g;
      code = code.replace(kw, '<span class="s-kw">$1</span>');
      code = code.replace(/\b(\d+\.?\d*)\b/g, '<span class="s-num">$1</span>');
    }
    return code;
  }

  function parseList(lines, startIdx, ordered){
    var html = '';
    var i = startIdx;
    var tag = ordered ? 'ol' : 'ul';
    html += '<'+tag+'>';
    while(i < lines.length){
      var line = lines[i];
      if(/^\s*$/.test(line)){ break; }
      var m = ordered ? line.match(/^\s*(\d+)[.)]\s+(.*)$/) : line.match(/^\s*[-*+]\s+(.*)$/);
      if(!m){ break; }
      html += '<li>' + inline(ordered ? m[2] : m[1]);
      i++;
      var sub = [];
      while(i < lines.length && (/^\s+[-*+]\s+/.test(lines[i]) || /^\s+\d+[.)]\s+/.test(lines[i]))){
        sub.push(lines[i]); i++;
      }
      if(sub.length){
        var orderedSub = /^\s+\d+[.)]\s+/.test(sub[0]);
        var subHtml = orderedSub ? '<ol>' : '<ul>';
        var k = 0;
        while(k < sub.length){
          var sm = orderedSub ? sub[k].match(/^\s*\d+[.)]\s+(.*)$/) : sub[k].match(/^\s*[-*+]\s+(.*)$/);
          if(sm){ subHtml += '<li>' + inline(orderedSub ? sm[2] : sm[1]) + '</li>'; }
          k++;
        }
        subHtml += orderedSub ? '</ol>' : '</ul>';
        html += subHtml;
      }
      html += '</li>';
    }
    html += '</'+tag+'>';
    return { html: html, i: i };
  }

  function parseMarkdown(md){
    var lines = md.replace(/\r\n/g,'\n').split('\n');
    var html = [];
    var i = 0, n = lines.length;
    while(i < n){
      var line = lines[i];

      // 代码块
      var fence = line.match(/^```(\S*)\s*$/);
      if(fence){
        var lang = fence[1] || '';
        var buf = [];
        i++;
        while(i < n && !/^```\s*$/.test(lines[i])){ buf.push(lines[i]); i++; }
        i++;
        var src = buf.join('\n');
        // mermaid 图表：输出源码容器，由 renderMermaid 异步渲染（含思维导图 mindmap）
        if(/^mermaid$/i.test(lang)){
          html.push('<div class="mermaid-wrap"><div class="mermaid" data-src="' +
            escapeHtml(src) + '">' + escapeHtml(src) + '</div></div>');
          continue;
        }
        html.push('<div class="code-block"><div class="code-head">' +
          '<span class="dot"></span><span class="dot"></span><span class="dot"></span>' +
          (lang ? '<span class="lang">' + escapeHtml(lang) + '</span>' : '') +
          '</div><pre><code>' + highlight(src, lang) + '</code></pre></div>');
        continue;
      }
      // 块级公式 $$...$$（支持单行闭合与跨行）
      if(/^\s*\$\$/.test(line)){
        var body0 = line.replace(/^\s*\$\$/, '');
        var mlatex;
        if(/\$\$\s*$/.test(body0)){          // 单行闭合：$$ ... $$
          mlatex = body0.replace(/\$\$\s*$/, '').trim();
          i++;
        } else {                             // 跨行：收集到下一个 $$
          var math = [body0];
          i++;
          while(i < n && !/\$\$\s*$/.test(lines[i])){ math.push(lines[i]); i++; }
          if(i < n){ math.push(lines[i].replace(/\$\$\s*$/, '')); i++; }
          mlatex = math.join('\n');
        }
        html.push('<div class="math-block">$$' + mlatex + '$$</div>');
        continue;
      }
      // 原生 HTML 表格（<table ...>...)</table>）：按块原样输出，交给浏览器渲染
      if(/^\s*<table[\s>]/i.test(line)){
        var tbuf = [];
        var sameLine = /<\/table>\s*$/i.test(line);
        tbuf.push(line); i++;
        while(!sameLine && i < n){ tbuf.push(lines[i]); if(/<\/table>/i.test(lines[i])) break; i++; }
        if(i < n && !sameLine) i++;
        html.push('<div class="table-wrap">' + tbuf.join('\n') + '</div>');
        continue;
      }
      // 水平线
      if(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)){ html.push('<hr>'); i++; continue; }
      // 标题
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if(h){
        var lv = h[1].length;
        html.push('<h'+lv+'>' + inline(h[2]) + '</h'+lv+'>');
        i++; continue;
      }
      // 引用
      if(/^\s*>\s?/.test(line)){
        var q = [];
        while(i < n && /^\s*>\s?/.test(lines[i])){ q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        html.push('<blockquote>' + q.map(function(l){ return '<p>' + inline(l) + '</p>'; }).join('') + '</blockquote>');
        continue;
      }
      // 表格
      if(/^\s*\|.*\|\s*$/.test(line) && i+1 < n && /^\s*\|?[\s:|-]+\|[\s:|-]+\|?\s*$/.test(lines[i+1])){
        var headRow = line.trim().replace(/^\||\|$/g,'').split('|').map(function(c){ return c.trim(); });
        var aligns = lines[i+1].trim().replace(/^\||\|$/g,'').split('|').map(function(c){
          c = c.trim();
          if(/^:.*:$/.test(c)) return 'center';
          if(/:$/.test(c)) return 'right';
          return 'left';
        });
        var rows = [];
        i += 2;
        while(i < n && /^\s*\|.*\|\s*$/.test(lines[i])){
          rows.push(lines[i].trim().replace(/^\||\|$/g,'').split('|').map(function(c){ return c.trim(); }));
          i++;
        }
        var th = '<thead><tr>' + headRow.map(function(c,k){ return '<th style="text-align:'+(aligns[k]||'left')+'">' + inline(c) + '</th>'; }).join('') + '</tr></thead>';
        var tb = '<tbody>' + rows.map(function(r){
          return '<tr>' + r.map(function(c,k){ return '<td style="text-align:'+(aligns[k]||'left')+'">' + inline(c) + '</td>'; }).join('') + '</tr>';
        }).join('') + '</tbody>';
        html.push('<div class="table-wrap"><table border="1" cellpadding="4" cellspacing="0">' + th + tb + '</table></div>');
        continue;
      }
      // 列表
      if(/^\s*[-*+]\s+/.test(line)){
        var r = parseList(lines, i, false);
        html.push(r.html); i = r.i; continue;
      }
      if(/^\s*\d+[.)]\s+/.test(line)){
        var r2 = parseList(lines, i, true);
        html.push(r2.html); i = r2.i; continue;
      }
      // 空行
      if(/^\s*$/.test(line)){ i++; continue; }
      // 段落（多行合并）
      var para = [line.trim()];
      i++;
      while(i < n && !/^\s*$/.test(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) && !/^```/.test(lines[i]) &&
            !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i]) &&
            !/^\s*>\s?/.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i]) && !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])){
        para.push(lines[i].trim());
        i++;
      }
      html.push('<p>' + inline(para.join(' ')) + '</p>');
    }
    return html.join('\n');
  }

  /* ============ 目录收集（h1-h3，带锚点 id） ============ */
  function collectHeadings(md){
    var lines = md.replace(/\r\n/g,'\n').split('\n');
    var inCode = false;
    var out = [];
    for(var i=0;i<lines.length;i++){
      var l = lines[i];
      if(/^```/.test(l)){ inCode = !inCode; continue; }
      if(inCode) continue;
      var m = l.match(/^(#{1,4})\s+(.*)$/);
      if(m){
        var lv = m[1].length;
        out.push({ text: m[2], lv: lv });
      }
    }
    return out;
  }

  /* 给已渲染的标题加锚点 id（与 TOC 对应） */
  function attachAnchors(){
    var hs = articles.querySelectorAll('article.show h1, article.show h2, article.show h3');
    var idx = 0;
    hs.forEach(function(h){
      h.id = 'mdh-' + idx;
      idx++;
    });
  }
  /* ============ 滚动高亮当前目录项 ============ */
  window.addEventListener('scroll', function(){
    if(current < 0) return;
    var hs = articles.querySelectorAll('article.show h1, article.show h2, article.show h3, article.show h4');
    var links = tocnav.querySelectorAll('a');
    if(!hs.length) return;
    var curLink = 0;
    var st = window.scrollY + 100;
    hs.forEach(function(h, i){
      if(h.offsetTop <= st) curLink = i;
    });
    links.forEach(function(a, i){ a.classList.toggle('active', i===curLink); });
  }, {passive:true});

  /* 调试/集成钩子 */
  window.__readerSelect = function(i){ selectDoc(i); };
  window.__readerOpen = function(path, name){ openFile(path, name); };
})();
