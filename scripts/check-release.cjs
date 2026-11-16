'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const version = require(path.join(root, 'package.json')).version;
const notes = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const section = notes.split(/^## /m).find(section => section.split(/\r?\n/)[0].trim() === version);
if (!section || !/^[-*] .+$/m.test(section)) {
  throw new Error(`发布 ${version} 前，请在 CHANGELOG.md 中添加对应版本的更新内容。`);
}
console.log(`已验证 ${version} 更新说明。`);
