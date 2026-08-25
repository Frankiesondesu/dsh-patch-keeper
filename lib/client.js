window.__ModuleLoader__.load({
	id: "dsh-patch-keeper",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region src/client/panel.js — 补丁包管家 GUI（settings.section 设置分区）
		var React = require('react');

		const inject = ["slots"];
		const API = "/patch-keeper/api";

		function el(tag, cls, text) {
			const e = document.createElement(tag);
			if (cls) e.className = cls;
			if (text !== void 0) e.textContent = text;
			return e;
		}
		function fetchJson(path, init) {
			return fetch(API + path, { headers: { "content-type": "application/json" }, ...init }).then((r) => r.json());
		}
		function pad2(n) { return String(n).padStart(2, "0"); }
		function fmtTime(iso) {
			if (!iso) return "";
			try {
				const d = new Date(iso);
				return (d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
			} catch (e) { return String(iso); }
		}
		function upStr(up) {
			if (!up) return "无远程上游";
			return up.type === "github" ? ("github " + up.owner + "/" + up.repo) : ("npm " + up.package);
		}
		function kindLabel(kind) {
			return ({ init: "注册项目", extract: "提取补丁", check: "检查更新", merge: "合并到新版", finalize: "完成合并", apply: "生成成品" })[kind] || kind;
		}

		const CSS = `
.pk-root{font-family:-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.6;color:var(--theme-text,#ddd);padding:16px 18px;max-width:860px;margin:0 auto}
.pk-root h3{margin:0;font-size:15px}
.pk-sub{color:var(--theme-text-secondary,#999);font-size:11px;margin-top:2px}
.pk-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}
.pk-headbtns{display:flex;gap:6px;flex-shrink:0}
.pk-btn{background:var(--theme-accent,#4a9eff);color:#fff;border:none;border-radius:6px;padding:5px 11px;cursor:pointer;font-size:12px;white-space:nowrap}
.pk-btn:hover{filter:brightness(1.1)}
.pk-btn.ghost{background:transparent;border:1px solid var(--theme-border,#444);color:var(--theme-text,#ccc)}
.pk-btn.danger{background:transparent;border:1px solid #d33;color:#d33}
.pk-btn.mini{padding:3px 8px;font-size:11px}
.pk-btn:disabled{opacity:.45;cursor:not-allowed;filter:none}
.pk-stats{color:var(--theme-text-secondary,#999);font-size:12px;margin-bottom:10px}
.pk-stats b{color:var(--theme-text,#ddd)}
.pk-stats .warn{color:#f1c40f;font-weight:600}
.pk-jobline{font-size:12px;padding:6px 10px;border-radius:6px;background:rgba(74,158,255,.08);border:1px solid var(--theme-border,#333);margin-bottom:8px}
.pk-msg{margin:8px 0;padding:8px 10px;border-radius:6px;background:var(--theme-input-bg,#111);border:1px solid var(--theme-border,#333);white-space:pre-wrap;max-height:200px;overflow:auto;font-size:12px}
.pk-msg.err{border-color:#d33;color:#ff9c9c}
.pk-init,.pk-notifs,.pk-logs{border:1px solid var(--theme-border,#333);border-radius:8px;padding:8px 12px;margin-bottom:12px}
.pk-init summary,.pk-notifs summary,.pk-logs summary{cursor:pointer;color:var(--theme-text-secondary,#aaa);font-size:12px;user-select:none}
.pk-grid{display:grid;grid-template-columns:110px 1fr;gap:6px 8px;margin-top:8px;align-items:center}
.pk-grid label{color:var(--theme-text-secondary,#999);font-size:12px;text-align:right}
.pk-input{background:var(--theme-input-bg,#111);color:var(--theme-text,#ddd);border:1px solid var(--theme-border,#333);border-radius:6px;padding:5px 8px;font-size:12px;width:100%;box-sizing:border-box}
.pk-sectitle{color:var(--theme-text-secondary,#999);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin:14px 0 8px}
.pk-card{border:1px solid var(--theme-border,#333);border-radius:10px;padding:10px 12px;margin-bottom:10px}
.pk-row1{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.pk-name{font-weight:700;font-size:13.5px}
.pk-id{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:var(--theme-text-secondary,#888)}
.pk-badge{margin-left:auto;font-size:10px;padding:2px 8px;border-radius:10px;flex-shrink:0}
.pk-badge.ok{background:rgba(46,204,113,.15);color:#2ecc71}
.pk-badge.warn{background:rgba(241,196,15,.15);color:#f1c40f}
.pk-badge.idle{background:rgba(150,150,150,.15);color:#999}
.pk-badge.err{background:rgba(221,51,51,.15);color:#ff7070}
.pk-meta{color:var(--theme-text-secondary,#999);font-size:11.5px;display:flex;flex-wrap:wrap;gap:2px 14px;margin-bottom:7px}
.pk-meta b{color:var(--theme-text,#ccc);font-weight:600}
.pk-dir{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:var(--theme-text-secondary,#777);word-break:break-all;margin-bottom:7px}
.pk-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.pk-applyrow,.pk-finalrow{display:flex;gap:6px;margin-top:8px;align-items:center;flex-wrap:wrap}
.pk-applyrow .pk-input,.pk-finalrow .pk-input{width:auto;min-width:220px;flex:1}
.pk-hint{color:var(--theme-text-secondary,#888);font-size:11px;margin-top:8px;line-height:1.5}
.pk-conflict{border:1px solid rgba(241,196,15,.35);border-radius:8px;padding:8px 10px;margin-top:8px}
.pk-conflict .path{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:#f1c40f;font-weight:600}
.pk-conflict .reason{color:var(--theme-text-secondary,#999);font-size:11px;margin:2px 0 4px}
.pk-pre{font-family:ui-monospace,Consolas,monospace;font-size:11px;background:var(--theme-input-bg,#111);border:1px solid var(--theme-border,#2a2a2a);border-radius:6px;padding:7px 9px;overflow:auto;max-height:220px;margin:4px 0;white-space:pre;color:var(--theme-text,#ccc)}
.pk-pre .cap{color:var(--theme-text-secondary,#888)}
.pk-applied{color:#2ecc71;font-size:11.5px;margin-top:6px}
.pk-notifitem{padding:5px 0;border-bottom:1px dashed var(--theme-border,#2a2a2a);font-size:11.5px;color:var(--theme-text-secondary,#bbb)}
.pk-notifitem:last-child{border-bottom:none}
.pk-notifitem b{color:var(--theme-text,#ddd)}
.pk-empty{color:var(--theme-text-secondary,#888);font-size:12px;padding:18px;text-align:center;border:1.5px dashed var(--theme-border,#333);border-radius:10px;margin-bottom:10px}
`;

		function apply(ctx) {
			const slots = ctx.slots;
			ctx.effect(() => slots.inject("settings.section", () => slots.register(
				{ name: "settings.section", id: "patch-keeper", order: 55, label: () => "补丁包" },
				function PatchKeeperPanel() {
					const ref = React.useRef(null);
					React.useEffect(() => {
						const container = ref.current;
						if (!container) return;

						// ── 面板状态 ──
						const S = {
							projects: [], pending: 0,
							jobs: [], prevBusy: false, firstJobsPoll: true, consumed: {},
							notifs: [],
							merges: {},        // pid -> 合并结果（含冲突详情）
							mergeHintShown: {},
							applyOpen: {},     // pid -> bool（展开"生成成品"行）
							removeArmed: {},   // pid -> bool（移除二次确认）
							draft: {},         // pid -> {resolvedDir,targetDir,version}
							initDraft: { name: "", modifiedDir: "", officialDir: "", upstream: "", ignore: "" },
							lastFinished: null,
						};
						const draftOf = (pid) => (S.draft[pid] = S.draft[pid] || { resolvedDir: "", targetDir: "", version: "" });

						// ── 骨架 ──
						const style = el("style"); style.textContent = CSS;
						const page = el("div", "pk-root");

						const titleBox = el("div");
						titleBox.append(el("h3", void 0, "🩹 补丁包管家"), el("div", "pk-sub", "第三方项目自定义修改的补丁管理 —— 官方更新检测 · AI 合并冲突 · 一键产出成品"));
						const headBtns = el("div", "pk-headbtns");
						const btnRefresh = el("button", "pk-btn ghost", "刷新");
						const btnCheckAll = el("button", "pk-btn", "检查全部更新");
						headBtns.append(btnRefresh, btnCheckAll);
						const head = el("div", "pk-head");
						head.append(titleBox, headBtns);

						const statsLine = el("div", "pk-stats");
						const jobLine = el("div", "pk-jobline"); jobLine.style.display = "none";
						const msg = el("div", "pk-msg"); msg.style.display = "none";

						// 注册新项目
						const initBox = el("details", "pk-init");
						initBox.append(el("summary", void 0, "＋ 注册新项目"));
						const grid = el("div", "pk-grid");
						const mkField = (labelText, key, placeholder) => {
							const lb = el("label", void 0, labelText);
							const input = el("input", "pk-input");
							input.placeholder = placeholder || "";
							input.value = S.initDraft[key];
							input.addEventListener("input", () => { S.initDraft[key] = input.value; });
							grid.append(lb, input);
							return input;
						};
						mkField("项目标识 *", "name", "如 wechatmsg");
						mkField("修改目录 *", "modifiedDir", "你改过的项目目录绝对路径");
						mkField("官方基线目录", "officialDir", "可选：官方原版目录（填了则立即提取补丁）");
						mkField("上游", "upstream", '可选：github:owner/repo 或 npm:包名（留空自动探测）');
						mkField("忽略", "ignore", "可选：逗号分隔的相对路径");
						const initRow = el("div", "pk-actions"); initRow.style.marginTop = "8px";
						initRow.style.justifyContent = "flex-end";
						const btnInit = el("button", "pk-btn", "注册项目");
						btnInit.dataset.act = "1";
						initRow.append(btnInit);
						initBox.append(grid, initRow);

						const projTitle = el("div", "pk-sectitle", "受维护项目");
						const projList = el("div");

						// 更新提醒
						const notifBox = el("details", "pk-notifs");
						const notifSummary = el("summary", void 0, "🔔 更新提醒");
						const notifInner = el("div");
						const notifFoot = el("div", "pk-actions"); notifFoot.style.marginTop = "6px"; notifFoot.style.justifyContent = "flex-end";
						const btnClearNotifs = el("button", "pk-btn ghost mini", "清空提醒");
						btnClearNotifs.dataset.act = "1";
						notifFoot.append(btnClearNotifs);
						notifBox.append(notifSummary, notifInner, notifFoot);

						// 运行日志
						const logBox = el("details", "pk-logs");
						logBox.append(el("summary", void 0, "📜 运行日志"));
						const logPre = el("pre", "pk-pre", "（打开时加载最近 60 行）");
						const logFoot = el("div", "pk-actions"); logFoot.style.marginTop = "6px"; logFoot.style.justifyContent = "flex-end";
						const btnLogRefresh = el("button", "pk-btn ghost mini", "刷新日志");
						logFoot.append(btnLogRefresh);
						logBox.append(logPre, logFoot);

						page.append(style, head, statsLine, jobLine, msg, initBox, projTitle, projList, notifBox, logBox);
						container.appendChild(page);

						const say = (text, isErr) => {
							msg.textContent = text || "";
							msg.style.display = text ? "block" : "none";
							msg.classList.toggle("err", Boolean(isErr));
						};
						const setBusyUI = (busy) => {
							page.querySelectorAll("button[data-act]").forEach((b) => { b.disabled = Boolean(busy); });
						};

						// ── 渲染 ──
						function renderStats() {
							statsLine.textContent = "";
							statsLine.append("共 ", el("b", void 0, String(S.projects.length)), " 个项目");
							if (S.pending > 0) statsLine.append(" · ", el("span", "warn", S.pending + " 个待更新补丁包"));
							else if (S.projects.length) statsLine.append(" · 全部最新 ✓");
							statsLine.append(el("span", void 0, "　守护循环每 6 小时自动检查一次"));
						}
						function renderJobLine() {
							const active = S.jobs.filter((j) => j.status === "queued" || j.status === "running");
							jobLine.style.display = active.length ? "block" : "none";
							if (active.length) {
								jobLine.textContent = "";
								for (const j of active) jobLine.append(el("span", void 0, "⏳ [" + kindLabel(j.kind) + "] " + (j.name === "*" ? "全部项目" : j.name) + " — " + (j.status === "queued" ? "排队中" : "执行中") + "（长操作可能需要数分钟）"), el("br"));
							}
						}
						function badgeFor(p) {
							if (p.updateAvailable) return el("span", "pk-badge warn", "⚠️ 有更新 → " + (p.latestTag || "?"));
							if (!p.upstream) return el("span", "pk-badge idle", "本地项目");
							return el("span", "pk-badge ok", "✓ 最新");
						}
						function cardFor(p) {
							const pid = p.id;
							const draft = draftOf(pid);
							const card = el("div", "pk-card");

							const row1 = el("div", "pk-row1");
							row1.append(el("span", "pk-name", p.name), el("span", "pk-id", "#" + pid), badgeFor(p));
							card.append(row1);

							const meta = el("div", "pk-meta");
							const baseSpan = el("span"); baseSpan.append("基线 ", el("b", void 0, p.baseVersion || "?"), "（" + (p.baseVersionKind || "?") + "）");
							meta.append(baseSpan);
							meta.append(el("span", void 0, "补丁包 "), el("b", void 0, "v" + (p.patchVersion || 0)));
							meta.append(el("span", void 0, upStr(p.upstream)));
							if (p.ignoreCount) meta.append(el("span", void 0, "忽略 " + p.ignoreCount + " 条"));
							if (p.lastCheckAt) meta.append(el("span", void 0, "检查于 " + fmtTime(p.lastCheckAt)));
							card.append(meta);

							card.append(el("div", "pk-dir", p.dir));
							if (p.updateAvailable && p.latestUrl) {
								const link = el("a", "pk-hint", "↗ 查看新版本 " + p.latestTag);
								link.href = p.latestUrl; link.target = "_blank"; link.rel = "noreferrer";
								link.style.color = "#f1c40f";
								card.append(link);
							} else if (p.lastCheckMsg && !p.updateAvailable) {
								card.append(el("div", "pk-hint", p.lastCheckMsg));
							}

							// 操作按钮
							const actions = el("div", "pk-actions");
							const mkBtn = (text, cls, fn) => {
								const b = el("button", cls, text);
								b.dataset.act = "1";
								b.addEventListener("click", () => { say(""); fn(b); });
								return b;
							};
							actions.append(
								mkBtn("检查更新", "pk-btn ghost mini", () => post("/check", { name: pid }, "检查更新")),
								mkBtn("提取补丁", "pk-btn ghost mini", () => post("/extract", { name: pid }, "提取补丁")),
								mkBtn(p.updateAvailable ? "⚡ 合并到新版" : "合并到新版", "pk-btn mini", () => post("/merge", { name: pid }, "合并到新版")),
							);
							const btnApplyToggle = mkBtn("生成成品 ▾", "pk-btn ghost mini", () => {
								S.applyOpen[pid] = !S.applyOpen[pid];
								renderProjects();
							});
							actions.append(btnApplyToggle);
							const btnRemove = mkBtn(S.removeArmed[pid] ? "确认移除？" : "移除", "pk-btn danger mini", (b) => {
								if (!S.removeArmed[pid]) { S.removeArmed[pid] = true; b.textContent = "确认移除？"; setTimeout(() => { S.removeArmed[pid] = false; if (b.isConnected) { b.textContent = "移除"; } }, 4000); return; }
								S.removeArmed[pid] = false;
								post("/remove", { name: pid, confirm: true }, "移除项目").then((d) => { if (d && d.ok) { say("已移除项目 " + pid); refreshProjects(); refreshNotifs(); } });
							});
							actions.append(btnRemove);
							card.append(actions);

							// 生成成品行（展开）
							if (S.applyOpen[pid]) {
								const row = el("div", "pk-applyrow");
								const inTarget = el("input", "pk-input");
								inTarget.placeholder = "输出目录绝对路径（新官方 + 你的修改）";
								inTarget.value = draft.target;
								inTarget.addEventListener("input", () => { draft.target = inTarget.value; });
								const inVer = el("input", "pk-input");
								inVer.placeholder = "版本（默认 latest）";
								inVer.value = draft.version;
								inVer.style.maxWidth = "140px";
								inVer.addEventListener("input", () => { draft.version = inVer.value; });
								const go = el("button", "pk-btn", "开始生成");
								go.dataset.act = "1";
								go.addEventListener("click", () => {
									const t = draft.target.trim();
									if (!t) { say("请先填写输出目录", true); return; }
									post("/apply", { name: pid, targetDir: t, version: draft.version.trim() || undefined }, "生成成品");
								});
								row.append(inTarget, inVer, go);
								card.append(row);
							}

							// 合并结果区（冲突详情 + 完成合并）
							const m = S.merges[pid];
							if (m) {
								const box = el("div");
								box.style.marginTop = "8px";
								box.append(el("div", "pk-hint", (m.stale ? "上一次合并记录（" + fmtTime(m.at) + "）：" : "合并结果：") + "目标 " + (m.newVersion || "latest") + " · 工作区 " + (m.mergeDir || "")));
								if (m.applied && m.applied.length) box.append(el("div", "pk-applied", "✓ 干净应用 " + m.applied.length + " 个文件"));
								const conflicts = m.conflicts || [];
								if (!conflicts.length) {
									box.append(el("div", "pk-hint", "✓ 无冲突 —— 直接点「完成合并」生成新补丁包。"));
								} else {
									box.append(el("div", "pk-hint", "⚠️ " + conflicts.length + " 个文件冲突 —— 让 AI 把每个冲突文件的合并结果写到一个目录（保持项目内相对路径），把目录填到下面再点「完成合并」。（也可以直接把本页工作区路径丢给 AI 处理）"));
									for (const c of conflicts) {
										const cf = el("div", "pk-conflict");
										cf.append(el("div", "path", c.path));
										cf.append(el("div", "reason", "原因: " + (c.reason || "")));
										for (const h of c.hunks || []) {
											const cap = el("div", "reason", "旧补丁 hunk（@ 旧行 " + h.oldStart + "）:");
											const pre = el("pre", "pk-pre", h.hunkText || "");
											cf.append(cap, pre);
										}
										if (c.newFileContext) {
											cf.append(el("div", "reason", "新官方文件对应区域:"));
											cf.append(el("pre", "pk-pre", c.newFileContext));
										}
										box.append(cf);
									}
								}
								const frow = el("div", "pk-finalrow");
								const inRes = el("input", "pk-input");
								inRes.placeholder = conflicts.length ? "AI 写好的冲突解析文件目录（resolvedDir）" : "无冲突可留空";
								inRes.value = draft.resolvedDir;
								inRes.addEventListener("input", () => { draft.resolvedDir = inRes.value; });
								const fin = el("button", "pk-btn", "完成合并（finalize）");
								fin.dataset.act = "1";
								fin.addEventListener("click", () => {
									post("/finalize", { name: pid, resolvedDir: draft.resolvedDir.trim() || undefined }, "完成合并");
								});
								const dismiss = el("button", "pk-btn ghost mini", "收起");
								dismiss.addEventListener("click", () => { delete S.merges[pid]; renderProjects(); });
								frow.append(inRes, fin, dismiss);
								box.append(frow);
								card.append(box);
							}
							return card;
						}
						function renderProjects() {
							projList.textContent = "";
							if (!S.projects.length) {
								projList.append(el("div", "pk-empty", "还没有受维护的项目 —— 展开上方「＋ 注册新项目」，把你魔改过的第三方项目登记进来。"));
								return;
							}
							const sorted = S.projects.slice().sort((a, b) => (b.updateAvailable ? 1 : 0) - (a.updateAvailable ? 1 : 0));
							for (const p of sorted) projList.append(cardFor(p));
						}
						function renderNotifs() {
							notifInner.textContent = "";
							notifSummary.textContent = S.notifs.length ? ("🔔 更新提醒（" + S.notifs.length + "）") : "🔔 更新提醒";
							if (!S.notifs.length) { notifInner.append(el("div", "pk-notifitem", "（暂无）")); return; }
							for (const n of S.notifs.slice().reverse()) {
								const it = el("div", "pk-notifitem");
								it.append("⚠️ ");
								it.append(Object.assign(document.createElement("b"), { textContent: n.project || "?" }));
								it.append(": " + (n.from || "?") + " → " + (n.to || "?") + "（" + fmtTime(n.at) + "）");
								if (n.url) {
									const a = el("a", void 0, " ↗");
									a.href = n.url; a.target = "_blank"; a.rel = "noreferrer"; a.style.color = "#4a9eff";
									it.append(a);
								}
								notifInner.append(it);
							}
						}

						// ── 数据 ──
						function refreshProjects() {
							return fetchJson("/projects").then((d) => {
								if (!d || !d.ok) return;
								S.projects = d.projects || [];
								S.pending = d.pending || 0;
								renderStats();
								renderProjects();
								// 有待更新但本会话还没展示过历史合并记录 → 拉一次 /merge-latest 提示
								for (const p of S.projects) {
									if (p.updateAvailable && !S.mergeHintShown[p.id]) {
										S.mergeHintShown[p.id] = true;
										fetchJson("/merge-latest?name=" + encodeURIComponent(p.id)).then((r) => {
											if (r && r.ok && r.record && r.record.conflicts && r.record.conflicts.length && !S.merges[p.id]) {
												r.record.stale = true;
												S.merges[p.id] = r.record;
												renderProjects();
											}
										}).catch(() => {});
									}
								}
							});
						}
						function refreshNotifs() {
							return fetchJson("/notifications").then((d) => { if (d && d.ok) { S.notifs = d.entries || []; renderNotifs(); } });
						}
						function refreshJobs() {
							return fetchJson("/jobs").then((d) => {
								if (!d || !d.ok) return;
								S.jobs = d.jobs || [];
								for (const j of S.jobs) {
									if ((j.status === "done" || j.status === "error") && !S.consumed[j.id]) {
										if (S.firstJobsPoll) { S.consumed[j.id] = true; continue; } // 首轮只认账不播报
										S.consumed[j.id] = true;
										if (j.status === "error") { say("[" + kindLabel(j.kind) + "/" + j.name + "] 失败: " + j.error, true); continue; }
										consumeResult(j);
									}
								}
								S.firstJobsPoll = false;
								const busy = S.jobs.some((j) => j.status === "queued" || j.status === "running");
								if (S.prevBusy && !busy) { refreshProjects(); refreshNotifs(); }
								S.prevBusy = busy;
								renderJobLine();
								setBusyUI(busy);
							});
						}
						function consumeResult(j) {
							switch (j.kind) {
								case "check": {
									const r = j.result;
									if (Array.isArray(r)) {
										const hits = r.filter((x) => x && x.updateAvailable).length;
										say("检查完成：" + r.length + " 个项目中 " + hits + " 个有官方更新" + (hits ? "（见 ⚠️ 标记，点「合并到新版」开始 AI 合并流程）" : " ✓"));
									} else if (r && r.updateAvailable) say(j.name + ": 官方有新版本 " + r.base + " → " + r.latest + " —— 可执行「合并到新版」");
									else say(j.name + ": " + ((r && r.msg) || "已是最新"));
									break;
								}
								case "extract": {
									const r = j.result || {};
									say("补丁包已重新提取 → v" + r.patchVersion + "（变更 " + r.fileCount + " 个文件，+" + r.addTotal + " / -" + r.delTotal + "）");
									break;
								}
								case "init": {
									const r = j.result || {};
									say("项目已注册: " + (r.project && r.project.id) + (r.patch ? "（初始补丁包 v" + r.patch.patchVersion + " 已生成）" : " —— 记得用「提取补丁」生成首个补丁包"));
									if (S.initDraft.name) { S.initDraft.name = ""; S.initDraft.modifiedDir = ""; S.initDraft.officialDir = ""; }
									break;
								}
								case "merge": {
									const r = j.result || {};
									S.merges[j.name] = r;
									say(r.conflicts && r.conflicts.length
										? "[" + j.name + "] 合并完成：干净应用 " + (r.applied || []).length + " 个文件，⚠️ " + r.conflicts.length + " 个冲突 —— 见卡片下方冲突详情"
										: "[" + j.name + "] 合并完成：全部干净应用 ✓ 点「完成合并」生成新补丁包");
									renderProjects();
									break;
								}
								case "finalize": {
									const r = j.result || {};
									delete S.merges[j.name];
									delete S.mergeHintShown[j.name];
									say("[" + j.name + "] 补丁包已更新到官方 " + r.newVersion + " → 新补丁 v" + r.patchVersion + "（" + r.fileCount + " 文件，+" + r.addTotal + " / -" + r.delTotal + "）✓");
									break;
								}
								case "apply": {
									const r = j.result || {};
									const n = (r.conflicts || []).length;
									say("[" + j.name + "] 成品已生成 → " + r.targetDir + "（应用 " + (r.applied || []).length + " 个文件" + (n ? "，⚠️ " + n + " 个冲突未应用" : "") + "）");
									break;
								}
								default:
									say("[" + kindLabel(j.kind) + "] 完成 ✓");
							}
						}
						function post(path, body, label) {
							return fetchJson(path, { method: "POST", body: JSON.stringify(body || {}) })
								.then((d) => {
									if (!d || !d.ok) say((label || "操作") + "失败: " + ((d && d.error) || JSON.stringify(d)), true);
									else refreshJobs();
									return d;
								})
								.catch((e) => { say((label || "操作") + "请求失败: " + e, true); });
						}
						function refreshLog() {
							return fetchJson("/log?lines=60").then((d) => { if (d && d.ok) logPre.textContent = (d.lines || []).join("\n") || "（空）"; });
						}

						// ── 事件 ──
						btnRefresh.addEventListener("click", () => { say(""); refreshProjects().catch(() => {}); refreshNotifs().catch(() => {}); });
						btnCheckAll.addEventListener("click", () => post("/check", {}, "检查全部更新"));
						btnInit.addEventListener("click", () => {
							const f = S.initDraft;
							if (!f.name.trim() || !f.modifiedDir.trim()) { say("项目标识与修改目录为必填项", true); return; }
							const body = { name: f.name.trim(), modifiedDir: f.modifiedDir.trim() };
							if (f.officialDir.trim()) body.officialDir = f.officialDir.trim();
							if (f.upstream.trim()) body.upstream = f.upstream.trim();
							if (f.ignore.trim()) body.ignore = f.ignore.split(",").map((s) => s.trim()).filter(Boolean);
							post("/init", body, "注册项目");
						});
						btnClearNotifs.addEventListener("click", () => {
							fetchJson("/notifications/clear", { method: "POST", body: "{}" }).then(() => refreshNotifs()).catch(() => {});
						});
						btnLogRefresh.addEventListener("click", () => refreshLog());
						logBox.addEventListener("toggle", () => { if (logBox.open) refreshLog(); });

						// ── 轮询 ──
						const timer = window.setInterval(() => { refreshJobs().catch(() => {}); }, 2000);
						refreshProjects().catch(() => {});
						refreshNotifs().catch(() => {});
						refreshJobs().catch(() => {});

						return () => {
							window.clearInterval(timer);
							try { container.removeChild(page); } catch (e) { /* 忽略 */ }
						};
					}, []);
					return React.createElement("div", { ref: ref });
				}
			)), "patch-keeper: panel");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
