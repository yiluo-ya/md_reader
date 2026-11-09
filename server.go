package main

// MD 阅读器本地服务：仅用 Go 标准库，无第三方依赖。
// 监听 127.0.0.1，提供静态前端 + 文件读写 API（限定在根目录内）。

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const defaultPort = "5656"

// ---------- 配置 ----------

// PathMap 路径 -> 逻辑名称（给路径起名，只影响显示，不改磁盘文件名）。
// 键用 normalizeKey 规范化（小写 + 正斜杠），Windows 路径不区分大小写。
type PathMap map[string]string

// ExtGroup 星级文档里的逻辑目录（纯组织管理，不移动真实文件）。
// 没有根目录：目录之间靠 Parent 形成层级，空串表示直接挂在「星级文档」下。
type ExtGroup struct {
	Name    string `json:"name"`
	Id      string `json:"id"`
	Parent  string `json:"parent,omitempty"` // 父目录 id，空 = 顶层
	Members []string `json:"members"`       // 成员：文档绝对路径，正斜杠
}

type Config struct {
	Root      string     `json:"root"`
	Externals []string   `json:"externals,omitempty"` // 已登记的外部文件/文件夹绝对路径
	Starred   []string   `json:"starred,omitempty"`   // 关注（星标）的文档绝对路径：星级文档的唯一来源
	// 关注了文件夹时，被单独取消关注的文件（只排除它自己，文件夹继续关注）
	StarExclude []string `json:"starExclude,omitempty"`
	Groups    []ExtGroup `json:"groups,omitempty"`    // 星级文档里的逻辑目录
	Names     PathMap    `json:"names,omitempty"`     // 道路径 -> 逻辑名称（在星级文档里的显示名）
}

// normalizeKey 统一路径比较口径：正斜杠 + 小写（Windows 文件系统不区分大小写）。
func normalizeKey(p string) string {
	return strings.ToLower(filepath.ToSlash(filepath.Clean(filepath.FromSlash(p))))
}

var configPath string

func loadConfig() Config {
	var c Config
	b, err := os.ReadFile(configPath)
	if err == nil {
		json.Unmarshal(b, &c)
	}
	// 旧配置兼容：以前逻辑目录的成员没有记录成「关注」，补进关注列表
	// （关注是星级文档的唯一来源，否则旧目录里的文件会从侧栏消失）
	for _, g := range c.Groups {
		for _, m := range g.Members {
			if isUnderAny(c.Starred, m) {
				continue
			}
			c.Starred = append(c.Starred, filepath.ToSlash(m))
		}
	}
	return c
}

func saveConfig(c Config) error {
	b, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(configPath, b, 0644)
}

// ---------- 路径安全 ----------

// safePath 把请求的相对路径解析成绝对路径，并确保它在根目录之内。
func safePath(root, rel string) (string, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	rel = filepath.FromSlash(rel)
	rel = strings.TrimPrefix(rel, string(filepath.Separator))
	full := filepath.Join(rootAbs, rel)
	fullAbs, err := filepath.Abs(full)
	if err != nil {
		return "", err
	}
	// 必须在 rootAbs 之下（含本身）
	if fullAbs != rootAbs && !strings.HasPrefix(fullAbs, rootAbs+string(filepath.Separator)) {
		return "", fmt.Errorf("路径越界")
	}
	return fullAbs, nil
}

