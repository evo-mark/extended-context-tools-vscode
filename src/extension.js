import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";

export function activate(context) {
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(
			CLIPBOARD_SCHEME,
			clipboardProvider,
		),
		vscode.commands.registerCommand(
			"extendedContextTools.duplicate",
			(uri, uris) => run(uri, uris, duplicate),
		),
		vscode.commands.registerCommand(
			"extendedContextTools.fileInfo",
			(uri, uris) => run(uri, uris, showInfo),
		),
		vscode.commands.registerCommand(
			"extendedContextTools.copyPath",
			(uri, uris) => runAll(uri, uris, copyPath),
		),
		vscode.commands.registerCommand(
			"extendedContextTools.compareWith",
			(uri, uris) => runAll(uri, uris, compareWith),
		),
		vscode.commands.registerCommand(
			"extendedContextTools.renameCase",
			(uri, uris) => runAll(uri, uris, renameCase),
		),
	);
}

/**
 * Explorer passes (clickedUri, allSelectedUris). From the command palette
 * nothing is passed, so fall back to the active editor's file.
 */
function getTargets(uri, uris) {
	let targets = Array.isArray(uris) && uris.length ? uris : uri ? [uri] : [];
	if (!targets.length && vscode.window.activeTextEditor) {
		targets = [vscode.window.activeTextEditor.document.uri];
	}
	targets = targets.filter((u) => u.scheme === "file");
	if (!targets.length) {
		vscode.window.showWarningMessage(
			"Select a file or folder in the Explorer first.",
		);
	}
	return targets;
}

/** Runs the action once per selected item. */
async function run(uri, uris, action) {
	for (const target of getTargets(uri, uris)) {
		try {
			await action(target);
		} catch (err) {
			vscode.window.showErrorMessage(
				`${path.basename(target.fsPath)}: ${err.message}`,
			);
		}
	}
}

/** Runs the action once with every selected item (for one prompt covering all). */
async function runAll(uri, uris, action) {
	const targets = getTargets(uri, uris);
	if (!targets.length) return;
	try {
		await action(targets);
	} catch (err) {
		vscode.window.showErrorMessage(err.message);
	}
}

// ---------------------------------------------------------------- Duplicate

async function exists(p) {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

/** "file.txt" -> "file copy.txt", then "file copy 2.txt", ... */
async function suggestName(source, isDir) {
	const dir = path.dirname(source);
	const ext = isDir ? "" : path.extname(source);
	const base = path.basename(source, ext);
	for (let i = 1; ; i++) {
		const name = `${base} copy${i > 1 ? " " + i : ""}${ext}`;
		if (!(await exists(path.join(dir, name)))) return name;
	}
}

async function duplicate(uri) {
	const source = uri.fsPath;
	const stat = await fs.stat(source);
	const isDir = stat.isDirectory();
	const dir = path.dirname(source);
	const suggested = await suggestName(source, isDir);
	const ext = isDir ? "" : path.extname(suggested);

	const name = await vscode.window.showInputBox({
		title: `Duplicate ${path.basename(source)}`,
		prompt: "Name for the copy",
		value: suggested,
		// Pre-select the name without the extension, like Rename does.
		valueSelection: [0, suggested.length - ext.length],
		validateInput: async (value) => {
			const v = value.trim();
			if (!v) return "Name cannot be empty.";
			if (/[\\/]/.test(v)) return "Name cannot contain slashes.";
			if (await exists(path.join(dir, v)))
				return `"${v}" already exists.`;
			return null;
		},
	});
	if (!name) return;

	const target = vscode.Uri.file(path.join(dir, name.trim()));
	await vscode.workspace.fs.copy(uri, target, { overwrite: false });

	if (!isDir) {
		await vscode.commands.executeCommand("vscode.open", target);
	}
	await vscode.commands.executeCommand("revealInExplorer", target);
}

// ---------------------------------------------------------------- File Info

function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let n = bytes;
	let i = -1;
	do {
		n /= 1024;
		i++;
	} while (n >= 1024 && i < units.length - 1);
	return `${n.toFixed(n < 10 ? 2 : 1)} ${units[i]} (${bytes.toLocaleString()} bytes)`;
}

function formatDate(d) {
	return d.toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "medium",
	});
}

function formatMode(mode) {
	const chars = "rwxrwxrwx";
	let out = "";
	for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? chars[i] : "-";
	return `${out} (${(mode & 0o777).toString(8)})`;
}

