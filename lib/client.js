/**
 * dsh-token-dashboard — client half (Token Ledger style).
 *
 * Layout mirrors a token ledger: Balance card, Token-usage stat cards
 * (Today / This month / All time + requests + cache rate), a grouped share bar
 * with its per-group daily timeline (by model OR by workspace, toggleable), a
 * full-year activity heatmap with month labels, and a Models table
 * (Req / Input / Cache / Output). Uses react/jsx-runtime jsx/jsxs correctly and
 * never puts a raw null inside a children array. Wrapped in an ErrorBoundary.
 */
window.__ModuleLoader__.load({
	id: "@lynnchrysteiin/dsh-token-dashboard",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const { useEffect, useState, useCallback, Component } = React;
		const jsx = require("react/jsx-runtime").jsx;
		const jsxs = require("react/jsx-runtime").jsxs;

		// ---- CSS-ish tokens (follow DSH theme vars) ----
		const CARD = {
			border: "1px solid var(--dsw-alias-border-l1)",
			borderRadius: "12px",
			padding: "16px",
			margin: "12px 0",
			background: "var(--dsw-alias-bg-overlay, transparent)"
		};
		const SEC_TITLE = { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-secondary)", marginBottom: "10px", letterSpacing: "0.02em" };
		const NUM = { fontSize: "26px", fontWeight: 700, color: "var(--dsw-alias-label-primary)", lineHeight: 1.3 };
		const LABEL = { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" };
		const ROW = { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0" };
		const MONO = { fontVariantNumeric: "tabular-nums" };
		// One colour per DeepSeek billing bucket, ordered deliberately as a single
		// blue-to-grey ramp: green/amber/red would read as good/warning/bad, but
		// these three are all normal charges that merely differ in rate.
		const BUCKET = {
			hit: "var(--dsw-alias-label-accent, #4caf50)",
			miss: "#8ab4f8",
			out: "#c58af9"
		};
		// Four aligned columns for every money row: swatch+label, tokens, share,
		// amount. Fixed widths are what stop the numbers from running together.
		const COST_GRID = { display: "grid", gridTemplateColumns: "1fr 88px 44px 74px", gap: "10px", alignItems: "baseline", padding: "5px 0" };
		const COST_R = { textAlign: "right", ...MONO };
		const bucketDot = (color) => jsx("span", { style: { width: "8px", height: "8px", borderRadius: "2px", background: color, flexShrink: "0", display: "inline-block" } });
		const btnStyle = { cursor: "pointer", fontSize: "12px", padding: "4px 10px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.14))", color: "var(--dsw-alias-label-primary)", whiteSpace: "nowrap" };

		function fmt(n) { return (n == null || isNaN(n)) ? "0" : Number(n).toLocaleString(); }
		function fmtMoney(n) { return (n == null || isNaN(n)) ? "0.00" : Number(n).toFixed(2); }
		function pct(v, max) { return max > 0 ? ((v / max) * 100) : 0; }

		// A segmented control ("By model" / "By workspace", window, and metric).
		function Seg({ options, value, onChange }) {
			return jsxs("div", {
				style: { display: "flex", gap: "4px", background: "var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.14))", borderRadius: "8px", padding: "3px" },
				children: options.map((o) => jsx("button", {
					onClick: () => onChange(o.value),
					style: {
						flex: "1 1 auto", minWidth: "0", padding: "5px 14px", fontSize: "12px", borderRadius: "6px", cursor: "pointer",
						border: "none", color: "var(--dsw-alias-label-primary)",
						whiteSpace: "nowrap",
						background: (o.value === value)
							? "var(--dsw-alias-bg-overlay, rgba(255,255,255,.9))"
							: "transparent",
						fontWeight: (o.value === value) ? 600 : 400
					},
					children: o.label
				}, o.value))
			});
		}

		// Color scale for heatmap (green shades like the reference).
		function heatColor(val, max) {
			if (val <= 0) return "var(--dsw-alias-border-l1)";
			const t = max > 0 ? (val / max) : 0;
			const a = 0.25 + 0.75 * t;
			return "rgba(76,175,80," + a.toFixed(2) + ")";
		}

		// ---- smooth-curve SVG line chart over a shared day axis ----
		//
		// One or many series, each a dense array of numbers aligned to `days`.
		// Curves are Catmull-Rom converted to cubic Bezier: a polyline of one
		// segment per day reads as a jagged zigzag, which misrepresents daily
		// totals as instantaneous jumps. Control points are clamped to the plot so
		// the spline cannot overshoot into negative territory (a real risk on
		// sparse-to-dense day boundaries, where a plain Catmull-Rom dips below 0).
		function smoothPath(pts) {
			if (pts.length === 0) return "";
			if (pts.length === 1) return "M" + pts[0][0].toFixed(2) + "," + pts[0][1].toFixed(2);
			if (pts.length === 2) return "M" + pts[0][0].toFixed(2) + "," + pts[0][1].toFixed(2) + "L" + pts[1][0].toFixed(2) + "," + pts[1][1].toFixed(2);
			let d = "M" + pts[0][0].toFixed(2) + "," + pts[0][1].toFixed(2);
			const clampY = (y) => Math.max(PAD_TOP_C, Math.min(PLOT_BOTTOM_C, y));
			for (let i = 0; i < pts.length - 1; i++) {
				const p0 = pts[i - 1] || pts[i];
				const p1 = pts[i];
				const p2 = pts[i + 1];
				const p3 = pts[i + 2] || p2;
				const c1x = p1[0] + (p2[0] - p0[0]) / 6;
				const c1y = clampY(p1[1] + (p2[1] - p0[1]) / 6);
				const c2x = p2[0] - (p3[0] - p1[0]) / 6;
				const c2y = clampY(p2[1] - (p3[1] - p1[1]) / 6);
				d += "C" + c1x.toFixed(2) + "," + c1y.toFixed(2) + " " + c2x.toFixed(2) + "," + c2y.toFixed(2) + " " + p2[0].toFixed(2) + "," + p2[1].toFixed(2);
			}
			return d;
		}
		const CHART_W = 640, CHART_H = 170, PAD_TOP_C = 14, PAD_BOTTOM_C = 26, PAD_LEFT_C = 40, PAD_RIGHT_C = 8;
		const PLOT_BOTTOM_C = CHART_H - PAD_BOTTOM_C;
		function fmtAxis(v, isCost) {
			if (isCost) return "¥" + (v >= 10 ? v.toFixed(0) : v.toFixed(1));
			if (v >= 1000000) return (v / 1000000).toFixed(v >= 10000000 ? 0 : 1) + "M";
			if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + "K";
			return String(Math.round(v));
		}
		function CurveChart({ days, series, metric, fill }) {
			const isCost = metric === "cost";
			if (!days || days.length < 2) {
				return jsx("div", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", padding: "10px 0" }, children: "区间内不足两天数据，无法绘制趋势" });
			}
			const plotW = CHART_W - PAD_LEFT_C - PAD_RIGHT_C;
			const plotH = PLOT_BOTTOM_C - PAD_TOP_C;
			const step = plotW / (days.length - 1);
			const xAt = (i) => PAD_LEFT_C + i * step;
			const visible = series.filter((s) => s && s.values && s.values.length === days.length);
			let max = 0;
			for (const s of visible) for (const v of s.values) if (Number.isFinite(v) && v > max) max = v;
			if (max <= 0) max = 1;
			const yAt = (v) => PAD_TOP_C + plotH - (Math.max(0, v) / max) * plotH;

			const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => {
				const gy = PAD_TOP_C + plotH - f * plotH;
				return jsx("line", { x1: PAD_LEFT_C, x2: PAD_LEFT_C + plotW, y1: gy, y2: gy, stroke: "var(--dsw-alias-border-l1)", strokeWidth: "1", strokeDasharray: f === 0 ? "0" : "2 4", opacity: f === 0 ? 0.9 : 0.7 });
			});
			const yLabels = [0, 0.5, 1].map((f) => {
				const gy = PAD_TOP_C + plotH - f * plotH;
				return jsx("text", { x: PAD_LEFT_C - 5, y: gy + 3, fill: "var(--dsw-alias-label-tertiary)", fontSize: "9", textAnchor: "end", children: fmtAxis(max * f, isCost) });
			});
			// x labels: first, last, and ~4 evenly spaced between them (deduped).
			const marks = new Set([0, days.length - 1]);
			for (let k = 1; k <= 4; k++) marks.add(Math.round((days.length - 1) * k / 5));
			const xLabels = [...marks].sort((a, b) => a - b).map((i) => {
				const lx = xAt(i);
				const ly = CHART_H - PAD_BOTTOM_C + 15;
				return jsxs("g", { children: [
					jsx("rect", { x: lx - 17, y: ly - 9, width: 34, height: 13, rx: 3, fill: "var(--dsw-alias-bg-overlay, #2a2a2a)", opacity: "0.85" }),
					jsx("text", { x: lx, y: ly, fill: "var(--dsw-alias-label-secondary)", fontSize: "9", textAnchor: "middle", children: String(days[i]).slice(5) })
				] }, i);
			});

			const paths = visible.map((s, si) => {
				const pts = s.values.map((v, i) => [xAt(i), yAt(Number(v) || 0)]);
				const line = smoothPath(pts);
				const area = fill && si === 0
					? line + "L" + xAt(days.length - 1).toFixed(2) + "," + (PAD_TOP_C + plotH).toFixed(2) + "L" + PAD_LEFT_C.toFixed(2) + "," + (PAD_TOP_C + plotH).toFixed(2) + "Z"
					: null;
				return jsxs("g", { children: [
					area ? jsx("path", { d: area, fill: "url(#tdfill)", stroke: "none" }) : null,
					jsx("path", { d: line, fill: "none", stroke: s.color, strokeWidth: s.emphasis ? 0.9 : 2, strokeLinejoin: "round", strokeLinecap: "round", opacity: s.emphasis ? 0.35 : 1 })
				] }, "s" + si);
			});

			const legend = visible.length > 1
				? jsx("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px", marginTop: "8px" }, children: visible.map((s, i) =>
					jsxs("div", { style: { display: "flex", alignItems: "center", gap: "5px", fontSize: "11px", color: "var(--dsw-alias-label-secondary)", maxWidth: "100%" }, children: [
						jsx("span", { style: { width: "9px", height: "9px", borderRadius: "2px", background: s.color, flexShrink: "0" } }),
						jsx("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: s.label })
					] }, "L" + i))
				}) : null;

			return jsxs("div", { children: [
				jsxs("svg", { width: "100%", viewBox: "0 0 " + CHART_W + " " + CHART_H, style: { display: "block", width: "100%" }, children: [
					jsx("defs", { children: jsx("linearGradient", { id: "tdfill", x1: "0", y1: "0", x2: "0", y2: "1", children: [
						jsx("stop", { offset: "0%", stopColor: "var(--dsw-alias-label-accent, #4caf50)", stopOpacity: "0.30" }),
						jsx("stop", { offset: "100%", stopColor: "var(--dsw-alias-label-accent, #4caf50)", stopOpacity: "0.02" })
					] }) }),
					gridLines, paths, yLabels, xLabels
				] }),
				legend
			] });
		}

		// A stable color per group entry; the "其他" (other) aggregate is grey so it
		// reads as "everything else", distinct from the named top groups.
		const GROUP_COLORS = ["#4caf50", "#2196f3", "#ff9800", "#9c27b0", "#00bcd4"];
		function groupColor(key, i) {
			if (key === "其他" || key === "other") return "var(--dsw-alias-label-tertiary, #9e9e9e)";
			return GROUP_COLORS[i % GROUP_COLORS.length];
		}

		// ---- export helpers: build a CSV/JSON string from stats and download it.
		function downloadText(filename, text, mime) {
			try {
				const blob = new Blob([text], { type: mime });
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				a.href = url; a.download = filename;
				document.body.appendChild(a); a.click();
				document.body.removeChild(a);
				URL.revokeObjectURL(url);
			} catch (e) { console.error("[token-dashboard] export failed", e); }
		}
		function exportJson(stats) {
			downloadText("dsh-token-dashboard.json", JSON.stringify(stats, null, 2), "application/json");
		}
		function exportCsv(stats, metric) {
			const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
			const rows = [];
			// by-model lines
			rows.push("type,key,req,input,output,cacheRead,cost,total");
			for (const m of Object.keys(stats.byModel || {})) {
				const x = stats.byModel[m];
				rows.push(["model", m, x.req, x.input, x.output, x.cacheRead, (x.cost || 0).toFixed(4), x.total].map(esc).join(","));
			}
			for (const w of Object.keys(stats.byWorkspace || {})) {
				const x = stats.byWorkspace[w];
				rows.push(["workspace", w, x.req, x.input, x.output, x.cacheRead, (x.cost || 0).toFixed(4), x.total].map(esc).join(","));
			}
			for (const d of Object.keys(stats.byDay || {}).sort()) {
				const x = stats.byDay[d];
				rows.push(["day", d, "", "", "", "", (x.cost || 0).toFixed(4), x.total].map(esc).join(","));
			}
			downloadText("dsh-token-dashboard.csv", rows.join("\n"), "text/csv");
		}

		class Boundary extends Component {
			constructor(props) { super(props); this.state = { error: null }; }
			static getDerivedStateFromError(error) { return { error }; }
			componentDidCatch(error, info) { console.error("[token-dashboard] render error:", error, info); }
			render() {
				if (this.state.error) {
					return jsx("div", { style: { color: "var(--dsw-alias-danger, #e5484d)", fontSize: "12px", padding: "8px 0" }, children: "渲染出错：" + String(this.state.error?.message || this.state.error) });
				}
				return jsx("div", { children: this.props.children });
			}
		}

		function TokenDashboardPanel() {
			const [stats, setStats] = useState(null);
			const [balance, setBalance] = useState(null);
			const [error, setError] = useState(null);
			const [loading, setLoading] = useState(true);
			const [balanceLoading, setBalanceLoading] = useState(true);
			const [groupBy, setGroupBy] = useState("model"); // "model" | "workspace"
			const [metric, setMetric] = useState("cost"); // "cost" | "token"
			const [shareMetric, setShareMetric] = useState("total"); // "total" | "cost" for the share bar
			const [hoverIdx, setHoverIdx] = useState(null); // reserved: chart hover
			const [heatHover, setHeatHover] = useState(null); // {key,val,cost,left,top} for the heatmap tooltip
			const [days, setDays] = useState(30); // global window: 7 | 30 (0 = all)

			const loadStats = useCallback(async (winDays) => {
				try {
					const d = winDays || days;
					const res = await fetch("/api/token-dashboard/stats?refresh=1&days=" + d);
					if (!res.ok) throw new Error("stats http " + res.status);
					const data = await res.json();
					if (data && data.status === "computing") { setTimeout(() => loadStats(winDays), 1200); return; }
					setStats((data && typeof data === "object") ? data : {});
					setLoading(false);
				} catch (e2) { setError(String(e2)); setLoading(false); }
			}, [days]);
			const loadBalance = useCallback(async (force) => {
				setBalanceLoading(true);
				try {
					const res = await fetch("/api/token-dashboard/balance" + (force ? "?force=1" : ""));
					if (!res.ok) throw new Error("balance http " + res.status);
					setBalance((await res.json()) || {});
				} catch (e2) { setError(String(e2)); }
				finally { setBalanceLoading(false); }
			}, []);
			useEffect(() => { loadStats(); loadBalance(false); }, [loadStats, loadBalance]);

			if (!loading && stats) {
				// ---- derived ----
				const infos = balance?.data?.balance_infos || [];
				let balInfo = infos.find((x) => x && x.currency === "CNY")
					|| infos.find((x) => x && Number(x.total_balance ?? x.balance) > 0)
					|| infos[0] || balance?.data || null;
				const balValue = balInfo ? (balInfo.total_balance ?? balInfo.balance ?? null) : null;
				const balCur = balInfo ? (balInfo.currency || "") : "";

				const total = Number(stats.total) || 0;
				const req = Number(stats.req) || Number(stats.events) || 0;
				const today = Number(stats.today) || 0;
				const thisMonth = Number(stats.thisMonth) || 0;
				// Cache hit rate must compare cache reads against the INPUT only.
				// Dividing by all tokens (the previous behaviour) mixed output and
				// reported ~99% for a ratio that is a property of the input side.
				const inputSide = Number(stats.cacheRead || 0) + Number(stats.input || 0);
				const cacheRate = inputSide > 0 ? (Number(stats.cacheRead || 0) / inputSide * 100).toFixed(1) : "0.0";
				// Denominator for each bucket's share of total spend.
				const costTotal = Number(stats.cost || 0);

				// grouped share data. Show top TOP_N entries by total, then fold the
				// rest into a single "其他" (other) aggregate so the card never grows
				// unbounded and tiny shares don't get lost in the bar.
				const TOP_N = 8;
				const groups = groupBy === "model" ? stats.byModel : stats.byWorkspace;
				// shareBy = "total" or "cost" — pick the field used for share sorting/percent.
				const shareBy = shareMetric === "cost" ? "cost" : "total";
				const allEntries = Object.keys(groups || {}).map((k) => ({ key: k, ...(typeof groups[k] === "object" ? groups[k] : { total: groups[k], cost: 0 }) }))
					.sort((a, b) => (b[shareBy] || 0) - (a[shareBy] || 0));
				let groupEntries;
				if (allEntries.length > TOP_N) {
					const top = allEntries.slice(0, TOP_N);
					// fold the remainder into a synthetic "其他" entry; keep broken-down
					// counters for the bar/list (we only display total/req, but stay safe).
					const rest = allEntries.slice(TOP_N);
					const other = { key: "其他", req: 0, input: 0, output: 0, cacheRead: 0, reasoning: 0, total: 0, cost: 0 };
					for (const r of rest) {
						other.total += Number(r.total) || 0;
						other.cost += Number(r.cost) || 0;
						other.req += Number(r.req) || 0;
						other.input += Number(r.input) || 0;
						other.output += Number(r.output) || 0;
						other.cacheRead += Number(r.cacheRead) || 0;
						other.reasoning += Number(r.reasoning) || 0;
					}
					groupEntries = [...top, other];
				} else {
					groupEntries = allEntries;
				}
				// Percentages use the SUM of all group values as the denominator, so the
				// bar segments (flex-grow by value) and the printed % agree exactly and
				// both reflect "share of all usage" (by tokens or by cost).
				const groupSum = groupEntries.reduce((s, g) => s + (Number(g[shareBy]) || 0), 0);
				const groupMax = Math.max(...groupEntries.map((g) => (Number(g[shareBy]) || 0)), 1);

				// heatmap: the full-year grid above reads byDay directly; entries are
				// either {total, cost, ...} objects (new) or a bare number (legacy).
				const byDay = stats.byDay || {};
				// The heatmap spans a full year, so it reads the always-complete bucket;
				// the curves read the window-filtered one. Older payloads predate byDayAll.
				const byDayAll = stats.byDayAll || byDay;
				const todayD = new Date();

				// ---- activity heatmap: a full year, GitHub-contribution style ----
				// Exactly 53 columns of 7 days = 371 cells, split into 7 calendar rows
				// (row 0 = Sunday .. row 6 = Saturday). The grid renders column-major, so
				// every cell goes at (row, column). The window is not a multiple of 7, so
				// the edges are padded with blanks rather than shifting every column.
				const HEAT_DAYS = 364, HEAT_COLS = 53, HEAT_CELL = 13, HEAT_GAP = 3, HEAT_STEP = HEAT_CELL + HEAT_GAP;
				const heatStart = new Date(todayD);
				heatStart.setDate(heatStart.getDate() - HEAT_DAYS);
				const heatBlankBefore = heatStart.getDay();
				const heatCells = [];
				for (let i = 0; i < HEAT_DAYS; i++) {
					const d = new Date(heatStart);
					d.setDate(d.getDate() + i);
					const key = d.toISOString().slice(0, 10);
					const rec = byDayAll[key];
					const total = (rec && typeof rec === "object") ? Number(rec.total) || 0 : Number(rec) || 0;
					const cost = (rec && typeof rec === "object") ? Number(rec.cost) || 0 : 0;
					heatCells.push({ key, val: total, cost });
				}
				const heatMax = Math.max(1, ...heatCells.map((c) => c.val));
				// 371 slots hold the leading pad, the 364 real days, and the trailing pad.
				const heatSlots = [];
				for (let i = 0; i < HEAT_COLS * 7; i++) {
					const di = i - heatBlankBefore;
					heatSlots.push((di >= 0 && di < heatCells.length) ? heatCells[di] : null);
				}
				// Month labels sit under the column holding each month's 1st, offset by the
				// fraction of a week that date sits into its column, so a label is centred
				// on the 1st rather than on the column start.
				const heatMonths = [];
				for (let i = 0; i < heatCells.length; i++) {
					if (heatCells[i].key.slice(8) !== "01") continue;
					const slot = i + heatBlankBefore;
					const col = Math.floor(slot / 7);
					const row = slot % 7;
					const px = col * HEAT_STEP + (row / 7) * HEAT_STEP + (HEAT_CELL / 2);
					heatMonths.push({ label: Number(heatCells[i].key.slice(5, 7)) + "月", px });
				}
				// Left gutter carries weekday labels, so the grid itself is untouched.
				const weekdayLabels = ["日", "一", "二", "三", "四", "五", "六"];
				// Instant tooltip. The native `title` attribute waits roughly a second
				// before it appears, which reads as "hover does nothing" on a dense grid,
				// so the cell reports its own viewport position and React draws the box
				// immediately. Placement flips below the cell when there is no room above
				// and clamps to the viewport edges.
				const heatTip = (c, ev) => {
					if (!c || !ev || !ev.currentTarget) return;
					const r = ev.currentTarget.getBoundingClientRect();
					const w = 176, h = 52;
					const vw = (typeof window !== "undefined" && window.innerWidth) || 1200;
					const vh = (typeof window !== "undefined" && window.innerHeight) || 800;
					let left = Math.max(4, Math.min(vw - w - 4, r.left + r.width / 2 - w / 2));
					let top = r.top - h - 8;
					if (top < 4) top = r.bottom + 8;
					setHeatHover({ key: c.key, val: c.val, cost: c.cost, left, top });
				};
				const heatTipBox = heatHover ? jsxs("div", {
					style: {
						position: "fixed", left: heatHover.left + "px", top: heatHover.top + "px", zIndex: 9999,
						pointerEvents: "none", width: "176px", padding: "6px 8px", borderRadius: "6px",
						background: "var(--dsw-alias-bg-overlay, #2a2a2a)", border: "1px solid var(--dsw-alias-border-l2)",
						boxShadow: "0 4px 14px rgba(0,0,0,.35)", fontSize: "11px", lineHeight: "1.5"
					},
					children: [
						jsx("div", { style: { color: "var(--dsw-alias-label-primary)", fontWeight: 600 }, children: heatHover.key }),
						jsx("div", { style: { color: "var(--dsw-alias-label-secondary)", ...MONO }, children: fmt(heatHover.val) + " tokens" }),
						jsx("div", { style: { color: "var(--dsw-alias-label-secondary)", ...MONO }, children: "¥" + fmtMoney(heatHover.cost) })
					]
				}) : null;
				const heatChart = jsxs("div", { children: [
					jsxs("div", { style: { display: "flex", gap: "6px", alignItems: "flex-start" }, children: [
						jsx("div", { style: { display: "grid", gridTemplateRows: "repeat(7, " + HEAT_CELL + "px)", gap: HEAT_GAP + "px", flexShrink: "0" }, children: weekdayLabels.map((w, i) =>
							jsx("div", { style: { height: HEAT_CELL + "px", lineHeight: HEAT_CELL + "px", fontSize: "9px", color: "var(--dsw-alias-label-tertiary)", textAlign: "right", paddingRight: "2px" }, children: i % 2 === 1 ? w : "" }, "wd" + i)
						) }),
						jsx("div", { style: { overflowX: "auto", flex: "1 1 auto", minWidth: "0", paddingBottom: "2px" }, children: jsxs("div", { style: { display: "inline-block", paddingLeft: HEAT_STEP + "px" }, children: [
							jsx("div", { style: { display: "grid", gridAutoFlow: "column", gridTemplateRows: "repeat(7, " + HEAT_CELL + "px)", gridAutoColumns: HEAT_CELL + "px", gap: HEAT_GAP + "px" }, children: heatSlots.map((c, i) =>
								c === null
									? jsx("div", { style: { width: HEAT_CELL + "px", height: HEAT_CELL + "px" } }, "e" + i)
									: jsx("div", {
										style: { width: HEAT_CELL + "px", height: HEAT_CELL + "px", borderRadius: "3px", background: heatColor(c.val, heatMax), cursor: "default" },
										title: c.key + "　" + fmt(c.val) + " tokens　¥" + fmtMoney(c.cost),
										onMouseEnter: (ev) => heatTip(c, ev),
										onMouseLeave: () => setHeatHover(null)
									}, c.key)
							) }),
							jsx("div", { style: { position: "relative", height: "13px", marginTop: "3px" }, children: heatMonths.map((m, i) =>
								jsx("span", { style: { position: "absolute", left: m.px + "px", transform: "translateX(-50%)", fontSize: "9px", color: "var(--dsw-alias-label-tertiary)", whiteSpace: "nowrap" }, children: m.label }, "m" + i)
							) })
						] }) })
					] }),
					heatTipBox,
					jsxs("div", { style: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "4px", marginTop: "8px", fontSize: "10px", color: "var(--dsw-alias-label-tertiary)" }, children: [
						jsx("span", { children: "少" }),
						[0, 0.25, 0.5, 0.75, 1].map((f, i) => jsx("div", { style: { width: "10px", height: "10px", borderRadius: "2px", background: heatColor(f * heatMax, heatMax) } }, "lg" + i)),
						jsx("span", { children: "多" })
					] })
				] });

				// ---- timeline data: dense day axis over the global window ----
				// The x axis is every calendar day in the window (not only the days that
				// have data), so a gap renders as the curve returning to zero instead of
				// silently compressing the axis.
				const dayKeys = [];
				for (let i = days - 1; i >= 0; i--) {
					const d = new Date(todayD); d.setDate(d.getDate() - i);
					dayKeys.push(d.toISOString().slice(0, 10));
				}

				// models table rows
				const modelRows = Object.keys(stats.byModel || {})
					.map((m) => ({ key: m, ...stats.byModel[m] }))
					.sort((a, b) => b.total - a.total);

				// recent sessions: sort by last activity, take newest N
				const sessionRows = Object.keys(stats.bySession || {})
					.map((id) => ({ key: id, ...stats.bySession[id] }))
					.sort((a, b) => (b.last || 0) - (a.last || 0))
					.slice(0, 12);
				function fmtDate(ts) {
					if (!ts) return "-";
					const d = new Date(ts);
					const pad = (n) => String(n).padStart(2, "0");
					return (d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
				}

				// ---- render ----
				const balanceInner = balanceLoading ? jsx("div", { style: { color: "var(--dsw-alias-label-secondary)" }, children: "加载中…" })
					: (balance && balance.status === "ok")
						? jsxs("div", { children: [
							jsxs("div", { style: { display: "flex", alignItems: "baseline", gap: "6px" }, children: [
								jsx("span", { style: { ...NUM, ...MONO }, children: (balCur === "CNY" ? "¥" : "$") + fmtMoney(balValue) }),
								jsx("span", { style: LABEL, children: balCur })
							] }),
							jsxs("div", { style: { marginTop: "8px" }, children: [
								jsx("button", { onClick: () => loadBalance(true), style: { cursor: "pointer", fontSize: "12px", padding: "4px 10px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l1)", background: "transparent", color: "var(--dsw-alias-label-primary)" }, children: "强制刷新" }),
								balance.cached ? jsx("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", marginLeft: "8px" }, children: "缓存" }) : null
							] })
						] })
						: jsx("div", { style: { color: "var(--dsw-alias-label-secondary)" }, children: (balance?.message || "未配置或不可用") });

				const statCards = [
					{ label: "今日", val: today },
					{ label: "本月", val: thisMonth },
					{ label: "总计", val: total }
				];
				const statBar = jsxs("div", { style: { display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "10px" }, children: statCards.map((s) =>
					jsxs("div", { style: { background: "var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.08))", borderRadius: "10px", padding: "12px" }, children: [
						jsx("div", { style: LABEL, children: s.label }),
						jsx("div", { style: { ...NUM, ...MONO, fontSize: "22px" }, children: fmt(s.val) })
					] }, s.label)
				) });

				// Per-group daily curves for the distribution card: one smooth curve per
				// ranked group over the window's day axis, so the share bar (who) and the
				// timeline (when) read against one consistent x axis.
				const distSeries = groupEntries.map((g, i) => ({
					label: g.key,
					color: groupColor(g.key, i),
					values: dayKeys.map((k) => {
						const rec = byDay[k];
						if (!rec || typeof rec !== "object") return 0;
						const bucket = (groupBy === "model" ? rec.byModel : rec.byWorkspace) || {};
						const hit = bucket[g.key];
						return metric === "cost" ? (Number(hit && hit.cost) || 0) : (Number(hit && hit.total) || 0);
					})
				}));
				const distTimeline = jsxs("div", { style: { marginTop: "14px" }, children: [
					jsx("div", { style: { ...LABEL, marginBottom: "6px" }, children: (metric === "cost" ? "每日成本曲线" : "每日 Token 曲线") + "（" + (groupBy === "model" ? "按模型" : "按工作区") + "，" + dayKeys.length + " 天）" }),
					jsx(CurveChart, { days: dayKeys, series: distSeries, metric, fill: false })
				] });

				const shareBar = jsxs("div", { children: [
					jsxs("div", { style: { display: "flex", height: "12px", borderRadius: "6px", overflow: "hidden", gap: "2px", backgroundColor: "var(--dsw-alias-border-l1)" }, children: groupEntries.map((g, i) =>
						// flex-grow proportional to the chosen share field (tokens or cost).
						jsx("div", { style: { flex: (Number(g[shareBy]) || 0) + " 0 0", background: groupColor(g.key, i) }, title: g.key + " " + (shareMetric === "cost" ? ("¥" + fmtMoney(g.cost)) : fmt(g.total)) }, g.key)
					) }),
					jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "6px", marginTop: "10px" }, children: groupEntries.map((g, i) =>
						jsxs("div", { style: ROW, children: [
							jsxs("div", { style: { display: "flex", alignItems: "center", gap: "8px", minWidth: "0" }, children: [
								jsx("div", { style: { width: "10px", height: "10px", borderRadius: "2px", flexShrink: "0", background: groupColor(g.key, i) } }),
								jsx("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "240px", color: "var(--dsw-alias-label-primary)", fontSize: "13px" }, children: g.key })
							] }),
							jsxs("div", { style: { display: "flex", gap: "14px", color: "var(--dsw-alias-label-secondary)", ...MONO, fontSize: "13px", flexShrink: "0" }, children: [
								jsx("span", { children: (shareMetric === "cost" ? ("¥" + fmtMoney(g.cost)) : fmt(g.total)) }),
								jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)" }, children: pct((Number(g[shareBy]) || 0), groupSum).toFixed(0) + "%" })
							] })
						] }, g.key)
					) })
				] });

				// --- the distribution card's timeline owns every curve on this page. ---

				// Per-model cost split into the same three billing buckets as the totals.
				// Each bucket column carries its swatch so the table and the card above
				// agree on the colour code without a legend.
				const bucketTh = (label, color) => jsx("th", { style: { ...thR, whiteSpace: "nowrap" }, children: jsxs("span", { style: { display: "inline-flex", alignItems: "center", gap: "4px" }, children: [bucketDot(color), label] }) });
				const modelTable = jsxs("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: "13px" }, children: [
					jsxs("thead", { children: [jsxs("tr", { children: [
						jsx("th", { style: { ...thStyle, whiteSpace: "nowrap" }, children: "模型" }), jsx("th", { style: thR, children: "Req" }),
						bucketTh("命中输入", BUCKET.hit),
						bucketTh("未命中输入", BUCKET.miss),
						bucketTh("输出", BUCKET.out),
						jsx("th", { style: thR, children: "合计" })
					] })] }),
					jsxs("tbody", { children: modelRows.map((r) => jsxs("tr", { style: { borderTop: "1px solid var(--dsw-alias-border-l1)" }, children: [
						jsx("td", { style: { ...tdStyle, maxWidth: "190px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: r.key, children: r.key }),
						jsx("td", { style: tdR, children: r.req }),
						jsx("td", { style: tdR, title: fmt(r.cacheRead) + " tokens", children: "¥" + fmtMoney(r.costCacheHit || 0) }),
						jsx("td", { style: tdR, title: fmt(r.input) + " tokens", children: "¥" + fmtMoney(r.costCacheMiss || 0) }),
						jsx("td", { style: tdR, title: fmt(Number(r.output || 0) + Number(r.reasoning || 0)) + " tokens", children: "¥" + fmtMoney(r.costOutput || 0) }),
						jsx("td", { style: { ...tdR, color: "var(--dsw-alias-label-primary)", fontWeight: 600 }, children: "¥" + fmtMoney(r.cost || 0) })
					] }, r.key)) })
				] });

				return jsxs("div", { children: [
					jsxs("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "6px", flexWrap: "wrap" }, children: [
						jsx("h3", { style: { fontSize: "18px", fontWeight: 700, color: "var(--dsw-alias-label-primary)", marginBottom: "0" }, children: "用量看板" }),
						jsx(Seg, { options: [{ label: "近7天", value: 7 }, { label: "近30天", value: 30 }, { label: "全部", value: 0 }], value: days, onChange: (v) => { setDays(v); setLoading(true); } })
					] }),
					jsxs("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px", marginBottom: "4px" }, children: [
						jsx("button", { onClick: () => exportCsv(stats, metric), style: { ...btnStyle }, children: "导出 CSV" }),
						jsx("button", { onClick: () => exportJson(stats), style: { ...btnStyle }, children: "导出 JSON" })
					] }),
					(error) ? jsx("div", { style: { color: "var(--dsw-alias-danger, #e5484d)", fontSize: "12px", margin: "6px 0" }, children: "加载出错：" + error }) : null,

					// Balance
					jsxs("div", { style: CARD, children: [
						jsx("div", { style: SEC_TITLE, children: "账户余额（DeepSeek 官方）" }), balanceInner
					] }),

					// Token usage
					jsxs("div", { style: CARD, children: [
						jsx("div", { style: SEC_TITLE, children: "Token 使用量" }),
						statBar,
						// Cost broken into DeepSeek's three billing buckets. Cache-hit input is
						// the cheapest line by two orders of magnitude, so a lumped total hides
						// where the money actually goes. Four columns + one colour per bucket
						// keep the figures from running together.
						jsxs("div", { style: { marginTop: "12px", borderTop: "1px solid var(--dsw-alias-border-l1)", paddingTop: "8px" }, children: [
							jsx("div", { style: { ...LABEL, marginBottom: "4px" }, children: "成本构成" }),
							jsxs("div", { style: COST_GRID, children: [
								jsxs("span", { style: { display: "flex", alignItems: "center", gap: "6px", color: "var(--dsw-alias-label-secondary)" }, children: [bucketDot(BUCKET.hit), "缓存命中输入"] }),
								jsx("span", { style: { ...COST_R, color: "var(--dsw-alias-label-tertiary)" }, children: fmt(stats.cacheRead) }),
								jsx("span", { style: { ...COST_R, color: "var(--dsw-alias-label-tertiary)" }, children: (costTotal > 0 ? (Number(stats.costCacheHit) / costTotal * 100).toFixed(0) : "0") + "%" }),
								jsx("span", { style: { ...COST_R, color: "var(--dsw-alias-label-primary)" }, children: "¥" + fmtMoney(stats.costCacheHit) })
							] }),
							jsxs("div", { style: COST_GRID, children: [
								jsxs("span", { style: { display: "flex", alignItems: "center", gap: "6px", color: "var(--dsw-alias-label-secondary)" }, children: [bucketDot(BUCKET.miss), "缓存未命中输入"] }),
								jsx("span", { style: { ...COST_R, color: "var(--dsw-alias-label-tertiary)" }, children: fmt(stats.input) }),
								jsx("span", { style: { ...COST_R, color: "var(--dsw-alias-label-tertiary)" }, children: (costTotal > 0 ? (Number(stats.costCacheMiss) / costTotal * 100).toFixed(0) : "0") + "%" }),
								jsx("span", { style: { ...COST_R, color: "var(--dsw-alias-label-primary)" }, children: "¥" + fmtMoney(stats.costCacheMiss) })
							] }),
							jsxs("div", { style: COST_GRID, children: [
								jsxs("span", { style: { display: "flex", alignItems: "center", gap: "6px", color: "var(--dsw-alias-label-secondary)" }, children: [bucketDot(BUCKET.out), "输出"] }),
								jsx("span", { style: { ...COST_R, color: "var(--dsw-alias-label-tertiary)" }, children: fmt(Number(stats.output || 0) + Number(stats.reasoning || 0)) }),
								jsx("span", { style: { ...COST_R, color: "var(--dsw-alias-label-tertiary)" }, children: (costTotal > 0 ? (Number(stats.costOutput) / costTotal * 100).toFixed(0) : "0") + "%" }),
								jsx("span", { style: { ...COST_R, color: "var(--dsw-alias-label-primary)" }, children: "¥" + fmtMoney(stats.costOutput) })
							] }),
							jsxs("div", { style: { ...COST_GRID, marginTop: "4px", paddingTop: "7px", borderTop: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.10))", borderRadius: "4px", fontWeight: 600 }, children: [
								jsx("span", { style: { color: "var(--dsw-alias-label-primary)", paddingLeft: "2px" }, children: "合计" }),
								jsx("span", { style: { ...COST_R, color: "var(--dsw-alias-label-secondary)" }, children: fmt(total) }),
								jsx("span", { style: { ...COST_R, color: "var(--dsw-alias-label-tertiary)" }, children: "100%" }),
								jsx("span", { style: { ...COST_R, color: "var(--dsw-alias-label-primary)" }, children: "¥" + fmtMoney(stats.cost) })
							] }),
							jsx("div", { style: { ...LABEL, marginTop: "4px", textAlign: "right" }, children: "tokens　占比　金额" })
						] }),
						jsxs("div", { style: { ...ROW, marginTop: "4px" }, children: [
							jsx("span", { children: "今日花费 / 本月花费" }), jsx("span", { ...MONO, children: "¥" + fmtMoney(stats.todayCost) + " / ¥" + fmtMoney(stats.thisMonthCost) })
						] }),
						jsxs("div", { style: { ...ROW, marginTop: "6px", borderTop: "1px solid var(--dsw-alias-border-l1)", paddingTop: "6px" }, children: [
							jsx("span", { children: "请求数" }), jsx("span", { ...MONO, children: fmt(req) })
						] }),
						jsxs("div", { style: ROW, children: [
							jsx("span", { children: "缓存命中率（占输入）" }), jsx("span", { ...MONO, children: cacheRate + "%" })
						] }),
						jsxs("div", { style: ROW, children: [
							jsx("span", { children: "会话数" }), jsx("span", { ...MONO, children: Number(stats.sessions) || 0 })
						] })
					] }),

					// Grouped share
					jsxs("div", { style: CARD, children: [
						jsxs("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "8px" }, children: [
							jsx("div", { style: SEC_TITLE, children: "用量分布" }),
							jsx(Seg, { options: [{ label: "按模型", value: "model" }, { label: "按工作区", value: "workspace" }], value: groupBy, onChange: setGroupBy })
						] }),
						jsxs("div", { style: { display: "flex", justifyContent: "flex-end", marginBottom: "8px" }, children: [
							jsx(Seg, { options: [{ label: "按 Token", value: "total" }, { label: "按成本", value: "cost" }], value: shareMetric, onChange: (v) => { setShareMetric(v); setMetric(v === "cost" ? "cost" : "token"); } })
						] }),
						shareBar,
						distTimeline
					] }),

					// Activity heatmap (full year, no range switch)
					jsxs("div", { style: CARD, children: [
						jsx("div", { style: { ...SEC_TITLE, marginBottom: "10px" }, children: "活跃度（近一年）" }),
						heatChart
					] }),

					// Models table
					jsxs("div", { style: CARD, children: [
						jsx("div", { style: SEC_TITLE, children: "按模型" }),
						modelTable
					] }),

					// Recent sessions
					jsxs("div", { style: CARD, children: [
						jsx("div", { style: SEC_TITLE, children: "最近会话" }),
						sessionRows.length === 0
							? jsx("div", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", padding: "6px 0" }, children: "暂无数据" })
							: jsxs("div", { style: { display: "flex", flexDirection: "column" }, children: sessionRows.map((r) =>
								jsxs("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0", borderTop: "1px solid var(--dsw-alias-border-l1)" }, children: [
									jsxs("div", { style: { display: "flex", flexDirection: "column", minWidth: "0", flex: "1" }, children: [
										jsx("span", { style: { color: "var(--dsw-alias-label-primary)", fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: (r.model || "会话").slice(0, 40) + " · " + fmtDate(r.last) }),
										jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: r.id })
									] }),
									jsxs("div", { style: { display: "flex", gap: "14px", color: "var(--dsw-alias-label-secondary)", ...MONO, fontSize: "12px", flexShrink: "0" }, children: [
										jsx("span", { children: fmt(r.total) }),
										jsx("span", { style: { color: "var(--dsw-alias-label-primary)", fontWeight: 600 }, children: "¥" + fmtMoney(r.cost) })
									] })
								] }, r.id)
							) })
					] })
				] });
			}

			// loading / no data -> simple spinner-ish text
			return jsxs("div", { children: [
				jsx("h3", { style: { fontSize: "18px", fontWeight: 700, color: "var(--dsw-alias-label-primary)", marginBottom: "12px" }, children: "用量看板" }),
				(error) ? jsx("div", { style: { color: "var(--dsw-alias-danger, #e5484d)", fontSize: "12px", margin: "6px 0" }, children: "加载出错：" + error }) : null,
				jsx("div", { style: { color: "var(--dsw-alias-label-secondary)", padding: "8px 0" }, children: "加载中…" })
			] });
		}

		const thStyle = { textAlign: "left", padding: "8px 6px", color: "var(--dsw-alias-label-tertiary)", fontWeight: 500, fontSize: "12px" };
		const thR = { textAlign: "right", padding: "8px 6px", color: "var(--dsw-alias-label-tertiary)", fontWeight: 500, fontSize: "12px", ...MONO };
		const tdStyle = { padding: "8px 6px", color: "var(--dsw-alias-label-primary)" };
		const tdR = { textAlign: "right", padding: "8px 6px", color: "var(--dsw-alias-label-secondary)", ...MONO };

		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{
					name: "settings.section",
					id: "token-dashboard",
					order: 30,
					label: () => {
						try {
							const bound = ctx.locale && typeof ctx.locale.bind === "function" && ctx.locale.bind("token-dashboard");
							const v = bound && typeof bound === "function" ? bound("title") : null;
							return (typeof v === "string" && v !== "title") ? v : "用量看板";
						} catch {
							return "用量看板";
						}
					},
					inject: () => ({})
				},
				(props) => jsx(Boundary, { children: jsx(TokenDashboardPanel, props) })
			));
		}

		exports.apply = apply;
		exports.inject = ["slots", "locale"];
		exports.TokenDashboardPanel = TokenDashboardPanel;
		exports.Boundary = Boundary;
		exports.fmt = fmt;
		exports.fmtMoney = fmtMoney;

		return module.exports;
	}
});