// isExternal 判断 abs 是否落在一个已登记的外部路径内（含其递归子树）。
func isExternal(cfg Config, abs string) bool {
	for _, p := range cfg.Externals {
		pAbs, err := filepath.Abs(p)
		if err != nil {
			continue
		}
		if abs == pAbs || strings.HasPrefix(abs, pAbs+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// resolvePath 把一个路径参数解析成绝对路径。
// 规则：
//   - 绝对路径：必须在已登记的外部路径内，否则拒绝（防止读任意文件）
//   - 相对路径：相对当前根目录（无根目录时拒绝）
func resolvePath(cfg Config, p string) (string, error) {
	if p == "" {
		return "", fmt.Errorf("路径为空")
	}
	isAbs := filepath.IsAbs(p) || (len(p) > 1 && p[1] == ':') // Windows 盘符
	if isAbs {
		abs, err := filepath.Abs(filepath.FromSlash(p))
		if err != nil {
			return "", err
		}
		if !isExternal(cfg, abs) {
			return "", fmt.Errorf("外部路径未登记，请先添加该文件或文件夹")
		}
		return abs, nil
	}
	if cfg.Root == "" {
		return "", fmt.Errorf("尚未设置根目录")
	}
	return safePath(cfg.Root, p)
}

// ---------- 数据结构 ----------

type Node struct {
	Name     string `json:"name"`
	Path     string `json:"path"`     // 相对根目录，正斜杠
	IsDir    bool   `json:"isDir"`
	Children []Node `json:"children,omitempty"`
	ModTime  int64  `json:"modTime,omitempty"`
	Size     int64  `json:"size,omitempty"`
}

// buildTree 递归列出根目录下的文档文件（md/markdown/txt/pdf）和所有文件夹。
func buildTree(rootAbs, rel string) ([]Node, error) {
	dirAbs := rootAbs
	if rel != "" {
		var err error
		dirAbs, err = safePath(rootAbs, rel)
		if err != nil {
			return nil, err
		}
	}
	entries, err := os.ReadDir(dirAbs)
	if err != nil {
		return nil, err
	}
	nodes := []Node{}
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		childRel := name
		if rel != "" {
			childRel = rel + "/" + name
		}
		info, _ := e.Info()
		if e.IsDir() {
			children, _ := buildTree(rootAbs, childRel)
			nodes = append(nodes, Node{Name: name, Path: childRel, IsDir: true, Children: children})
		} else {
			if !isDocFile(name) {
				continue
			}
			var mt int64
			var sz int64
			if info != nil {
				mt = info.ModTime().Unix()
				sz = info.Size()
			}
			nodes = append(nodes, Node{Name: name, Path: childRel, IsDir: false, ModTime: mt, Size: sz})
		}
	}
	// 文件夹在前，然后按名称排序
	sort.Slice(nodes, func(i, j int) bool {
		if nodes[i].IsDir != nodes[j].IsDir {
			return nodes[i].IsDir
		}
		return strings.ToLower(nodes[i].Name) < strings.ToLower(nodes[j].Name)
	})
	return nodes, nil
}

// ---------- 工具 ----------

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func errJSON(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func readBody(r *http.Request) ([]byte, error) {
	defer r.Body.Close()
	return io.ReadAll(io.LimitReader(r.Body, 32<<20)) // 32MB 上限
}

// ---------- Handlers ----------

func handleConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, 200, loadConfig())
	case http.MethodPost:
		body, err := readBody(r)
		if err != nil {
			errJSON(w, 400, err.Error())
			return
		}
		var c Config
		if err := json.Unmarshal(body, &c); err != nil {
			errJSON(w, 400, "参数错误")
			return
		}
		if strings.TrimSpace(c.Root) == "" {
			errJSON(w, 400, "根目录不能为空")
			return
		}
		abs, err := filepath.Abs(c.Root)
		if err != nil {
			errJSON(w, 400, "路径无效")
			return
		}
		st, err := os.Stat(abs)
		if err != nil || !st.IsDir() {
			errJSON(w, 400, "目录不存在或不是文件夹")
			return
		}
		c.Root = abs
		// 前端只改根目录时会丢掉其余字段，这里保留原有登记
		old := loadConfig()
		if len(c.Externals) == 0 {
			c.Externals = old.Externals
		}
		if c.Starred == nil {
			c.Starred = old.Starred
		}
		if c.StarExclude == nil {
			c.StarExclude = old.StarExclude
		}
		if c.Groups == nil {
			c.Groups = old.Groups
		}
		if c.Names == nil {
			c.Names = old.Names
		}
		if err := saveConfig(c); err != nil {
			errJSON(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, c)
	default:
		errJSON(w, 405, "method not allowed")
	}
}

func handleTree(w http.ResponseWriter, r *http.Request) {
	cfg := loadConfig()
	if cfg.Root == "" {
		errJSON(w, 400, "尚未设置根目录")
		return
	}
	rootAbs, err := filepath.Abs(cfg.Root)
	if err != nil {
		errJSON(w, 500, err.Error())
		return
	}
	nodes, err := buildTree(rootAbs, "")
	if err != nil {
		errJSON(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]interface{}{"root": rootAbs, "nodes": nodes})
}

// isMdFile 是否为 Markdown / 纯文本文档扩展名。
func isMdFile(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	return ext == ".md" || ext == ".markdown" || ext == ".txt"
}

// isPdfFile 是否为 PDF（前端用 pdf.js 渲染）。
func isPdfFile(name string) bool {
	return strings.ToLower(filepath.Ext(name)) == ".pdf"
}

// isDocFile 是否为阅读器支持的文档（Markdown / 纯文本 / PDF）。
func isDocFile(name string) bool {
	return isMdFile(name) || isPdfFile(name)
}

// buildExternalTree 把一个已登记的外部路径展开成节点。
// 文件 -> 单个文件节点；文件夹 -> 文件夹节点（递归列出内部 .md）。
func buildExternalTree(abs string) (Node, error) {
	st, err := os.Stat(abs)
	if err != nil {
		return Node{}, err
	}
	if !st.IsDir() {
		return Node{
			Name:    filepath.Base(abs),
			Path:    filepath.ToSlash(abs),
			IsDir:   false,
			ModTime: st.ModTime().Unix(),
			Size:    st.Size(),
		}, nil
	}
	children, err := buildExternalDir(abs)
	if err != nil {
		children = []Node{}
	}
	return Node{Name: filepath.Base(abs), Path: filepath.ToSlash(abs), IsDir: true, Children: children}, nil
}

func buildExternalDir(dirAbs string) ([]Node, error) {
	entries, err := os.ReadDir(dirAbs)
	if err != nil {
		return nil, err
	}
	nodes := []Node{}
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		child := filepath.Join(dirAbs, name)
		info, _ := e.Info()
		if e.IsDir() {
			sub, _ := buildExternalDir(child)
			nodes = append(nodes, Node{Name: name, Path: filepath.ToSlash(child), IsDir: true, Children: sub})
		} else if isDocFile(name) {
			var mt, sz int64
			if info != nil {
				mt = info.ModTime().Unix()
				sz = info.Size()
			}
			nodes = append(nodes, Node{Name: name, Path: filepath.ToSlash(child), IsDir: false, ModTime: mt, Size: sz})
		}
	}
	sort.Slice(nodes, func(i, j int) bool {
		if nodes[i].IsDir != nodes[j].IsDir {
			return nodes[i].IsDir
		}
		return strings.ToLower(nodes[i].Name) < strings.ToLower(nodes[j].Name)
	})
	return nodes, nil
}

// addExternal 登记一个外部路径：已登记则跳过；若是已登记文件夹的子路径也跳过。
func addExternal(cfg *Config, abs string) error {
	for _, e := range cfg.Externals {
		eAbs, err := filepath.Abs(e)
		if err != nil {
			continue
		}
		if eAbs == abs || strings.HasPrefix(abs, eAbs+string(filepath.Separator)) {
			return nil // 已被覆盖
		}
	}
	// 新路径若是父目录，则去掉被它包含的旧条目
	kept := []string{}
	for _, e := range cfg.Externals {
		eAbs, _ := filepath.Abs(e)
		if !strings.HasPrefix(eAbs, abs+string(filepath.Separator)) {
			kept = append(kept, e)
		}
	}
	cfg.Externals = append(kept, abs)
	return saveConfig(*cfg)
}