/** Resolves owner and group names via `ls -ld`, falling back to raw uid/gid. */
function ownership(file, stat) {
	return new Promise((resolve) => {
		execFile("ls", ["-ld", "--", file], (err, stdout) => {
			const [, , owner, group] = err ? [] : stdout.trim().split(/\s+/);
			resolve({
				owner: owner ? `${owner} (${stat.uid})` : String(stat.uid),
				group: group ? `${group} (${stat.gid})` : String(stat.gid),
			});
		});
	});
}

/** Recursively count files/folders and total size. Skips symlinks. */
async function folderStats(dir, acc = { files: 0, folders: 0, size: 0 }) {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			acc.folders++;
			await folderStats(full, acc);
		} else if (entry.isFile()) {
			acc.files++;
			acc.size += (await fs.stat(full)).size;
		}
	}
	return acc;
}

/** Returns line count, or null if the file looks binary or is too large. */
async function countLines(file, size) {
	if (size > 50 * 1024 * 1024) return null;
	const buf = await fs.readFile(file);
	if (buf.subarray(0, 8000).includes(0)) return null;
	if (buf.length === 0) return 0;
	let lines = 1;
	for (const byte of buf) if (byte === 10) lines++;
	if (buf[buf.length - 1] === 10) lines--;
	return lines;
}

