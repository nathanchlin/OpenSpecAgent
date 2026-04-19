// server/core/logger.js
// 简易日志工具 — debug 级别受 DEBUG 环境变量控制

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

function debug(...args) {
  if (DEBUG) console.log(...args);
}

function error(...args) {
  console.error(...args);
}

function info(...args) {
  console.log(...args);
}

module.exports = { debug, error, info };
