import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(appDir, "index.html"), "utf8");
const main = readFileSync(resolve(appDir, "src/main.ts"), "utf8");
const sourceControl = readFileSync(resolve(appDir, "src/source-control.ts"), "utf8");
const rust = readFileSync(resolve(appDir, "src-tauri/src/lib.rs"), "utf8");

test("the existing Source Control button opens a real side pane", () => {
  assert.match(html, /data-view="source-control"/);
  assert.match(html, /<aside id="source-control-pane" class="side-pane hidden"/);
  assert.match(main, /import \{ initSourceControl, openSourceControl \} from "\.\/source-control"/);
  assert.match(main, /case "source-control":\s*void guard\(openSourceControl\)/);
  assert.match(main, /initSourceControl\(\);/);
  assert.match(main, /view\.source-control/);
});

test("the pane exposes the full local Git workflow", () => {
  for (const id of [
    "sc-branch", "sc-sync", "sc-refresh", "sc-stage-all", "sc-unstage-all",
    "sc-message", "sc-commit", "sc-conflicts", "sc-staged", "sc-changes",
    "sc-history", "sc-diff-text", "sc-init",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="sc-fetch"/);
  assert.match(html, /id="sc-pull"/);
  assert.match(html, /id="sc-push"/);
  assert.match(sourceControl, /git_stage/);
  assert.match(sourceControl, /git_unstage/);
  assert.match(sourceControl, /git_commit/);
  assert.match(sourceControl, /git_diff/);
  assert.match(sourceControl, /git_file_preview/);
});

test("remote sync is explicit and never automatic", () => {
  assert.match(sourceControl, /el\("sc-fetch"\)\.addEventListener\("click"/);
  assert.match(sourceControl, /el\("sc-pull"\)\.addEventListener\("click"/);
  assert.match(sourceControl, /el\("sc-push"\)\.addEventListener\("click"/);
  assert.doesNotMatch(sourceControl, /setInterval\(/);
  assert.match(rust, /GIT_TERMINAL_PROMPT/, "Git prompts are disabled so sync cannot hang");
  assert.match(sourceControl, /configure a Git credential helper or SSH key/);
});

test("Rust exposes branch, history, and remote commands beyond staging", () => {
  for (const command of [
    "git_repo_info", "git_branches", "git_checkout", "git_remotes",
    "git_fetch", "git_pull", "git_push", "git_log", "git_commit_diff",
    "git_discard", "git_ignore", "git_init", "git_file_preview",
  ]) {
    assert.match(rust, new RegExp(`async fn ${command}\\(`));
    assert.match(rust, new RegExp(`^\\s+${command},$`, "m"));
  }
});

test("porcelain parsing keeps both index and worktree states", () => {
  assert.match(rust, /fn parse_git_status\(bytes: &\[u8\]\)/);
  assert.match(rust, /--porcelain=v1/);
  assert.match(rust, /\.arg\("-z"\)/);
  assert.match(rust, /git_porcelain_status_keeps_staged_and_unstaged_sides/);
  assert.match(rust, /git_log_parser_reads_commit_fields/);
});

test("paths are confined to the repository and refs are validated", () => {
  assert.match(rust, /fn relative_git_path\(path: &str\)/);
  assert.match(rust, /fn contained_git_file_in\(base_dir: &Path, path: &str\)/);
  assert.match(rust, /fn git_toplevel\(root: &str\)/);
  assert.match(rust, /Path escapes the repository folder/);
  assert.match(rust, /git_paths_and_refs_reject_escapes/);
});
