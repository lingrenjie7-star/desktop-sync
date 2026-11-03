/**
 * 模拟 WorkBuddy 的模块联邦宿主，验证 remoteEntry.js 的契约。
 *
 * 我们不能真的重启 WorkBuddy 去装扩展（会打断用户正在用的东西），
 * 但可以在 Node 里复现宿主的加载流程：
 *   deriveFederationTuple → registerRemotes → loadRemote('id/Main')
 * 这能抓到 remoteEntry 里最致命的错误（没有 get/init、暴露名不对、顶层副作用崩）。
 *
 * 用 jsdom 太重，这里手搓一个最小 DOM + 模块系统。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', 'dist', 'workbuddy', 'dshwb-sync');
const ENTRY = path.join(PKG, 'ui', 'assets', 'remoteEntry.js');

let pass = 0;
const failures = [];
const check = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
};

const code = fs.readFileSync(ENTRY, 'utf8');

// ── 最小 DOM
function makeDom() {
  const nodes = [];
  const document = {
    head: {
      appendChild(node) {
        nodes.push(node);
        return node;
      },
    },
    getElementById: (id) => nodes.find((n) => n.id === id) ?? null,
    createElement(tag) {
      return { tag, id: '', textContent: '', className: '' };
    },
  };
  return { document, nodes };
}

// ── 最小 React（只要 createElement 和 hooks 形状）
function makeReact() {
  const createElement = (type, props, ...children) => ({ type, props, children });
  const useState = (initial) => [typeof initial === 'function' ? initial() : initial, () => {}];
  const useMemo = (fn) => fn();
  const useCallback = (fn) => fn;
  const useRef = (v) => ({ current: v });
  const useEffect = () => {};
  return { createElement, useState, useMemo, useCallback, useRef, useEffect, version: '18.3.1' };
}

/** 在沙箱里执行 remoteEntry，返回它注册的结果。 */
function runRemoteEntry() {
  const { document, nodes } = makeDom();
  const React = makeReact();

  let registered = null;
  let registrationArgs = null;

  const sandbox = {
    window: null,
    document,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: false, status: 0, json: async () => ({}) }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.React = React;
  // WorkBuddy 宿主提供的联邦注册入口
  sandbox.register = (container, scope) => {
    registered = container;
    registrationArgs = { scope };
  };

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'remoteEntry.js' });
  return { sandbox, registered, registrationArgs, nodes };
}

console.log('联邦容器契约');

const run = runRemoteEntry();

await check('执行不抛异常，且没有未捕获错误', () => {
  assert.ok(run.sandbox, '沙箱没有建立');
});

await check('调用了宿主注册入口（register / __federation_register__）', () => {
  assert.ok(run.registered, '没有调用 register —— 宿主将加载不到这个扩展');
});

await check('注册对象有 get 和 init 两个方法', () => {
  assert.equal(typeof run.registered.get, 'function', '缺少 get()');
  assert.equal(typeof run.registered.init, 'function', '缺少 init()');
});

console.log('模块暴露');

const container = run.registered;

await check('init(shareScope) 不抛异常', async () => {
  await container.init({ default: { react: { get: () => makeReact(), loaded: true } } });
});

await check("暴露 './Main' 且返回一个 React 组件", async () => {
  const Main = await container.get('./Main');
  assert.ok(Main, './Main 返回空');
  assert.equal(typeof Main, 'function', `./Main 应该是组件函数，实际是 ${typeof Main}`);
});

await check('拒绝未知模块名（暴露面最小化）', async () => {
  await assert.rejects(() => container.get('./NotMain'), /Main|只暴露/);
});

await check("'Main'（不带 ./）也能取到，容错宿主写法差异", async () => {
  const Main = await container.get('Main');
  assert.equal(typeof Main, 'function');
});

console.log('挂载与渲染');

await check('组件能被调用并产出元素树（不崩）', async () => {
  const Main = await container.get('./Main');
  // 面板在没有连上后台服务时应该渲染「连接表单」，而不是抛错
  const tree = Main({});
  assert.ok(tree, '组件返回空');
  assert.ok(tree.type, '返回值不是 React 元素');
});

await check('注入了样式节点，且带固定色板（不依赖宿主主题）', () => {
  const styleNode = run.nodes.find((n) => n.id === 'dshwb-panel-styles');
  assert.ok(styleNode, '没有注入样式');
  const css = String(styleNode.textContent);
  assert.ok(css.includes('.dshwb-root'), '样式内容不对');
  // 关键回归：早先写成 var(--dsh-text, ...)，宿主换浅色主题后文字看不见
  assert.ok(css.includes('--dwb-text'), '缺少固定色板');
  assert.ok(!/var\(--dsh-/.test(css), '不应再依赖 host 的 --dsh-* 变量');
});

await check('没有把 React 打进自己的 bundle（必须用宿主共享的）', () => {
  // 粗略但有效的信号：自己的 bundle 里不该有 React 的源码特征
  assert.ok(!code.includes('react.production.min.js'), 'bundle 里打包了 React');
  assert.ok(!code.includes('Symbol.for("react.element")'), 'bundle 里打包了 React 运行时');
});

console.log(failures.length === 0 ? `\n${pass} 项通过` : `\n${pass} 项通过，${failures.length} 项失败`);
process.exitCode = failures.length === 0 ? 0 : 1;