// handleExternal 管理已登记的外部路径（只记路径，不复制文件）。
//
//	GET    /api/external            返回展开后的外部节点
//	POST   /api/external?path=<abs> 登记一个文件或文件夹
//	DELETE /api/external?path=<abs> 取消登记（不删原文件）
func handleExternal(w http.ResponseWriter, r *http.Request) {
	cfg := loadConfig()

	switch r.Method {
	case http.MethodGet:
		nodes := []Node{}
		kept := []string{}
		changed := false
		for _, p := range cfg.Externals {
			n, err := buildExternalTree(p)
			if err != nil {
				changed = true // 原路径已不存在，自动清理
				continue
			}
			kept = append(kept, p)
			nodes = append(nodes, n)
		}
		cfg.Externals = kept
		if changed {
			saveConfig(cfg)
		}
		writeJSON(w, 200, map[string]interface{}{"nodes": nodes})

	case http.MethodPost:
		p := strings.TrimSpace(r.URL.Query().Get("path"))
		p = strings.Trim(p, "\"'")
		if p == "" {
			errJSON(w, 400, "缺少 path 参数")
			return
		}
		abs, err := filepath.Abs(filepath.FromSlash(p))
		if err != nil {
			errJSON(w, 400, "路径无效")
			return
		}
		st, err := os.Stat(abs)
		if err != nil {
			errJSON(w, 404, "路径不存在: "+abs)
			return
		}
		if !st.IsDir() && !isDocFile(abs) {
			errJSON(w, 400, "只支持 .md / .markdown / .txt / .pdf 文件或文件夹")
			return
		}
		if err := addExternal(&cfg, abs); err != nil {
			errJSON(w, 500, err.Error())
			return
		}
		n, err := buildExternalTree(abs)
		if err != nil {
			errJSON(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]interface{}{"ok": true, "node": n, "path": filepath.ToSlash(abs)})

	case http.MethodDelete:
		p := strings.TrimSpace(r.URL.Query().Get("path"))
		if p == "" {
			errJSON(w, 400, "缺少 path 参数")
			return
		}
		abs, err := filepath.Abs(filepath.FromSlash(p))
		if err != nil {
			errJSON(w, 400, "路径无效")
			return
		}
		kept := []string{}
		for _, e := range cfg.Externals {
			eAbs, _ := filepath.Abs(e)
			if eAbs != abs {
				kept = append(kept, e)
			}
		}
		cfg.Externals = kept
		// 取消登记后，落在它内部的关注 / 逻辑命名一并清理
		starred := []string{}
		for _, s := range cfg.Starred {
			if !isUnderAny([]string{filepath.ToSlash(abs)}, s) {
				starred = append(starred, s)
			}
		}
		cfg.Starred = starred
		if cfg.Names != nil {
			for k := range cfg.Names {
				if isUnderAny([]string{abs}, k) {
					delete(cfg.Names, k)
				}
			}
			if len(cfg.Names) == 0 {
				cfg.Names = nil
			}
		}
		for i := range cfg.Groups {
			ms := []string{}
			for _, m := range cfg.Groups[i].Members {
				if !isUnderAny([]string{abs}, m) {
					ms = append(ms, m)
				}
			}
			cfg.Groups[i].Members = ms
		}
		if err := saveConfig(cfg); err != nil {
			errJSON(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]interface{}{"ok": true})

	default:
		errJSON(w, 405, "method not allowed")
	}
}

// findGroup 按 id 查找分组，返回指针与索引。
func findGroup(cfg *Config, id string) (int, *ExtGroup) {
	for i := range cfg.Groups {
		if cfg.Groups[i].Id == id {
			return i, &cfg.Groups[i]
		}
	}
	return -1, nil
}

// isDescendantGroup 判断 id 是否在 ancestor 的子树里（含 ancestor 自身）。
func isDescendantGroup(cfg Config, id, ancestor string) bool {
	if id == ancestor {
		return true
	}
	for {
		idx := -1
		for i := range cfg.Groups {
			if cfg.Groups[i].Id == id {
				idx = i
				break
			}
		}
		if idx < 0 || cfg.Groups[idx].Parent == "" {
			return false
		}
		id = cfg.Groups[idx].Parent
		if id == ancestor {
			return true
		}
	}
}

// inRoot 判断 abs 是否落在当前根目录内（含根目录本身）。
func inRoot(cfg Config, abs string) bool {
	if cfg.Root == "" {
		return false
	}
	rootAbs, err := filepath.Abs(cfg.Root)
	if err != nil {
		return false
	}
	return abs == rootAbs || strings.HasPrefix(abs, rootAbs+string(filepath.Separator))
}

// isStarredPath 判断 abs 是否在关注列表里（关注了一个文件夹时，其内部文件也算）。
func isStarredPath(cfg Config, abs string) bool {
	target := normalizeKey(abs)
	for _, s := range cfg.Starred {
		k := normalizeKey(s)
		if target == k || strings.HasPrefix(target, k+"/") {
			return true
		}
	}
	return false
}

// isSameAny 判断 abs 是否恰好等于 paths 中的某一项（不含其子路径）。
func isSameAny(paths []string, abs string) bool {
	t := normalizeKey(abs)
	for _, p := range paths {
		if normalizeKey(p) == t {
			return true
		}
	}
	return false
}