async function showInfo(uri) {
	const file = uri.fsPath;
	const stat = await fs.lstat(file);
	const isDir = stat.isDirectory();
	const rel = vscode.workspace.asRelativePath(uri, false);

	const rows = [
		[
			"Type",
			stat.isSymbolicLink()
				? "Symbolic link"
				: isDir
					? "Folder"
					: `File${path.extname(file) ? ` (${path.extname(file)})` : ""}`,
		],
		["Path", file],
	];
	if (rel !== file) rows.push(["Relative path", rel]);

	if (isDir) {
		const s = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Window,
				title: "Calculating folder size…",
			},
			() => folderStats(file),
		);
		rows.push([
			"Contents",
			`${s.files.toLocaleString()} files, ${s.folders.toLocaleString()} folders`,
		]);
		rows.push(["Total size", formatBytes(s.size)]);
	} else {
		rows.push(["Size", formatBytes(stat.size)]);
		const lines = await countLines(file, stat.size);
		if (lines !== null) rows.push(["Lines", lines.toLocaleString()]);
	}

	rows.push(["Created", formatDate(stat.birthtime)]);
	rows.push(["Modified", formatDate(stat.mtime)]);
	rows.push(["Accessed", formatDate(stat.atime)]);
	if (process.platform !== "win32") {
		const { owner, group } = await ownership(file, stat);
		rows.push(["Owner", owner]);
		rows.push(["Group", group]);
		rows.push(["Permissions", formatMode(stat.mode)]);
	}

	const name = path.basename(file);
	const detail = rows.map(([k, v]) => `${k}: ${v}`).join("\n");
	const panel = vscode.window.createWebviewPanel(
		"extendedContextTools.fileInfo",
		`Info: ${name}`,
		vscode.ViewColumn.Active,
		{ enableScripts: true },
	);
	panel.webview.html = infoHtml(name, rows);
	panel.webview.onDidReceiveMessage(async (msg) => {
		if (msg === "copyPath") await vscode.env.clipboard.writeText(file);
		else if (msg === "copyInfo")
			await vscode.env.clipboard.writeText(`${name}\n${detail}`);
		else return;
		vscode.window.setStatusBarMessage(
			msg === "copyPath" ? "Path copied" : "File info copied",
			2000,
		);
	});
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function infoHtml(name, rows) {
	const nonce = Math.random().toString(36).slice(2);
	const body = rows
		.map(
			([k, v]) =>
				`<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`,
		)
		.join("");
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 16px 24px; }
    h2 { font-weight: 600; margin: 0 0 12px; word-break: break-all; }
    table { border-collapse: collapse; }
    th, td { text-align: left; padding: 4px 16px 4px 0; vertical-align: top; }
    th { font-weight: normal; color: var(--vscode-descriptionForeground); white-space: nowrap; }
    td { white-space: nowrap; user-select: text; font-family: var(--vscode-editor-font-family); }
    .actions { margin-top: 16px; display: flex; gap: 8px; }
    button { font: inherit; padding: 4px 12px; border: none; border-radius: 2px; cursor: pointer;
        color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head>
<body>
<h2>${escapeHtml(name)}</h2>
<table>${body}</table>
<div class="actions">
    <button data-msg="copyPath">Copy Path</button>
    <button data-msg="copyInfo" class="secondary">Copy Info</button>
</div>
<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    for (const b of document.querySelectorAll('button')) b.onclick = () => vscode.postMessage(b.dataset.msg);
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------- Copy Path

/** Path of `target` relative to the open file, written like an import (./foo/bar.js). */
function relativeToActive(target) {
	const active = vscode.window.activeTextEditor?.document.uri;
	if (!active || active.scheme !== "file") return null;
	let rel = path
		.relative(path.dirname(active.fsPath), target.fsPath)
		.split(path.sep)
		.join("/");
	if (!rel.startsWith(".")) rel = "./" + rel;
	return rel;
}

const PATH_FORMATS = [
	{
		label: "Relative Path",
		get: (u) => vscode.workspace.asRelativePath(u, false),
	},
	{ label: "Absolute Path", get: (u) => u.fsPath },
	{ label: "File Name", get: (u) => path.basename(u.fsPath) },
	{
		label: "File Name Without Extension",
		get: (u) => splitName(path.basename(u.fsPath)).stem,
	},
	{ label: "Containing Folder Path", get: (u) => path.dirname(u.fsPath) },
	{ label: "Relative to Open File", get: relativeToActive },
	{ label: "File URI", get: (u) => u.toString() },
];

async function copyPath(targets) {
	const items = PATH_FORMATS.map((f) => ({
		...f,
		description: f.get(targets[0]) ?? "",
	})).filter((item) => item.description);
	const pick = await vscode.window.showQuickPick(items, {
		title:
			targets.length > 1
				? `Copy ${targets.length} paths as…`
				: "Copy path as…",
		matchOnDescription: true,
	});
	if (!pick) return;
	const text = targets.map((u) => pick.get(u) ?? u.fsPath).join("\n");
	await vscode.env.clipboard.writeText(text);
	vscode.window.setStatusBarMessage(
		`Copied: ${text.split("\n")[0]}${targets.length > 1 ? ` (+${targets.length - 1} more)` : ""}`,
		3000,
	);
}

// ---------------------------------------------------------------- Compare With

const CLIPBOARD_SCHEME = "extended-context-tools-clipboard";
let clipboardSnapshot = "";

const clipboardProvider = {
	provideTextDocumentContent: () => clipboardSnapshot,
};

async function diff(left, right) {
	const title = `${path.basename(left.fsPath || left.path)} ↔ ${path.basename(right.fsPath || right.path)}`;
	await vscode.commands.executeCommand("vscode.diff", left, right, title);
}

async function compareWith(targets) {
	for (const t of targets) {
		if ((await fs.stat(t.fsPath)).isDirectory()) {
			throw new Error("Compare works on files, not folders.");
		}
	}
	if (targets.length === 2) return diff(targets[0], targets[1]);
	if (targets.length > 2)
		throw new Error("Select one file, or exactly two files to compare.");

	const source = targets[0];
	const active = vscode.window.activeTextEditor?.document.uri;
	const special = [];
	if (active && active.toString() !== source.toString()) {
		special.push({
			label: "$(file) Open File",
			description: vscode.workspace.asRelativePath(active),
			uri: active,
		});
	}
	special.push({
		label: "$(clippy) Clipboard",
		description: "Compare with clipboard contents",
		clipboard: true,
	});
	special.push({
		label: "$(folder-opened) Browse…",
		description: "Pick a file from disk",
		browse: true,
	});

	const quickPick = vscode.window.createQuickPick();
	quickPick.title = `Compare ${path.basename(source.fsPath)} with…`;
	quickPick.placeholder = "Type to search workspace files";
	quickPick.matchOnDescription = true;
	quickPick.busy = true;
	quickPick.items = special;
	quickPick.show();

	vscode.workspace
		.findFiles("**/*", "**/{node_modules,vendor,.git}/**", 20000)
		.then((files) => {
			const fileItems = files
				.filter((f) => f.toString() !== source.toString())
				.map((f) => {
					const rel = vscode.workspace.asRelativePath(f);
					return {
						label: path.basename(f.fsPath),
						description: rel,
						uri: f,
					};
				})
				.sort((a, b) => a.description.localeCompare(b.description));
			quickPick.items = [
				...special,
				{
					label: "Workspace Files",
					kind: vscode.QuickPickItemKind.Separator,
				},
				...fileItems,
			];
			quickPick.busy = false;
		});

	const pick = await new Promise((resolve) => {
		quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0]));
		quickPick.onDidHide(() => resolve(undefined));
	});
	quickPick.dispose();
	if (!pick) return;

	if (pick.clipboard) {
		clipboardSnapshot = await vscode.env.clipboard.readText();
		// Unique query so VSCodium doesn't reuse a cached copy of an old clipboard.
		const clip = vscode.Uri.from({
			scheme: CLIPBOARD_SCHEME,
			path: "/Clipboard",
			query: String(Date.now()),
		});
		return diff(source, clip);
	}
	if (pick.browse) {
		const chosen = await vscode.window.showOpenDialog({
			canSelectMany: false,
			defaultUri: vscode.Uri.file(path.dirname(source.fsPath)),
			openLabel: "Compare",
		});
		if (chosen?.[0]) return diff(source, chosen[0]);
		return;
	}
	return diff(source, pick.uri);
}

