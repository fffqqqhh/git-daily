'use strict';

function isNewVersion(previous, current) {
  if (!previous) return true;
  const parse = value => /^(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number);
  const before = parse(previous), after = parse(current);
  if (!before || !after) return previous !== current;
  for (let index = 0; index < 3; index++) {
    if (after[index] !== before[index]) return after[index] > before[index];
  }
  return false;
}

function registerReleaseNotes(vscode, context, output) {
  const version = context.extension.packageJSON.version;
  const show = async () => {
    let uri = vscode.Uri.joinPath(context.extensionUri, 'CHANGELOG.md');
    try { await vscode.workspace.fs.stat(uri); }
    catch (error) {
      if (error.code !== 'FileNotFound' && error.code !== 'ENOENT') throw error;
      // vsce normalizes the packaged changelog filename to lowercase.
      uri = vscode.Uri.joinPath(context.extensionUri, 'changelog.md');
    }
    return vscode.commands.executeCommand('markdown.showPreview', uri);
  };
  let showing = false;
  let disposed = false;
  async function showAfterUpdate() {
    if (disposed || showing || !vscode.window.state.focused || !isNewVersion(context.globalState.get('releaseNotesVersion'), version)) return;
    showing = true;
    try {
      await show();
      await context.globalState.update('releaseNotesVersion', version);
    } catch (error) { output.appendLine(`打开更新说明失败：${error.message}`); }
    finally { showing = false; }
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('gitDaily.showReleaseNotes', show),
    vscode.window.onDidChangeWindowState(state => { if (state.focused) void showAfterUpdate(); }),
    { dispose() { disposed = true; } }
  );
  void showAfterUpdate();
}

module.exports = { registerReleaseNotes, isNewVersion };