// isUnderAny 判断 abs 是否落在 paths 中任一路径内部（含其本子树）。
func isUnderAny(paths []string, abs string) bool {
	target := normalizeKey(abs)
	for _, p := range paths {
		b := normalizeKey(p)
		if target == b || strings.HasPrefix(target, b+"/") {
			return true
		}
	}
	return false
}

// handleExtGroup 管理星级文档里的逻辑目录（纯组织关系，不移动真实文件）。
//
//	GET    /api/extgroup             返回所有分组
//	POST   /api/extgroup             创建分组（body: {"name": "...", "parent": "<id>"}）
//	                                 带 id = 改名 / 移动（body 可给 name 与/或 parent）
//	DELETE /api/extgroup?id=<id>     删除分组及其子目录（只删分组，不删文件）
func handleExtGroup(w http.ResponseWriter, r *http.Request) {
	cfg := loadConfig()

	switch r.Method {
	case http.MethodGet:
		writeJSON(w, 200, map[string]interface{}{"groups": cfg.Groups})

	case http.MethodPost:
		body, err := readBody(r)
		if err != nil {
			errJSON(w, 400, err.Error())
			return
		}
		var req struct {
			Name   string  `json:"name"`
			Id     string  `json:"id"`
			Parent *string `json:"parent"` // 指针：区分「没给」和「给空 = 挪到顶层」
		}
		if err := json.Unmarshal(body, &req); err != nil {
			errJSON(w, 400, "参数错误")
			return
		}
		// 带 id = 改名 / 移动；否则新建
		if req.Id != "" {
			idx, _ := findGroup(&cfg, req.Id)
			if idx < 0 {
				errJSON(w, 404, "分组不存在")
				return
			}
			if req.Name != "" {
				name := strings.TrimSpace(req.Name)
				if name == "" {
					errJSON(w, 400, "目录名不能为空")
					return
				}
				cfg.Groups[idx].Name = name
			}
			if req.Parent != nil {
				parent := *req.Parent
				if parent == req.Id {
					errJSON(w, 400, "不能把目录移到自己里面")
					return
				}
				for i := range cfg.Groups {
					if cfg.Groups[i].Id == parent && isDescendantGroup(cfg, parent, req.Id) {
						errJSON(w, 400, "不能把目录移到自己的子目录里")
						return
					}
				}
				if parent != "" {
					if pidx, _ := findGroup(&cfg, parent); pidx < 0 {
						errJSON(w, 404, "父目录不存在")
						return
					}
				}
				cfg.Groups[idx].Parent = parent
			}
			if err := saveConfig(cfg); err != nil {
				errJSON(w, 500, err.Error())
				return
			}
			writeJSON(w, 200, map[string]interface{}{"ok": true, "group": cfg.Groups[idx]})
			return
		}
		name := strings.TrimSpace(req.Name)
		if name == "" {
			errJSON(w, 400, "目录名不能为空")
			return
		}
		parent := ""
		if req.Parent != nil {
			parent = *req.Parent
			if parent != "" {
				if pidx, _ := findGroup(&cfg, parent); pidx < 0 {
					errJSON(w, 404, "父目录不存在")
					return
				}
			}
		}
		g := ExtGroup{
			Name:    name,
			Id:      fmt.Sprintf("%d", time.Now().UnixNano()),
			Parent:  parent,
			Members: []string{},
		}
		cfg.Groups = append(cfg.Groups, g)
		if err := saveConfig(cfg); err != nil {
			errJSON(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]interface{}{"ok": true, "group": g})

	case http.MethodDelete:
		id := r.URL.Query().Get("id")
		if id == "" {
			errJSON(w, 400, "缺少 id 参数")
			return
		}
		// 连同所有子孙目录一起删；里面的文件若是关注状态，回落到「星级文档」根下
		doomed := map[string]bool{id: true}
		for i := range cfg.Groups {
			if doomed[cfg.Groups[i].Parent] {
				doomed[cfg.Groups[i].Id] = true
			}
		}
		kept := []ExtGroup{}
		for _, g := range cfg.Groups {
			if !doomed[g.Id] {
				kept = append(kept, g)
			}
		}
		cfg.Groups = kept
		if err := saveConfig(cfg); err != nil {
			errJSON(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]interface{}{"ok": true})

	default:
		errJSON(w, 405, "method not allowed")
	}
}

// handleExtGroupMember 管理逻辑分组的成员（外部文件归类）。
// 成员必须是已登记的外部路径（文件），物理文件不移动。
//
//	POST   /api/extgroup/member?group=<id>&path=<abs>
//	DELETE /api/extgroup/member?group=<id>&path=<abs>
func handleExtGroupMember(w http.ResponseWriter, r *http.Request) {
	cfg := loadConfig()
	gid := r.URL.Query().Get("group")
	p := strings.TrimSpace(r.URL.Query().Get("path"))
	if gid == "" || p == "" {
		errJSON(w, 400, "缺少 group 或 path 参数")
		return
	}
	idx, _ := findGroup(&cfg, gid)
	if idx < 0 {
		errJSON(w, 404, "分组不存在")
		return
	}
	abs, err := filepath.Abs(filepath.FromSlash(p))
	if err != nil {
		errJSON(w, 400, "路径无效")
		return
	}
	// 必须是已关注、且落在根目录或已登记外部路径内的文件（防止把任意文件塞进目录）
	if !isStarredPath(cfg, abs) {
		errJSON(w, 400, "该文档未关注，请先关注再归类")
		return
	}
	norm := filepath.ToSlash(abs)
	members := cfg.Groups[idx].Members

	switch r.Method {
	case http.MethodPost:
		for _, m := range members {
			if m == norm {
				writeJSON(w, 200, map[string]interface{}{"ok": true})
				return
			}
		}
		cfg.Groups[idx].Members = append(members, norm)
	case http.MethodDelete:
		kept := []string{}
		for _, m := range members {
			if m != norm {
				kept = append(kept, m)
			}
		}
		cfg.Groups[idx].Members = kept
	default:
		errJSON(w, 405, "method not allowed")
		return
	}
	if err := saveConfig(cfg); err != nil {
		errJSON(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]interface{}{"ok": true})
}