// ---------------------------------------------------------------- Rename Case

/** Splits "my-file.test.ts" into stem "my-file" and extension ".test.ts", keeping leading dots. */
function splitName(name, isDir = false) {
	const lead = name.match(/^\.*/)[0];
	const rest = name.slice(lead.length);
	const dot = isDir ? -1 : rest.indexOf(".");
	return dot > 0
		? { lead, stem: rest.slice(0, dot), ext: rest.slice(dot) }
		: { lead, stem: rest, ext: "" };
}

function words(stem) {
	return stem
		.replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
		.replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
}

const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

const CASES = [
	{
		label: "camelCase",
		fn: (w) => w.map((x, i) => (i ? cap(x) : x.toLowerCase())).join(""),
	},
	{ label: "PascalCase", fn: (w) => w.map(cap).join("") },
	{ label: "kebab-case", fn: (w) => w.map((x) => x.toLowerCase()).join("-") },
	{ label: "snake_case", fn: (w) => w.map((x) => x.toLowerCase()).join("_") },
	{
		label: "SCREAMING_SNAKE_CASE",
		fn: (w) => w.map((x) => x.toUpperCase()).join("_"),
	},
	{ label: "Title Case", fn: (w) => w.map(cap).join(" ") },
	{ label: "lowercase", fn: (w, stem) => stem.toLowerCase() },
	{ label: "UPPERCASE", fn: (w, stem) => stem.toUpperCase() },
];

async function renameCase(targets) {
	const entries = [];
	for (const uri of targets) {
		const isDir = (await fs.stat(uri.fsPath)).isDirectory();
		entries.push({ uri, ...splitName(path.basename(uri.fsPath), isDir) });
	}
	const rename = (e, c) => e.lead + c.fn(words(e.stem), e.stem) + e.ext;

	const pick = await vscode.window.showQuickPick(
		CASES.map((c) => ({ ...c, description: rename(entries[0], c) })),
		{
			title:
				targets.length > 1
					? `Change case of ${targets.length} names`
					: `Change case of ${path.basename(targets[0].fsPath)}`,
		},
	);
	if (!pick) return;

	const edit = new vscode.WorkspaceEdit();
	const problems = [];
	for (const e of entries) {
		const oldName = path.basename(e.uri.fsPath);
		const newName = rename(e, pick);
		if (newName === oldName) continue;
		if (!words(e.stem).length) {
			problems.push(`${oldName}: nothing to convert`);
			continue;
		}
		const target = vscode.Uri.file(
			path.join(path.dirname(e.uri.fsPath), newName),
		);
		// A case-only rename "exists" on case-insensitive disks (macOS), which is fine.
		if (
			newName.toLowerCase() !== oldName.toLowerCase() &&
			(await exists(target.fsPath))
		) {
			problems.push(`${oldName}: "${newName}" already exists`);
			continue;
		}
		edit.renameFile(e.uri, target);
	}
	if (edit.size) await vscode.workspace.applyEdit(edit);
	if (problems.length)
		vscode.window.showWarningMessage(
			`Some items were not renamed: ${problems.join("; ")}`,
		);
}

export function deactivate() {}
