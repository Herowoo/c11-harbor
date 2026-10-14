import { statSync, readFileSync } from 'node:fs';
import { ProtocolError } from './protocol.mjs';

export function readSessionFile(path) {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 32000 || stat.size === 0) throw new Error('size');
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new ProtocolError('找不到有效登录文件；请上传 c11-nas-session.json 到 NAS 项目的 import 文件夹', 'INPUT');
  }
}