// handleStar 管理「关注」列表。关注是星级文档的唯一来源。
//
//	GET    /api/star                    返回 {starred:[...], names:{...}}
//	POST   /api/star?path=<abs>         关注（文档本身或其内部文件均可）
//	DELETE /api/star?path=<abs>         取消关注（同时删掉它的逻辑名称）
func handleStar(w http.ResponseWriter, r *http.Request) {
	cfg := loadConfig()

	if r.Method == http.MethodGet {
		names := cfg.Names
		if names == nil {
			names = PathMap{}
		}
		starred := cfg.Starred
		if starred == nil {
			starred = []string{}
		}
		writeJSON(w, 200, map[string]interface{}{"starred": starred, "names": names, "excluded": cfg.StarExclude})
		return
	}

	p := strings.TrimSpace(r.URL.Query().Get("path"))
	p = strings.Trim(p, "\"'")
	if p == "" {
		errJSON(w, 400, "缺少 path 参数")
		return
	}
	switch r.Method {
	case http.MethodPost:
		// 任意已登记的路径都可以关注（内部根目录、外部登记、以及它们的子文件）
		abs := ""
		if filepath.IsAbs(filepath.FromSlash(p)) || (len(p) > 1 && p[1] == ':') {
			a, err := filepath.Abs(filepath.FromSlash(p))
			if err != nil {
				errJSON(w, 400, "路径无效")
				return
			}
			// 只允许根目录内或已登记外部路径内的文件（防止随手关注任意文件）
			if !inRoot(cfg, a) && !isExternal(cfg, a) {
				errJSON(w, 400, "该路径既不在根目录也不在已登记的外部文档里")
				return
			}
			abs = a
		} else {
			a, err := resolvePath(cfg, p)
			if err != nil {
				errJSON(w, 400, err.Error())
				return
			}
			abs = a
		}
		if _, err := os.Stat(abs); err != nil {
			errJSON(w, 404, "路径不存在: "+abs)
			return
		}
		key := filepath.ToSlash(abs)
		for _, s := range cfg.Starred {
			if normalizeKey(s) == normalizeKey(key) {
				writeJSON(w, 200, map[string]interface{}{"ok": true})
				return
			}
		}
		cfg.Starred = append(cfg.Starred, key)
		// 重新关注一个之前被单独取消的文件：把它从排除表里拿掉
		if len(cfg.StarExclude) > 0 {
			keptEx := []string{}
			for _, e := range cfg.StarExclude {
				if normalizeKey(e) != normalizeKey(key) {
					keptEx = append(keptEx, e)
				}
			}
			cfg.StarExclude = keptEx
		}

	case http.MethodDelete:
		// single=1：只取消这一篇（它属于某个已关注文件夹时，记入排除表，文件夹继续保留）
		if r.URL.Query().Get("single") == "1" {
			if isUnderAny(cfg.Starred, p) && !isSameAny(cfg.Starred, p) {
				if !isUnderAny(cfg.StarExclude, p) {
					cfg.StarExclude = append(cfg.StarExclude, normalizeKey(p))
				}
			}
		}
		kept := []string{}
		for _, s := range cfg.Starred {
			if normalizeKey(s) != normalizeKey(p) {
				kept = append(kept, s)
			}
		}
		cfg.Starred = kept
		// 取消文件夹的整个关注时，排除表里落在它内部的一并清掉
		// （注意：只清严格子路径，别看它本身——单篇取消时 p 就是被排除的那一篇）
		if len(cfg.StarExclude) > 0 {
			base := normalizeKey(p)
			keptEx := []string{}
			for _, e := range cfg.StarExclude {
				ek := normalizeKey(e)
				if ek == base || !strings.HasPrefix(ek, base+"/") {
					keptEx = append(keptEx, e)
				}
			}
			cfg.StarExclude = keptEx
		}
		// 逻辑命名随关注一起消失；同时从所有逻辑目录里移除
		if cfg.Names != nil {
			delete(cfg.Names, normalizeKey(p))
			if len(cfg.Names) == 0 {
				cfg.Names = nil
			}
		}
		for i := range cfg.Groups {
			ms := []string{}
			for _, m := range cfg.Groups[i].Members {
				if normalizeKey(m) != normalizeKey(p) {
					ms = append(ms, m)
				}
			}
			cfg.Groups[i].Members = ms
		}

	default:
		errJSON(w, 405, "method not allowed")
		return
	}
	if err := saveConfig(cfg); err != nil {
		errJSON(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]interface{}{"ok": true})
}

// handleStarName 设置 / 清除某篇文档在星级文档里的逻辑名称（只影响显示，不改磁盘文件名）。
//
//	POST   /api/star/name?path=<abs>  body: {"name": "..."}（空串 = 恢复原名）
//	DELETE /api/star/name?path=<abs>  同上，等价于传空名称
func handleStarName(w http.ResponseWriter, r *http.Request) {
	cfg := loadConfig()
	p := strings.TrimSpace(r.URL.Query().Get("path"))
	if p == "" {
		errJSON(w, 400, "缺少 path 参数")
		return
	}
	name := ""
	if r.Method == http.MethodPost {
		body, err := readBody(r)
		if err != nil {
			errJSON(w, 400, err.Error())
			return
		}
		var req struct {
			Name string `json:"name"`
		}
		if len(body) > 0 {
			if err := json.Unmarshal(body, &req); err != nil {
				errJSON(w, 400, "参数错误")
				return
			}
		}
		name = strings.TrimSpace(req.Name)
	} else if r.Method != http.MethodDelete {
		errJSON(w, 405, "method not allowed")
		return
	}
	key := normalizeKey(p)
	if name == "" {
		if cfg.Names != nil {
			delete(cfg.Names, key)
			if len(cfg.Names) == 0 {
				cfg.Names = nil
			}
		}
	} else {
		if cfg.Names == nil {
			cfg.Names = PathMap{}
		}
		cfg.Names[key] = name
	}
	if err := saveConfig(cfg); err != nil {
		errJSON(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]interface{}{"ok": true})
}

func handleFile(w http.ResponseWriter, r *http.Request) {
	cfg := loadConfig()
	p := r.URL.Query().Get("path")
	if p == "" {
		errJSON(w, 400, "缺少 path 参数")
		return
	}
	full, err := resolvePath(cfg, p)
	if err != nil {
		errJSON(w, 400, err.Error())
		return
	}

	switch r.Method {
	case http.MethodGet:
		if isPdfFile(full) {
			// PDF 按二进制原样返回，交给前端 pdf.js 渲染。
			// 用 ServeContent 而非 Write：它支持 Range 请求（大文件按需读取）。
			f, err := os.Open(full)
			if err != nil {
				errJSON(w, 404, "文件不存在: "+err.Error())
				return
			}
			defer f.Close()
			st, err := f.Stat()
			if err != nil {
				errJSON(w, 500, err.Error())
				return
			}
			w.Header().Set("Content-Type", "application/pdf")
			http.ServeContent(w, r, filepath.Base(full), st.ModTime(), f)
			return
		}
		b, err := os.ReadFile(full)
		if err != nil {
			errJSON(w, 404, "文件不存在: "+err.Error())
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write(b)

	case http.MethodPut: // 保存（覆盖原始）
		body, err := readBody(r)
		if err != nil {
			errJSON(w, 400, err.Error())
			return
		}
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			errJSON(w, 500, err.Error())
			return
		}
		if err := os.WriteFile(full, body, 0644); err != nil {
			errJSON(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]interface{}{"ok": true, "path": p})

	case http.MethodPost: // 新建文件
		if _, err := os.Stat(full); err == nil {
			errJSON(w, 409, "文件已存在")
			return
		}
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			errJSON(w, 500, err.Error())
			return
		}
		body, _ := readBody(r)
		if len(body) == 0 {
			body = []byte("# 新建文档\n\n")
		}
		if err := os.WriteFile(full, body, 0644); err != nil {
			errJSON(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]interface{}{"ok": true, "path": p})

	case http.MethodDelete: // 真删除（文件或文件夹）
		if _, err := os.Stat(full); err != nil {
			errJSON(w, 404, "不存在")
			return
		}
		if err := os.RemoveAll(full); err != nil {
			errJSON(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]interface{}{"ok": true})

	default:
		errJSON(w, 405, "method not allowed")
	}
}

// handleBrowse 浏览任意目录，返回其子目录列表（用于文件夹选择器）。
// path 为空时列出磁盘根（Windows 下的盘符列表）。
func handleBrowse(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		errJSON(w, 405, "method not allowed")
		return
	}
	p := r.URL.Query().Get("path")
	var dirs []map[string]string

	if p == "" {
		// 返回盘符列表（Windows）
		for _, d := range "ABCDEFGHIJKLMNOPQRSTUVWXYZ" {
			root := string(d) + ":\\"
			if st, err := os.Stat(root); err == nil && st.IsDir() {
				dirs = append(dirs, map[string]string{"name": root, "path": root})
			}
		}
	} else {
		abs, err := filepath.Abs(filepath.FromSlash(p))
		if err != nil {
			errJSON(w, 400, "路径无效")
			return
		}
		entries, err := os.ReadDir(abs)
		if err != nil {
			errJSON(w, 404, "目录不可读: "+err.Error())
			return
		}
		// 返回父目录入口
		dirs = append(dirs, map[string]string{"name": "..", "path": filepath.Dir(abs)})
		for _, e := range entries {
			if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
				child := filepath.Join(abs, e.Name())
				dirs = append(dirs, map[string]string{"name": e.Name(), "path": child})
			}
		}
	}
	writeJSON(w, 200, map[string]interface{}{"dirs": dirs})
}

func handleDir(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		errJSON(w, 405, "method not allowed")
		return
	}
	cfg := loadConfig()
	rel := r.URL.Query().Get("path")
	if rel == "" {
		errJSON(w, 400, "缺少 path 参数")
		return
	}
	full, err := safePath(cfg.Root, rel)
	if err != nil {
		errJSON(w, 400, err.Error())
		return
	}
	if err := os.MkdirAll(full, 0755); err != nil {
		errJSON(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]interface{}{"ok": true, "path": rel})
}

func handleRename(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		errJSON(w, 405, "method not allowed")
		return
	}
	cfg := loadConfig()
	body, err := readBody(r)
	if err != nil {
		errJSON(w, 400, err.Error())
		return
	}
	var req struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		errJSON(w, 400, "参数错误")
		return
	}
	fromAbs, err := safePath(cfg.Root, req.From)
	if err != nil {
		errJSON(w, 400, err.Error())
		return
	}
	toAbs, err := safePath(cfg.Root, req.To)
	if err != nil {
		errJSON(w, 400, err.Error())
		return
	}
	if err := os.MkdirAll(filepath.Dir(toAbs), 0755); err != nil {
		errJSON(w, 500, err.Error())
		return
	}
	if err := os.Rename(fromAbs, toAbs); err != nil {
		errJSON(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]interface{}{"ok": true, "to": req.To})
}

// handleCopy 复制一个文件或文件夹到目标目录。
// 参数：path=源相对路径，to=目标目录相对路径（空=根目录）。
func handleCopy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		errJSON(w, 405, "method not allowed")
		return
	}
	cfg := loadConfig()
	src := r.URL.Query().Get("path")
	to := r.URL.Query().Get("to")
	if src == "" {
		errJSON(w, 400, "缺少 path 参数")
		return
	}
	srcAbs, err := safePath(cfg.Root, src)
	if err != nil {
		errJSON(w, 400, err.Error())
		return
	}
	dstAbs, err := safePath(cfg.Root, to)
	if err != nil {
		errJSON(w, 400, err.Error())
		return
	}
	// 不允许把目录复制到自身内部
	if strings.HasPrefix(dstAbs, srcAbs+string(filepath.Separator)) {
		errJSON(w, 400, "不能复制到自身内部")
		return
	}
	newPath, err := copyPath(cfg, srcAbs, dstAbs)
	if err != nil {
		errJSON(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]interface{}{"ok": true, "path": newPath})
}

// copyPath 把 srcAbs 复制到 dstDir 目录下；若目标已存在同名项则自动改名「xxx 副本」「xxx 副本2」。
// 返回目标相对根目录的路径（正斜杠）。
func copyPath(cfg Config, srcAbs, dstDir string) (string, error) {
	st, err := os.Stat(srcAbs)
	if err != nil {
		return "", err
	}
	base := filepath.Base(srcAbs)
	target := filepath.Join(dstDir, base)
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return "", err
	}
	// 同名冲突：文件名加「副本」；阅读器只支持 .md，扩展名分离处理
	if _, err := os.Stat(target); err == nil {
		ext := filepath.Ext(base)
		stem := strings.TrimSuffix(base, ext)
		for i := 2; ; i++ {
			var cand string
			if i == 2 {
				cand = stem + " 副本" + ext
			} else {
				cand = stem + " 副本" + fmt.Sprint(i) + ext
			}
			p := filepath.Join(dstDir, cand)
			if _, err := os.Stat(p); err != nil {
				target = p
				break
			}
		}
	}
	if st.IsDir() {
		if err := copyDir(srcAbs, target); err != nil {
			return "", err
		}
	} else {
		if err := copyFile(srcAbs, target); err != nil {
			return "", err
		}
	}
	rel, err := filepath.Rel(cfg.Root, target)
	if err != nil {
		return "", err
	}
	return filepath.ToSlash(rel), nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}

func copyDir(src, dst string) error {
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dst, 0755); err != nil {
		return err
	}
	for _, e := range entries {
		s := filepath.Join(src, e.Name())
		d := filepath.Join(dst, e.Name())
		if e.IsDir() {
			if err := copyDir(s, d); err != nil {
				return err
			}
		} else {
			if err := copyFile(s, d); err != nil {
				return err
			}
		}
	}
	return nil
}

// handleReveal 在系统文件管理器中打开某个目录（或选中某文件）。
func handleReveal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		errJSON(w, 405, "method not allowed")
		return
	}
	cfg := loadConfig()
	p := r.URL.Query().Get("path")
	if p == "" { // 空 = 根目录
		if cfg.Root == "" {
			errJSON(w, 400, "尚未设置根目录")
			return
		}
		p = cfg.Root
	}
	full, err := resolvePath(cfg, p)
	if err != nil {
		errJSON(w, 400, err.Error())
		return
	}
	st, err := os.Stat(full)
	if err != nil {
		errJSON(w, 404, "路径不存在")
		return
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		if st.IsDir() {
			cmd = exec.Command("explorer", full)
		} else {
			cmd = exec.Command("explorer", "/select,"+full)
		}
	case "darwin":
		if st.IsDir() {
			cmd = exec.Command("open", full)
		} else {
			cmd = exec.Command("open", "-R", full)
		}
	default:
		cmd = exec.Command("xdg-open", filepath.Dir(full))
	}
	if err := cmd.Start(); err != nil {
		errJSON(w, 500, err.Error())
		return
	}
	go cmd.Wait()
	writeJSON(w, 200, map[string]interface{}{"ok": true})
}

// ---------- 静态文件 ----------

func staticHandler(w http.ResponseWriter, r *http.Request) {
	// 禁止缓存，便于开发时改前端立即生效。
	// 同时显式压掉 http.ServeFile 自带的 ETag / Last-Modified：否则浏览器仍会发条件请求
	// 走 304，首屏样式可能晚到一帧，dark 主题出现白底闪烁。
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Del("ETag")
	w.Header().Del("Last-Modified")
	http.ServeFile(w, r, filepath.Join(".", filepath.FromSlash(strings.TrimPrefix(r.URL.Path, "/"))))
}

// ---------- vendor 自愈（本地缺失则从 CDN 下载） ----------

// vendorFile 描述 vendor/katex 下一个需要存在的文件及其下载路径。
type vendorFile struct {
	rel string // 相对 baseDir 的路径，如 "vendor/katex/katex.min.css"
	urls []string // 多源依次尝试的完整 URL
}

// vendorFiles 是需要自愈的前端依赖清单（版本锁定 KaTeX 0.16.11 / Mermaid 11.4.1 / PDF.js 3.11.174）。
var vendorFiles = []vendorFile{
	{
		rel: "vendor/katex/katex.min.css",
		urls: []string{
			"https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css",
			"https://cdn.staticfile.org/KaTeX/0.16.11/katex.min.css",
		},
	},
	{
		rel: "vendor/katex/katex.min.js",
		urls: []string{
			"https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js",
			"https://cdn.staticfile.org/KaTeX/0.16.11/katex.min.js",
		},
	},
	{
		rel: "vendor/katex/auto-render.min.js",
		urls: []string{
			"https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js",
			"https://cdn.staticfile.org/KaTeX/0.16.11/contrib/auto-render.min.js",
		},
	},
	{
		rel: "vendor/mermaid/mermaid.min.js",
		urls: []string{
			"https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js",
			"https://unpkg.com/mermaid@11.4.1/dist/mermaid.min.js",
		},
	},
	{
		rel: "vendor/pdfjs/pdf.min.js",
		urls: []string{
			"https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js",
			"https://registry.npmmirror.com/pdfjs-dist/3.11.174/files/build/pdf.min.js",
			"https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js",
		},
	},
	{
		rel: "vendor/pdfjs/pdf.worker.min.js",
		urls: []string{
			"https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js",
			"https://registry.npmmirror.com/pdfjs-dist/3.11.174/files/build/pdf.worker.min.js",
			"https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js",
		},
	},
}

// httpGet 下载单个 URL 到目标文件；成功返回 true。仅用于启动期自愈，超时 30 秒。
func httpGetToFile(rawURL, dst string) bool {
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Get(rawURL)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return false
	}
	tmp := dst + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return false
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		os.Remove(tmp)
		return false
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return false
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return false
	}
	return true
}

// ensureVendor 检查本地 vendor 依赖是否齐全，缺失则从多源 CDN 依次下载。
// 依据用户设定：下载失败仅打印警告并继续，不阻断服务启动。
func ensureVendor(baseDir string) {
	for _, vf := range vendorFiles {
		dst := filepath.Join(baseDir, filepath.FromSlash(vf.rel))
		if _, err := os.Stat(dst); err == nil {
			continue // 已存在，跳过
		}
		downloaded := false
		for _, u := range vf.urls {
			// 下载前先做简单校验，避免明显非法的 URL 造成无谓等待
			if _, err := url.ParseRequestURI(u); err != nil {
				continue
			}
			fmt.Printf("  下载依赖: %s\n", filepath.Base(dst))
			if httpGetToFile(u, dst) {
				downloaded = true
				fmt.Printf("  已完成:   %s\n", dst)
				break
			}
		}
		if !downloaded {
			fmt.Printf("  [警告] 依赖下载失败，对应前端功能不可用: %s\n", dst)
		}
	}
}

// ---------- 打开浏览器 ----------

// openBrowser 用系统默认浏览器打开 url。
// Windows 用 rundll32（start 是 cmd 内建命令，不能直接 exec）。
func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		fmt.Println("请在浏览器打开:", url)
		return
	}
	go cmd.Wait()
}

// ---------- main ----------

func realMain() {
	exePath, _ := os.Executable()
	baseDir := filepath.Dir(exePath)
	// 若从源码目录运行（go run），exe 在临时目录，改用当前工作目录
	if _, err := os.Stat(filepath.Join(baseDir, "index.html")); err != nil {
		if wd, err2 := os.Getwd(); err2 == nil {
			baseDir = wd
		}
	}
	if err := os.Chdir(baseDir); err != nil {
		log.Printf("警告：切换工作目录失败: %v", err)
	}
	configPath = filepath.Join(baseDir, "config.json")

	// 启动自愈：本地缺失 vendor/katex 时从 CDN 补齐（失败仅警告，不阻断启动）
	ensureVendor(baseDir)

	port := defaultPort
	if p := os.Getenv("MD_READER_PORT"); p != "" {
		port = p
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/config", handleConfig)
	mux.HandleFunc("/api/tree", handleTree)
	mux.HandleFunc("/api/external", handleExternal)
	mux.HandleFunc("/api/extgroup", handleExtGroup)
	mux.HandleFunc("/api/extgroup/member", handleExtGroupMember)
	mux.HandleFunc("/api/star", handleStar)
	mux.HandleFunc("/api/star/name", handleStarName)
	mux.HandleFunc("/api/file", handleFile)
	mux.HandleFunc("/api/dir", handleDir)
	mux.HandleFunc("/api/browse", handleBrowse)
	mux.HandleFunc("/api/rename", handleRename)
	mux.HandleFunc("/api/copy", handleCopy)
	mux.HandleFunc("/api/reveal", handleReveal)
	mux.HandleFunc("/", staticHandler)

	addr := "127.0.0.1:" + port
	url := "http://" + addr + "/"

	// 端口已被占用：说明服务已在运行 —— 只打开浏览器，不重复启动
	if ln, err := net.Listen("tcp", addr); err != nil {
		fmt.Println("服务已在运行，正在打开浏览器:", url)
		openBrowser(url)
		time.Sleep(400 * time.Millisecond)
		return
	} else {
		ln.Close()
	}

	cfg := loadConfig()
	fmt.Println("===============================================")
	fmt.Println("  MD 阅读器")
	fmt.Printf("  数据目录: %s\n", cfg.Root)
	fmt.Printf("  访问地址: %s\n", url)
	fmt.Println("  关闭本窗口即可停止服务")
	fmt.Println("===============================================")

	// 自动打开浏览器（MD_READER_NO_BROWSER=1 时不打开，由 start.bat 负责）
	if os.Getenv("MD_READER_NO_BROWSER") != "1" {
		go func() {
			time.Sleep(400 * time.Millisecond)
			openBrowser(url)
		}()
	}

	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
func main() {
	realMain()
}
